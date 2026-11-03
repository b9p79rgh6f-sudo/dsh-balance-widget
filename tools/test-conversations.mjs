/**
 * 离线校验：用磁盘上真实的挂件缓存和会话日志，重算“今天各对话花费”，
 * 检查子代理是否并进父对话、花费合计是否与当天总量一致、排序是否正确。
 *
 * 这个脚本只读缓存和日志，不启动 DSH，也不改挂件的数据。
 * 会话标题等元数据由 Python 侧的 build-conversation-fixture.py 生成，
 * 因为会话日志是多段 zstd 帧，Node 内置 zstd 只解第一段。
 *
 *   node tools/test-conversations.mjs [YYYY-MM-DD]
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildConversationRows } from '../index.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CACHE_PATH = join(DSH_HOME, 'storages', 'balance-widget-cache.json')
const HERE = dirname(fileURLToPath(import.meta.url))

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function todayKey() {
  return DAY_FORMATTER.format(new Date())
}

function cacheOf() {
  const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  if (parsed === null || typeof parsed.sessions !== 'object') {
    throw new Error('缓存格式不对')
  }
  return parsed
}

function metadataOf(day) {
  const fixture = join(tmpdir(), `dsh-balance-widget-${day}-${process.pid}.json`)
  const python = process.env.PYTHON || 'python'
  const built = spawnSync(python, [join(HERE, 'build-conversation-fixture.py'), day, fixture], {
    encoding: 'utf8',
  })
  if (built.status !== 0) {
    throw new Error(`生成测试数据失败：${built.stderr || built.stdout}`)
  }
  const parsed = JSON.parse(readFileSync(fixture, 'utf8'))
  return parsed.meta ?? {}
}

function bucketsCostOf(cache, day) {
  let total = 0
  for (const entry of Object.values(cache.sessions)) {
    const buckets = entry?.days?.[day]
    if (buckets === undefined) continue
    total += Number(buckets.costCNY) || 0
  }
  return total
}

function main() {
  const day = process.argv[2] || todayKey()
  const cache = cacheOf()
  const meta = metadataOf(day)

  let enriched = 0
  for (const [sessionId, entry] of Object.entries(cache.sessions)) {
    if (meta[sessionId] === undefined) continue
    Object.assign(entry, meta[sessionId])
    enriched += 1
  }

  const expectedCost = bucketsCostOf(cache, day)
  const rows = buildConversationRows(cache, day)

  console.log(`日期 ${day}`)
  console.log(`缓存里的会话 ${Object.keys(cache.sessions).length} 个，当天有用量的补上元数据 ${enriched} 个`)
  console.log(`当天花费合计 ¥${expectedCost.toFixed(4)}，合并后 ${rows.length} 个对话`)
  console.log('')

  for (const row of rows) {
    const flag = row.subagentCount > 0 ? `（含 ${row.subagentCount} 个子代理）` : ''
    console.log(`  ¥${row.costCNY.toFixed(3).padStart(8)}  ${row.title}${flag}`)
    for (const subagent of row.subagents) {
      console.log(`             ↳ ¥${subagent.costCNY.toFixed(3)}  ${subagent.title}`)
    }
  }

  const failures = []
  const sumCost = rows.reduce((sum, row) => sum + row.costCNY, 0)
  if (Math.abs(sumCost - expectedCost) > 1e-4) {
    failures.push(`对话花费合计 ${sumCost} 与当天总量 ${expectedCost} 不一致`)
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].costCNY < rows[index].costCNY) {
      failures.push('对话没有按花费从高到低排序')
      break
    }
  }
  for (const row of rows) {
    if (row.subagentCount !== row.subagents.length) failures.push(`子代理数量字段不一致: ${row.id}`)
    if (typeof row.title !== 'string' || row.title === '') failures.push(`标题为空: ${row.id}`)
    const childCost = row.subagents.reduce((sum, item) => sum + item.costCNY, 0)
    if (childCost > row.costCNY + 1e-9) failures.push(`子代理花费超过父对话: ${row.id}`)
  }
  const titled = rows.filter((row) => row.untitled !== true).length
  console.log('')
  console.log(`拿到真标题的对话 ${titled} 个，用临时名字的 ${rows.length - titled} 个`)

  if (failures.length > 0) {
    for (const failure of failures) console.error(`失败: ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('全部检查通过：合计一致，排序正确，子代理已并入父对话。')
}

main()
