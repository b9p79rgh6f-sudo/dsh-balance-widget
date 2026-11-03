/**
 * 余额挂件 —— 宿主页。
 *
 * 客户端能直接读到两样东西：账户余额（官方 Remote 接口）和当前会话的 token
 * 投影。但“今日累计用量”跨所有会话，客户端拿不到，只能在这里算。
 *
 * 本文件做两件事：把每个会话日志里带用量的 assistant/message 事件，按北京
 * 时间归到某一日，累加 token 并估算花费；再把当天各会话的花费按“对话”合并，
 * 子代理顺着 parentSession 并进发起它的根会话。除此之外还上报当前处在高峰
 * 还是空闲计费时段，供界面提示。结果通过一条回环专用的 HTTP 路由交给客户端。
 *
 * 价格口径：DeepSeek 官方价目（2026-11-03 取自 api-docs.deepseek.com）。
 * 高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余时段半价。
 * 中国法定节假日按高峰计价，所以估算只会偏高，不会偏低。
 *
 * @module dsh-balance-widget
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 稳定的插件名。 */
export const name = 'balance-widget'

/** 激活前必须就位的宿主服务。 */
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'timer']

const SUMMARY_PATH = '/api/balance-widget/summary'
const CACHE_VERSION = 1
const CACHE_PATH = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'storages',
  'balance-widget-cache.json',
)
/** 一次请求内最多花多少毫秒扫日志，超过就留到下一次。 */
const SCAN_TIME_BUDGET_MS = 2000
/** 一次请求内最多处理多少个会话。 */
const SCAN_SESSION_BUDGET = 60
/** 每轮额外复核几个“已冻结”的旧会话，防止重启后漏掉会话恢复产生的用量。 */
const REVALIDATE_PER_ROUND = 4
/** 会话清单缓存多久（毫秒）。 */
const LIST_TTL_MS = 15000
/** 缓存里最多保留多少天。 */
const KEEP_DAYS = 120
/** 读标题最多等多久（毫秒），超时就先用临时名字，下一轮再补。 */
const TITLE_WAIT_MS = 1500
/** 一次标题读取最多查多少个会话。 */
const TITLE_BATCH = 25
/** 一个会话没有标题时，隔多久再试一次（毫秒）。 */
const TITLE_RECHECK_MS = 10 * 60 * 1000

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
/** 北京时间固定是 UTC+8，没有夏令时，直接按固定偏移换算。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
/** 没有标题的会话，用它的创建时刻做临时名字。 */
const CLOCK_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * 官方价目，单位是人民币元每百万 tokens。
 * 空闲时段价格是高峰时段的一半。
 */
const PRICES = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    idle: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    idle: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
}
/** 已下线但仍会出现在日志里的旧模型名，按 Flash 计价。 */
const LEGACY_FLASH = new Set(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat'])

function priceTableFor(model) {
  if (LEGACY_FLASH.has(model)) return PRICES['deepseek-flash']
  return PRICES[model]
}

function dayKeyOf(time) {
  return DAY_FORMATTER.format(new Date(time))
}

/** 把时间戳拆成北京时间的年月日和星期。 */
function shanghaiParts(time) {
  const shifted = new Date(time + SHANGHAI_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/** 北京时间某个时刻对应的时间戳。 */
function shanghaiMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS
}

function isPeakHour(time) {
  const parts = shanghaiParts(time)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  return (parts.hour >= 9 && parts.hour < 12) || (parts.hour >= 14 && parts.hour < 18)
}

/**
 * 当前处在高峰还是空闲时段，以及下一次切换的时刻。
 * 高峰是北京时间周一至周五 9:00-12:00 与 14:00-18:00，其余时段半价。
 * 法定节假日这里仍按工作日算，和花费估算的口径保持一致（只会偏高）。
 */
export function currentTariff(now) {
  const peak = isPeakHour(now)
  let nextChangeAt = null
  for (let offset = 0; offset <= 8 && nextChangeAt === null; offset += 1) {
    const shifted = new Date(now + SHANGHAI_OFFSET_MS + offset * 86400000)
    const weekday = shifted.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const year = shifted.getUTCFullYear()
    const month = shifted.getUTCMonth() + 1
    const day = shifted.getUTCDate()
    for (const boundary of [
      [9, 0],
      [12, 0],
      [14, 0],
      [18, 0],
    ]) {
      const candidate = shanghaiMs(year, month, day, boundary[0], boundary[1])
      if (candidate > now) {
        nextChangeAt = candidate
        break
      }
    }
  }
  return {
    peak,
    multiplier: peak ? 1 : 0.5,
    nextChangeAt,
  }
}

function startOfTodayMs() {
  const key = DAY_FORMATTER.format(new Date())
  return Date.parse(`${key}T00:00:00+08:00`)
}

function emptyBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCNY: 0,
    pricedTokens: 0,
    requests: 0,
    unpricedModels: [],
  }
}

