/**
 * 浏览器侧的离线冒烟测试：不打开浏览器，用一个极简的 React 桩和假的
 * fetch 把 client.js 的面板渲染一遍，检查“今日各对话花费”这块能正常
 * 收起、展开、再展开子代理，不抛异常、不出现 undefined。
 *
 * 它不需要安装 react 或 react-test-renderer，只验证我们自己的渲染逻辑。
 *
 *   node tools/test-client-render.mjs
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

let hookIndex = 0
let hookValues = null
const fakeReact = {
  createElement(type, props, ...children) {
    const value = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: value } }
  },
  useState(initial) {
    hookIndex += 1
    if (hookValues !== null && hookIndex - 1 < hookValues.length) {
      return [hookValues[hookIndex - 1], () => {}]
    }
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
}

function textOf(node, out) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return
  }
  if (typeof node === 'object' && node.props !== undefined) {
    textOf(node.props.children, out)
  }
}

function renderText(component) {
  hookIndex = 0
  hookValues = null
  const tree = component()
  const out = []
  textOf(tree, out)
  return out.join('\n')
}

const conversations = [
  {
    id: 'session-parent',
    title: '交接说明文档问题澄清',
    untitled: false,
    costCNY: 12.49,
    totalTokens: 12000000,
    requests: 500,
    subagentCount: 2,
    subagents: [
      { id: 'sub-a', title: '你负责本任务的版式引擎开发', costCNY: 4.38, totalTokens: 4000000, requests: 160 },
      { id: 'sub-b', title: '你负责本任务的版式体检模块', costCNY: 3.35, totalTokens: 3000000, requests: 120 },
    ],
  },
  {
    id: 'session-b',
    title: '设计DSH余额显示插件',
    untitled: false,
    costCNY: 3.41,
    totalTokens: 3000000,
    requests: 120,
    subagentCount: 0,
    subagents: [],
  },
]

let payload = {
  ok: true,
  balance: { ok: true, wallets: [{ currency: 'CNY', balance: '51.32' }], bonusWallets: [] },
  today: {
    day: '2026-11-03',
    costCNY: 18.58,
    totalTokens: 23000000,
    uncachedInputTokens: 1000000,
    cacheReadTokens: 22000000,
    outputTokens: 900000,
    cacheWriteTokens: 0,
    requests: 900,
    unpricedModels: [],
  },
  recent: { avgCostCNY: 45, days: [] },
  tariff: { peak: false, nextChangeAt: Date.now() + 3 * 3600 * 1000 },
  conversations,
  conversationSummary: { day: '2026-11-03', count: 2, subagentCount: 2, untitled: 0 },
  pending: 0,
  sessions: 435,
  updatedAt: Date.now(),
}

globalThis.fetch = async () => ({ ok: true, json: async () => payload })

const components = new Map()
const ctx = {
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(definition, component) {
      components.set(definition.name, component)
    },
  },
  effect() {
    return () => {}
  },
}

function requireFake(name) {
  if (name === 'react') return fakeReact
  throw new Error(`测试里没有准备模块：${name}`)
}

async function main() {
  await import(`../client.js?smoke=${process.pid}`)
  if (captured === null) throw new Error('client.js 没有通过模块加载器注册')
  const mod = captured.factory(requireFake)
  if (typeof mod.apply !== 'function') throw new Error('client.js 没有导出 apply')
  mod.apply(ctx)

  const trigger = components.get('sidebar.footer.action')
  const panel = components.get('shell.overlay')
  if (trigger === undefined || panel === undefined) throw new Error('挂件组件没有注册齐')
  if (components.get('conversation.composer.dock') === undefined) throw new Error('会话探针没有注册')

  // 等第一次取数落地，再点开面板。
  await new Promise((resolve) => setTimeout(resolve, 20))
  const triggerTree = trigger({ wide: true })
  if (triggerTree.props.title === undefined) throw new Error('侧边栏按钮缺少提示文本')
  triggerTree.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const collapsed = renderText(panel)
  const expanded = renderText(panelWithHooks(panel, [true, 'session-parent']))

  const failures = []
  for (const [label, text] of [['收起状态', collapsed], ['展开状态', expanded]]) {
    if (!text.includes('今日各对话花费')) failures.push(`${label}没有“今日各对话花费”这一块`)
    if (!text.includes('交接说明文档问题澄清')) failures.push(`${label}没有显示最高花费的对话`)
    if (text.includes('undefined')) failures.push(`${label}出现了 undefined 文本`)
  }
  if (!collapsed.includes('展开 2 个')) failures.push('收起状态没有“展开 2 个”按钮')
  if (!expanded.includes('收起')) failures.push('展开状态没有“收起”按钮')
  if (!expanded.includes('你负责本任务的版式引擎开发')) failures.push('展开后没有列出子代理明细')
  if (!expanded.includes('含 2 个子代理')) failures.push('合并对话没有标注子代理数量')
  if (!collapsed.includes('空闲时段') || !collapsed.includes('半价')) {
    failures.push('面板没有显示当前空闲时段')
  }
  if (!String(trigger({ wide: true }).props.title).includes('空闲时段半价')) {
    failures.push('侧边栏提示没有当前计费时段')
  }
  const triggerText = renderText(() => trigger({ wide: true }))
  if (!triggerText.includes('空闲半价')) failures.push('侧边栏数字旁边没有显示空闲半价')

  // 把时段切成高峰再取一次数，确认提示条和侧边栏提示都跟着变。
  payload = { ...payload, tariff: { peak: true, nextChangeAt: Date.now() + 2 * 3600 * 1000 } }
  trigger({ wide: true }).props.onClick() // 先关掉
  trigger({ wide: true }).props.onClick() // 再打开并刷新
  await new Promise((resolve) => setTimeout(resolve, 20))
  const peakText = renderText(panel)
  if (!peakText.includes('高峰时段') || !peakText.includes('全价')) {
    failures.push('切换到高峰后没有显示高峰时段')
  }
  if (!String(trigger({ wide: true }).props.title).includes('高峰时段全价')) {
    failures.push('侧边栏提示没有随高峰时段更新')
  }
  const peakTriggerText = renderText(() => trigger({ wide: true }))
  if (!peakTriggerText.includes('高峰全价')) failures.push('侧边栏数字旁边没有随高峰更新')

  console.log('收起状态行数：', collapsed.split('\n').length)
  console.log('展开状态行数：', expanded.split('\n').length)
  console.log('计费时段提示：', collapsed.includes('空闲时段') ? '先空闲后半价' : '没显示空闲时段')
  if (failures.length > 0) {
    for (const failure of failures) console.error(`失败: ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('浏览器侧冒烟通过：收起、展开、子代理明细和计费时段提示都能渲染，没有 undefined。')
}

/** 给面板补上两个 useState 的初始值：展开标记和当前展开的对话。 */
function panelWithHooks(panel, [expandedFlag, expandedRow]) {
  return () => {
    // useStore 内部先调用一次 useState，我们跳过它，只覆盖面板自己的两次。
    hookValues = [0, expandedFlag, expandedRow]
    hookIndex = 0
    return panel()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
