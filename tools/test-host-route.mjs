/**
 * 宿主路由的离线联调：不启动 DSH，用一个假的宿主上下文把 index.js 的 apply()
 * 跑起来，喂给它真实的挂件缓存和真实会话标题，然后直接调用汇总路由，
 * 检查返回的“今日各对话花费”是否正确。
 *
 * 这一步能提前发现宿主代码在运行期才会暴露的错误（字段名写错、服务调用姿势
 * 不对、JSON 序列化失败之类），避免重启 DSH 时把整个界面弄挂。
 *
 *   node tools/test-host-route.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentTariff } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const day = process.argv[2] || DAY_FORMATTER.format(new Date())

function loadFixture() {
  const fixture = join(tmpdir(), `balance-widget-host-${process.pid}.json`)
  const python = process.env.PYTHON || 'python'
  const built = spawnSync(python, [join(HERE, 'build-conversation-fixture.py'), day, fixture], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: REAL_DSH_HOME },
  })
  if (built.status !== 0) throw new Error(`生成测试数据失败：${built.stderr || built.stdout}`)
  return JSON.parse(readFileSync(fixture, 'utf8')).meta ?? {}
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body += String(chunk ?? '')
    },
  }
}

function buildRequest(remoteAddress = '127.0.0.1') {
  return {
    method: 'GET',
    url: '/api/balance-widget/summary?v=0.2.0&l=zh-CN&t=28800',
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:51268' },
  }
}

function checkTariffTimes() {
  const cases = [
    ['2026-11-03T10:00:00+08:00', true, '2026-11-03T12:00:00+08:00'],
    ['2026-11-03T12:30:00+08:00', false, '2026-11-03T14:00:00+08:00'],
    ['2026-11-06T19:00:00+08:00', false, '2026-11-09T09:00:00+08:00'],
    ['2026-11-07T10:00:00+08:00', false, '2026-11-09T09:00:00+08:00'],
  ]
  const problems = []
  for (const [input, peak, next] of cases) {
    const result = currentTariff(Date.parse(input))
    if (result.peak !== peak) problems.push(`${input} 的高峰判断应为 ${peak}`)
    if (result.nextChangeAt !== Date.parse(next)) {
      problems.push(`${input} 的下次切换应为 ${next}`)
    }
  }
  return problems
}

async function main() {
  const meta = loadFixture()
  const tempHome = mkdtempSync(join(tmpdir(), 'balance-widget-home-'))
  mkdirSync(join(tempHome, 'storages'), { recursive: true })
  const cacheSource = join(REAL_DSH_HOME, 'storages', 'balance-widget-cache.json')
  copyFileSync(cacheSource, join(tempHome, 'storages', 'balance-widget-cache.json'))

  // 把缓存读完改成“已冻结”，让这一轮测试只做归并和标题补全，不扫日志。
  const cachePath = join(tempHome, 'storages', 'balance-widget-cache.json')
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  let expectedCost = 0
  const records = []
  for (const [sessionId, entry] of Object.entries(cache.sessions)) {
    entry.done = true
    const buckets = entry?.days?.[day]
    if (buckets !== undefined) expectedCost += Number(buckets.costCNY) || 0
    const info = meta[sessionId] ?? {}
    records.push({
      header: {
        id: sessionId,
        createdAt: info.createdAt ?? entry.createdAt,
        cwd: info.cwd ?? entry.cwd,
        parentSession: info.parentSession ?? entry.parentSession,
        origin: info.origin ?? entry.origin,
      },
      live: false,
      persisted: true,
      formatStatus: 'current',
    })
  }
  writeFileSync(cachePath, JSON.stringify(cache))

  const query = {
    async listSessions() {
      return records
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => {
        const title = meta[sessionId]?.title
        return title === undefined
          ? { sessionId, status: 'fulfilled', value: {} }
          : { sessionId, status: 'fulfilled', value: { title: { title } } }
      })
    },
  }
  const account = {
    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: '9.99' }], bonusWallets: [] }
    },
  }
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'deepseekAccount') return account
      return undefined
    },
    sessionQuery: query,
    sessionPersistence: {
      async open() {
        return { async read() { return { events: [] } }, async close() {} }
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const result = fn()
      return () => {
        if (typeof result === 'function') result()
      }
    },
    logger: { warn() {} },
  }

  process.env.DSH_HOME = tempHome
  const { apply } = await import(`../index.js?test=${process.pid}`)
  apply(ctx)
  const route = routes.find((item) => item.path === '/api/balance-widget/summary')
  if (route === undefined) throw new Error('汇总路由没有注册')

  const response = fakeResponse()
  await route.handler(buildRequest(), response)
  if (response.statusCode !== 200) throw new Error(`路由返回 ${response.statusCode}：${response.body}`)
  const payload = JSON.parse(response.body)

  const conversations = Array.isArray(payload.conversations) ? payload.conversations : []
  const failures = []
  if (!payload.ok) failures.push('响应 ok 不为 true')
  if (conversations.length === 0) failures.push('没有返回任何对话')
  const sumCost = conversations.reduce((sum, row) => sum + (Number(row.costCNY) || 0), 0)
  if (Math.abs(sumCost - expectedCost) > 1e-4) {
    failures.push(`对话花费合计 ${sumCost} 与当天总量 ${expectedCost} 不一致`)
  }
  if (payload.conversationSummary?.count !== conversations.length) {
    failures.push('conversationSummary.count 与对话行数不一致')
  }
  for (const row of conversations) {
    if (typeof row.title !== 'string' || row.title === '') failures.push(`标题为空: ${row.id}`)
    if (row.subagentCount !== row.subagents.length) failures.push(`子代理数量不一致: ${row.id}`)
  }
  const merged = conversations.find((row) => row.subagentCount > 0)
  if (merged === undefined) failures.push('没有找到带子代理的合并对话')

  for (const problem of checkTariffTimes()) failures.push(problem)
  const tariff = payload.tariff
  if (tariff === null || typeof tariff !== 'object' || typeof tariff.peak !== 'boolean') {
    failures.push('响应里缺少当前计费时段 tariff')
  } else if (!Number.isFinite(tariff.nextChangeAt)) {
    failures.push('tariff.nextChangeAt 不是有效时间戳')
  }

  // 非回环来源必须被 403 拒绝。
  const forbidden = fakeResponse()
  await route.handler(buildRequest('192.168.1.5'), forbidden)
  if (forbidden.statusCode !== 403) failures.push(`外部来源没有被拒绝，返回 ${forbidden.statusCode}`)

  const titled = conversations.filter((row) => row.untitled !== true).length
  console.log(`日期 ${day}，路由返回 ${conversations.length} 个对话，合计 ¥${sumCost.toFixed(4)}（应为 ¥${expectedCost.toFixed(4)}）`)
  for (const row of conversations) {
    const flag = row.subagentCount > 0 ? `（含 ${row.subagentCount} 个子代理）` : ''
    console.log(`  ¥${row.costCNY.toFixed(3).padStart(8)}  ${row.title}${flag}`)
  }
  console.log(`拿到真标题的对话 ${titled} 个，外部来源拒绝返回 ${forbidden.statusCode}`)
  if (tariff !== null && typeof tariff === 'object' && Number.isFinite(tariff.nextChangeAt)) {
    const next = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(tariff.nextChangeAt))
    console.log(`当前${tariff.peak ? '高峰' : '空闲'}时段，下次切换 ${next}`)
  }

  rmSync(tempHome, { recursive: true, force: true })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`失败: ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('')
  console.log('宿主路由联调通过：返回结构正确、合计一致、子代理已并账、外部来源被拒。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