function addUsage(buckets, usage, model, peak) {
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0
  buckets.uncachedInputTokens += input
  buckets.outputTokens += output
  buckets.cacheReadTokens += cacheRead
  buckets.cacheWriteTokens += cacheWrite
  buckets.requests += 1
  const table = priceTableFor(model)
  if (table === undefined) {
    buckets.unpricedModels = [...new Set([...buckets.unpricedModels, model || 'unknown'])]
    return
  }
  const rates = peak ? table.peak : table.idle
  buckets.costCNY +=
    (cacheRead / 1e6) * rates.cacheHit +
    (cacheWrite / 1e6) * rates.cacheMiss +
    (input / 1e6) * rates.cacheMiss +
    (output / 1e6) * rates.output
  buckets.pricedTokens += input + output + cacheRead + cacheWrite
}

function pruneDays(days, keepDays) {
  const keys = Object.keys(days).sort()
  if (keys.length <= keepDays) return days
  const kept = {}
  for (const key of keys.slice(keys.length - keepDays)) kept[key] = days[key]
  return kept
}

async function loadCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.version !== CACHE_VERSION || typeof parsed.sessions !== 'object') {
      return { version: CACHE_VERSION, sessions: {} }
    }
    return parsed
  } catch {
    return { version: CACHE_VERSION, sessions: {} }
  }
}

let saveChain = Promise.resolve()
function saveCache(cache) {
  const snapshot = JSON.stringify({ ...cache, savedAt: Date.now() })
  saveChain = saveChain
    .then(async () => {
      await mkdir(dirname(CACHE_PATH), { recursive: true })
      const temporary = `${CACHE_PATH}.${process.pid}.tmp`
      await writeFile(temporary, snapshot, 'utf8')
      await rename(temporary, CACHE_PATH)
    })
    .catch(() => undefined)
  return saveChain
}

/**
 * 读一个会话从 fromSeq 起的日志事件。
 * 后端版本不同，两种读取姿势都试一遍。
 */
async function readEventsSince(persistence, sessionId, fromSeq) {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read(fromSeq)
      return result.events ?? []
    } finally {
      try {
        await handle.close()
      } catch {
        /* 句柄随这次调用一起废弃，关闭失败不影响已读到的事件。 */
      }
    }
  }
  const result = await persistence.readFrom(sessionId, fromSeq)
  return result.events ?? []
}

/** 把一个会话新增的日志折进缓存。 */
async function foldSession(ctx, cache, sessionId) {
  const entry = cache.sessions[sessionId] ?? { lastSeq: 0, done: false, days: {} }
  const events = await readEventsSince(ctx.sessionPersistence, sessionId, entry.lastSeq)
  let lastSeq = entry.lastSeq
  let changed = false
  for (const event of events) {
    const seq = Number(event?.seq) || 0
    if (seq > lastSeq) lastSeq = seq
    if (seq <= entry.lastSeq) continue
    if (event?.type === 'session/title') {
      // 标题事件和用量一样按 seq 增量读，读到就顺手记下，界面不必再单独查。
      const title = event.data?.title
      if (typeof title === 'string' && title.trim() !== '') {
        const normalized = title.trim()
        if (entry.title !== normalized) {
          entry.title = normalized
          changed = true
        }
        entry.titleCheckedAt = Date.now()
      }
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    const day = dayKeyOf(event.time)
    const model = event.data?.message?.source?.model ?? ''
    const buckets = entry.days[day] ?? emptyBuckets()
    addUsage(buckets, usage, model, isPeakHour(event.time))
    entry.days[day] = buckets
    changed = true
  }
  entry.lastSeq = lastSeq
  entry.days = pruneDays(entry.days, KEEP_DAYS)
  cache.sessions[sessionId] = entry
  return changed
}

/** 把会话头里的身份信息抄进缓存，父会话是子代理并账的依据。 */
function adoptHeader(entry, header) {
  if (entry === null || typeof entry !== 'object') return false
  if (header === null || typeof header !== 'object') return false
  let changed = false
  const createdAt = Number(header.createdAt)
  if (Number.isFinite(createdAt) && createdAt > 0 && entry.createdAt !== createdAt) {
    entry.createdAt = createdAt
    changed = true
  }
  if (typeof header.cwd === 'string' && header.cwd !== '' && entry.cwd !== header.cwd) {
    entry.cwd = header.cwd
    changed = true
  }
  if (
    typeof header.parentSession === 'string' &&
    header.parentSession !== '' &&
    entry.parentSession !== header.parentSession
  ) {
    entry.parentSession = header.parentSession
    changed = true
  }
  if (typeof header.origin === 'string' && header.origin !== '' && entry.origin !== header.origin) {
    entry.origin = header.origin
    changed = true
  }
  return changed
}

/** 把今天各会话的桶加起来。 */
/** 把某一天各会话的桶加起来。 */
function aggregateDay(cache, dayKey) {
  const total = emptyBuckets()
  for (const entry of Object.values(cache.sessions)) {
    const buckets = entry.days?.[dayKey]
    if (buckets === undefined) continue
    total.uncachedInputTokens += buckets.uncachedInputTokens
    total.outputTokens += buckets.outputTokens
    total.cacheReadTokens += buckets.cacheReadTokens
    total.cacheWriteTokens += buckets.cacheWriteTokens
    total.costCNY += buckets.costCNY
    total.pricedTokens += buckets.pricedTokens
    total.requests += buckets.requests
    if (buckets.unpricedModels?.length) {
      total.unpricedModels = [...new Set([...total.unpricedModels, ...buckets.unpricedModels])]
    }
  }
  total.totalTokens =
    total.uncachedInputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens
  return total
}

/**
 * 取今天之前若干天的日汇总，并算出日均花费。
 * 只统计真正有用量的日子，没开机的日子不算进平均，否则均值会被稀释。
 */
function recentDays(cache, count) {
  const now = Date.now()
  const days = []
  for (let offset = 1; offset <= count; offset += 1) {
    const key = dayKeyOf(now - offset * 86400000)
    const buckets = aggregateDay(cache, key)
    if (buckets.requests === 0) continue
    days.push({ day: key, costCNY: buckets.costCNY, totalTokens: buckets.totalTokens })
  }
  const avgCostCNY =
    days.length === 0 ? null : days.reduce((sum, item) => sum + item.costCNY, 0) / days.length
  return { days, avgCostCNY }
}

/**
 * 一个日桶里的 token 合计。
 */
function bucketTokens(buckets) {
  return (
    (Number(buckets?.uncachedInputTokens) || 0) +
    (Number(buckets?.outputTokens) || 0) +
    (Number(buckets?.cacheReadTokens) || 0) +
    (Number(buckets?.cacheWriteTokens) || 0)
  )
}

/** 这个会话有没有拿到真标题。 */
function hasSessionTitle(entry) {
  return typeof entry?.title === 'string' && entry.title.trim() !== ''
}

/** 会话在界面上的名字：有标题用标题，没有就先给个临时名字。 */
function sessionTitleOf(entry, sessionId) {
  if (hasSessionTitle(entry)) return entry.title.trim()
  const created = Number(entry?.createdAt)
  if (Number.isFinite(created) && created > 0) return `${CLOCK_FORMATTER.format(created)} 的会话`
  return `会话 ${String(sessionId).slice(-6)}`
}

/** 顺着 parentSession 找到发起这次对话的根会话。 */
function rootSessionOf(cache, sessionId) {
  let current = sessionId
  const seen = new Set([current])
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = cache.sessions[current]?.parentSession
    if (typeof parent !== 'string' || parent === '' || seen.has(parent)) return current
    if (cache.sessions[parent] === undefined) return current
    seen.add(parent)
    current = parent
  }
  return current
}

/**
 * 把某一天各会话的桶按“对话”合并：子代理的花费并入发起它的根会话，
 * 子代理自己另存一份明细，供界面展开查看。
 * @param cache - 已折好的缓存。
 * @param dayKey - 本地日期键。
 * @returns 按花费从高到低排序的对话行。
 */
export function buildConversationRows(cache, dayKey) {
  const rows = new Map()
  for (const [sessionId, entry] of Object.entries(cache.sessions)) {
    const buckets = entry?.days?.[dayKey]
    if (buckets === undefined) continue
    const tokens = bucketTokens(buckets)
    const requests = Number(buckets.requests) || 0
    const costCNY = Number(buckets.costCNY) || 0
    if (tokens === 0 && requests === 0 && costCNY === 0) continue
    const rootId = rootSessionOf(cache, sessionId)
    let row = rows.get(rootId)
    if (row === undefined) {
      const rootEntry = cache.sessions[rootId] ?? entry
      row = {
        id: rootId,
        title: sessionTitleOf(rootEntry, rootId),
        untitled: !hasSessionTitle(rootEntry),
        createdAt: Number.isFinite(Number(rootEntry?.createdAt))
          ? Number(rootEntry.createdAt)
          : null,
        cwd: typeof rootEntry?.cwd === 'string' ? rootEntry.cwd : null,
        costCNY: 0,
        totalTokens: 0,
        requests: 0,
        subagents: [],
      }
      rows.set(rootId, row)
    }
    row.costCNY += costCNY
    row.totalTokens += tokens
    row.requests += requests
    if (sessionId !== rootId) {
      row.subagents.push({
        id: sessionId,
        title: sessionTitleOf(entry, sessionId),
        untitled: !hasSessionTitle(entry),
        costCNY,
        totalTokens: tokens,
        requests,
      })
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      costCNY: Math.round(row.costCNY * 1e6) / 1e6,
      subagents: row.subagents.sort(
        (a, b) => b.costCNY - a.costCNY || b.totalTokens - a.totalTokens,
      ),
      subagentCount: row.subagents.length,
    }))
    .sort((a, b) => b.costCNY - a.costCNY || b.totalTokens - a.totalTokens)
}

/** 这一批对话里还缺标题的会话 id。 */
function untitledSessionIds(rows) {
  const ids = []
  for (const row of rows) {
    if (row.untitled === true) ids.push(row.id)
    for (const subagent of row.subagents) if (subagent.untitled === true) ids.push(subagent.id)
  }
  return [...new Set(ids)]
}

/**
 * 用官方的标题投影补名字。只查当前缺标题的会话，查过的记下时间，
 * 十分钟内不重复查；单次最多等 TITLE_WAIT_MS，超时就先显示临时名字。
 * @returns 补到新标题的会话数量。
 */
async function resolveSessionTitles(ctx, cache, sessionIds, timeBudgetMs) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readTitleSnapshots !== 'function') return 0
  const now = Date.now()
  const pending = sessionIds.filter((id) => {
    if (cache.sessions[id] === undefined) return false
    return now - (Number(cache.sessions[id].titleCheckedAt) || 0) >= TITLE_RECHECK_MS
  })
  if (pending.length === 0) return 0
  const deadline = Date.now() + timeBudgetMs
  let changed = 0
  for (let offset = 0; offset < pending.length; offset += TITLE_BATCH) {
    if (offset > 0 && Date.now() > deadline) break
    const batch = pending.slice(offset, offset + TITLE_BATCH)
    try {
      const results = await query.readTitleSnapshots(batch)
      for (const result of Array.isArray(results) ? results : []) {
        const entry = cache.sessions[result?.sessionId]
        if (entry === undefined) continue
        entry.titleCheckedAt = Date.now()
        const title = result?.status === 'fulfilled' ? result.value?.title?.title : undefined
        if (typeof title === 'string' && title.trim() !== '' && entry.title !== title.trim()) {
          entry.title = title.trim()
          changed += 1
        }
      }
    } catch {
      // 这一批先记下检查时间，十分钟内不再重试，避免每轮请求都去撞同一个错误。
      for (const id of batch) {
        const entry = cache.sessions[id]
        if (entry !== undefined) entry.titleCheckedAt = Date.now()
      }
      break
    }
  }
  return changed
}

/**
 * 读账户余额。客户端只发一个请求就能拿到余额与今日用量，浏览器端不必再碰
 * 账户 Remote，少一处启动期依赖。
 */
async function readBalance(ctx, req) {
  try {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || typeof account.getBalance !== 'function') {
      return { ok: false, reason: 'account service unavailable' }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const metadata = {
      version: url.searchParams.get('v') || '0.3.2',
      locale: url.searchParams.get('l') || 'zh-CN',
      timezoneOffsetSeconds: Number(url.searchParams.get('t') ?? '28800'),
    }
    const result = await account.getBalance(metadata)
    if (result === null || result === undefined) return { ok: false, reason: 'signed out' }
    if (result.status !== 'ready') return { ok: false, reason: 'platform query failed' }
    return { ok: true, wallets: result.value ?? [], bonusWallets: result.bonusWallets ?? [] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx) {
  const cache = { version: CACHE_VERSION, sessions: {} }
  let loaded = false
  let inflight = null
  let round = 0
  let listCache = { at: 0, records: [] }

  async function ensureLoaded() {
    if (loaded) return
    const stored = await loadCache()
    Object.assign(cache.sessions, stored.sessions ?? {})
    loaded = true
  }

  async function scanOnce() {
    await ensureLoaded()
    const deadline = Date.now() + SCAN_TIME_BUDGET_MS
    let records
    // 列会话本身就要遍历整个语料库，每轮都列一次会把扫描拖成龟速，缓存一小段时间。
    if (listCache.records.length > 0 && Date.now() - listCache.at < LIST_TTL_MS) {
      records = listCache.records
    } else {
      try {
        records = await ctx.sessionQuery.listSessions()
        listCache = { at: Date.now(), records }
      } catch (error) {
        ctx.logger?.warn?.(`balance-widget: 列出会话失败：${String(error)}`)
        return 0
      }
    }
    const todayStart = startOfTodayMs()
    const byId = new Map()
    const liveIds = []
    const todayIds = []
    const otherIds = []
    let changed = false
    for (const record of records) {
      if (record.formatStatus !== undefined && record.formatStatus !== 'current') continue
      const id = record.header?.id
      if (id === undefined) continue
      byId.set(id, record)
      const entry = cache.sessions[id]
      // 会话头里有创建时间、工作目录、父会话，先抄进缓存，供按对话归并使用。
      if (entry !== undefined && adoptHeader(entry, record.header)) changed = true
      if (record.live) liveIds.push(id)
      else if (entry === undefined || entry.done !== true) {
        const created = Number(record.header?.createdAt) || 0
        if (created >= todayStart) todayIds.push(id)
        else otherIds.push(id)
      }
    }
    let processed = 0
    // 先在线的、再今天新建的、最后才是历史会话——今日数字最先正确。
    const work = [...liveIds, ...todayIds, ...otherIds]
    for (const id of work) {
      if (processed >= SCAN_SESSION_BUDGET || Date.now() > deadline) break
      try {
        changed = (await foldSession(ctx, cache, id)) || changed
        const entry = cache.sessions[id]
        // 本轮新出现的会话，日志折完再补会话头，免得第一次显示时缺父会话。
        if (adoptHeader(entry, byId.get(id)?.header)) changed = true
        entry.done = byId.get(id)?.live !== true
        entry.lastCheckedAt = Date.now()
      } catch (error) {
        ctx.logger?.warn?.(`balance-widget: 读取会话 ${id} 失败：${String(error)}`)
      }
      processed += 1
    }
    // 每轮复核几个“已冻结”的旧会话，补偿重启期间被恢复过的会话。
    const allIds = Object.keys(cache.sessions)
    if (allIds.length > 0) {
      round += 1
      const start = (round * REVALIDATE_PER_ROUND) % allIds.length
      for (let k = 0; k < REVALIDATE_PER_ROUND; k += 1) {
        if (Date.now() > deadline) break
        const id = allIds[(start + k) % allIds.length]
        const entry = cache.sessions[id]
        if (entry === undefined || entry.done !== true) continue
        try {
          changed = (await foldSession(ctx, cache, id)) || changed
          entry.lastCheckedAt = Date.now()
        } catch {
          /* 单个会话读失败不阻断整轮扫描。 */
        }
      }
    }
    if (changed || processed > 0) await saveCache(cache)
    return [...liveIds, ...todayIds, ...otherIds].filter(
      (id) => cache.sessions[id]?.done !== true,
    ).length
  }

  async function refresh() {
    if (inflight !== null) return inflight
    inflight = scanOnce()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SUMMARY_PATH,
        handler: async (req, res) => {
          if (rejectForeignCaller(req, res)) return
          try {
            const pending = await refresh()
            scheduleSweep(pending)
            const todayKey = dayKeyOf(Date.now())
            const today = aggregateDay(cache, todayKey)
            const recent = recentDays(cache, 7)
            // 今天各对话的花费。子代理先并进根会话，缺标题的会话顺手补一次，
            // 补到就重排一次，补不到就先用“几点几分 的会话”顶上。
            let conversations = buildConversationRows(cache, todayKey)
            const missingTitles = untitledSessionIds(conversations)
            if (missingTitles.length > 0) {
              const titled = await resolveSessionTitles(ctx, cache, missingTitles, TITLE_WAIT_MS)
              if (titled > 0) {
                await saveCache(cache)
                conversations = buildConversationRows(cache, todayKey)
              }
            }
            const balance = await readBalance(ctx, req)
            json(res, 200, {
              ok: true,
              balance,
              today: { day: todayKey, ...today },
              recent,
              tariff: currentTariff(Date.now()),
              conversations,
              conversationSummary: {
                day: todayKey,
                count: conversations.length,
                subagentCount: conversations.reduce((sum, row) => sum + row.subagentCount, 0),
                untitled: conversations.filter((row) => row.untitled === true).length,
              },
              pending,
              sessions: Object.keys(cache.sessions).length,
              updatedAt: Date.now(),
            })
          } catch (error) {
            ctx.logger?.warn?.(`balance-widget: 汇总失败：${String(error)}`)
            json(res, 500, {
              ok: false,
              error: 'internal',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }),
    'balance-widget: summary route',
  )

  // 后台续扫：一次请求只做有限的工作，剩下的自己排队做完，别等客户端轮询。
  let sweepTimer = null
  function scheduleSweep(remaining) {
    if (sweepTimer !== null || typeof ctx.timeout !== 'function') return
    if (typeof remaining !== 'number' || remaining <= 0) return
    sweepTimer = ctx.timeout(() => {
      sweepTimer = null
      void refresh()
        .then((left) => scheduleSweep(left))
        .catch(() => undefined)
    }, 40)
  }

  // 插件一激活就先扫一轮，用户打开面板时已经有数可看。
  void refresh()
    .then((left) => scheduleSweep(left))
    .catch(() => undefined)

  // 关掉宿主时把缓存落盘，别丢了扫描进度。
  ctx.effect(() => () => void saveCache(cache), 'balance-widget: cache flush')
}

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(JSON.stringify(value))
}

function hostNameOf(host) {
  if (typeof host !== 'string' || host.length === 0) return ''
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
}

function isLoopbackAddress(value) {
  if (typeof value !== 'string') return false
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('127.')
  )
}

/** 这条路由只服务本机页面，别的机器和别的网站一律拒绝。 */
function rejectForeignCaller(req, res) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return true
  }
  const peer = req.socket?.remoteAddress
  const host = hostNameOf(req.headers.host)
  const hostIsLocal = host === 'localhost' || isLoopbackAddress(host)
  if (isLoopbackAddress(peer) && hostIsLocal) return false
  json(res, 403, { ok: false, error: 'forbidden' })
  return true
}
