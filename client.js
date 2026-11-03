/**
 * 余额挂件 —— 浏览器侧。
 *
 * 写法照搬本机已经跑通的手写插件（module.exports 形式）。
 * 余额和用量都来自宿主页的同一条回环路由，浏览器端不碰账户 Remote。
 *
 * 三处注册：
 *   1. sidebar.footer.action  侧边栏底部常驻的余额胶囊，带一条今日花费进度条。
 *   2. shell.overlay          点开后的渐变卡片面板。
 *   3. conversation.composer.dock  不渲染任何东西的探针，把当前会话的投影抄进
 *      共享状态——侧边栏是根作用域，拿不到会话。
 *
 * 进度条口径：今日花费相对最近 7 天日均。不到七成是常规色，七成到打平转黄，
 * 超过日均转红。没用量的日子不计入均值，否则均值会被开机少的日子稀释。
 *
 * 面板里另有一块「今日各对话花费」：收起时露当天最高的一条，点开列出全部对话，
 * 有子代理的对话还能再展开看每个子代理各花了多少。面板标题下面还有一条计费
 * 时段提示，写明现在是空闲半价还是高峰全价，下一次什么时候切换。
 */

window.__ModuleLoader__.load({
  id: 'dsh-balance-widget',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const COLOR_OK = 'var(--dsw-alias-brand-primary)'
    const COLOR_WARN = 'var(--dsw-alias-state-warn-primary)'
    const COLOR_IDLE_DOT = 'var(--dsw-alias-state-success-primary)'
    const COLOR_OVER = 'var(--dsw-alias-state-error-primary)'

    const store = {
      balance: null,
      balanceError: null,
      today: null,
      todayError: null,
      sessionUsage: null,
      contextPressure: null,
      sessionId: null,
      open: false,
      loading: false,
      updatedAt: 0,
    }
    const listeners = new Set()

    function patch(next) {
      let changed = false
      for (const key of Object.keys(next)) {
        if (store[key] !== next[key]) {
          store[key] = next[key]
          changed = true
        }
      }
      if (changed) for (const listener of [...listeners]) listener()
    }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return store
    }

    function summaryUrl() {
      const locale = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN'
      const offset = -new Date().getTimezoneOffset() * 60
      return `/api/balance-widget/summary?v=0.3.2&l=${encodeURIComponent(locale)}&t=${offset}`
    }

    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      return value.toFixed(2)
    }

    function shortNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      if (value < 1000) return String(Math.round(value))
      if (value < 1e6) return `${(value / 1e3).toFixed(1)}K`
      if (value < 1e9) return `${(value / 1e6).toFixed(2)}M`
      return `${(value / 1e9).toFixed(2)}B`
    }

    const DAY_KEY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const CLOCK_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      weekday: 'short',
    })

    function dayKeyOf(time) {
      return DAY_KEY_FORMATTER.format(new Date(time))
    }

    /** 下一次计费切换的文字，今天只写时刻，明天加“明天”，再往后带星期。 */
    function nextChangeText(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return ''
      const clock = CLOCK_FORMATTER.format(new Date(time))
      const target = dayKeyOf(time)
      const now = Date.now()
      if (target === dayKeyOf(now)) return clock
      if (target === dayKeyOf(now + 86400000)) return `明天 ${clock}`
      return `${WEEKDAY_FORMATTER.format(new Date(time))} ${clock}`
    }

    /** 当前计费时段的完整描述。 */
    function tariffText(tariff) {
      if (tariff === null || typeof tariff !== 'object' || typeof tariff.peak !== 'boolean') return ''
      const base = tariff.peak ? '高峰时段，全价计费' : '空闲时段，半价计费'
      const when = nextChangeText(tariff.nextChangeAt)
      return when === '' ? base : `${base}，${when} 切换`
    }

    /** 侧边栏提示用的短说法。 */
    function tariffShort(tariff) {
      if (tariff === null || typeof tariff !== 'object' || typeof tariff.peak !== 'boolean') return ''
      return tariff.peak ? '高峰时段全价' : '空闲时段半价'
    }

    /** 侧边栏常驻的小标签，不点开面板也能看见当前计费时段。 */
    function tariffBadge(tariff) {
      if (tariff === null || typeof tariff !== 'object' || typeof tariff.peak !== 'boolean') return null
      return { text: tariff.peak ? '高峰全价' : '空闲半价', peak: tariff.peak }
    }

    /** 余额、今日花费、今日占比、配色档位这些都由这一处算出来。 */
    function readSnapshot() {
      const wallets = store.balance && store.balance.wallets ? store.balance.wallets : []
      const primary = wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0]
      const bonusWallets = store.balance && store.balance.bonusWallets ? store.balance.bonusWallets : []
      const bonus = bonusWallets.find((wallet) => wallet.currency === 'CNY') ?? bonusWallets[0]
      const day = store.today && store.today.today ? store.today.today : null
      const recent = store.today && store.today.recent ? store.today.recent : null
      const avg = recent && typeof recent.avgCostCNY === 'number' ? recent.avgCostCNY : null
      const spent = day ? day.costCNY : null
      const ratio = avg !== null && avg > 0 && spent !== null ? spent / avg : null
      let level = 'ok'
      if (ratio !== null) {
        if (ratio >= 1) level = 'over'
        else if (ratio >= 0.7) level = 'warn'
      }
      const balanceNumber = primary ? Number(primary.balance) : null
      const low = balanceNumber !== null && Number.isFinite(balanceNumber) && balanceNumber < 3
      const pct =
        ratio === null ? 0 : Math.min(100, Math.max(ratio > 0 ? 3 : 0, Math.round(ratio * 100)))
      return {
        primary,
        bonus,
        wallets,
        bonusWallets,
        day,
        recent,
        avg,
        spent,
        ratio,
        level,
        pct,
        balanceNumber,
        low,
        color: level === 'over' ? COLOR_OVER : level === 'warn' ? COLOR_WARN : COLOR_OK,
      }
    }

    async function refresh() {
      if (store.loading) return
      patch({ loading: true })
      try {
        const response = await fetch(summaryUrl(), { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (!payload || payload.ok !== true) throw new Error('summary failed')
        const balance = payload.balance
        if (balance && balance.ok === true) {
          patch({ balance, balanceError: null })
        } else {
          patch({ balance: null, balanceError: (balance && balance.reason) || '余额不可用' })
        }
        patch({ today: payload, todayError: null })
      } catch (error) {
        patch({ todayError: error instanceof Error ? error.message : String(error) })
      } finally {
        patch({ loading: false, updatedAt: Date.now() })
      }
    }

    /** 细进度条。track 与 fill 分开，track 走半透明，fill 走档位色。 */
    function bar(snapshot, options) {
      const opts = options || {}
      const height = opts.height || '2px'
      const track = opts.track || 'color-mix(in srgb, currentColor 18%, transparent)'
      const radius = opts.radius || '1px'
      const placement = opts.absolute
        ? { position: 'absolute', left: 0, right: 0, bottom: 0, width: 'auto' }
        : { position: 'relative', width: '100%' }
      return h(
        'div',
        {
          style: {
            ...placement,
            height,
            borderRadius: radius,
            background: track,
            overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${snapshot.pct}%`,
            borderRadius: radius,
            background: opts.fill || snapshot.color,
            transition: 'width 240ms ease',
          },
        }),
      )
    }

    /**
     * 侧边栏底部的常驻余额。
     *
     * 不加外框、不加底色、不加进度条——只显示数字本身，颜色表达状态：
     * 余额低于 3 元转红，低于 10 元转琥珀，其余用常规文字色。
     */
    function Trigger({ wide }) {
      const state = useStore()
      const snapshot = readSnapshot()
      const balanceText = snapshot.primary ? money(Number(snapshot.primary.balance)) : '--'
      const spentText = snapshot.spent === null ? null : `今 ¥${money(snapshot.spent)}`
      const tone =
        snapshot.balanceNumber === null
          ? 'var(--dsw-alias-label-primary)'
          : snapshot.balanceNumber < 3
            ? COLOR_OVER
            : snapshot.balanceNumber < 10
              ? COLOR_WARN
              : 'var(--dsw-alias-label-primary)'
      const tooltipBase =
        snapshot.avg === null
          ? `余额 ¥${balanceText}，今日花费 ¥${money(snapshot.spent)}`
          : `余额 ¥${balanceText}，今日 ¥${money(snapshot.spent)}，近 7 日均值 ¥${money(snapshot.avg)}`
      const tariffNote = tariffShort(state.today && state.today.tariff)
      const tooltip = tariffNote === '' ? tooltipBase : `${tooltipBase}，当前${tariffNote}`
      const badge = tariffBadge(state.today && state.today.tariff)

      return h(
        'button',
        {
          type: 'button',
          'data-dsh-balance': 'trigger',
          title: tooltip,
          onClick: () => {
            const opening = !store.open
            patch({ open: opening })
            if (opening) void refresh()
          },
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'center',
            gap: '10px',
            height: '32px',
            padding: wide ? '0 6px' : '0',
            border: 'none',
            background: state.open
              ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)'
              : 'transparent',
            borderRadius: '8px',
            color: tone,
            fontFamily: 'inherit',
            fontSize: '12px',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        h(
          'span',
          { style: { display: 'flex', alignItems: 'baseline', gap: '1px' } },
          h('span', { style: { fontSize: '11px', fontWeight: 700 } }, '¥'),
          h('span', { style: { fontSize: '13px', fontWeight: 700 } }, balanceText),
        ),
        badge !== null
          ? h(
              'span',
              {
                'data-dsh-balance': 'tariff-badge',
                style: {
                  flex: 'none',
                  color: badge.peak ? COLOR_WARN : 'var(--dsw-alias-label-secondary)',
                  fontSize: '10.5px',
                  fontWeight: 500,
                  lineHeight: '15px',
                  whiteSpace: 'nowrap',
                },
              },
              h('span', {
                style: {
                  display: 'inline-block',
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  verticalAlign: 'middle',
                  position: 'relative',
                  top: '-1px',
                  marginRight: '3px',
                  background: badge.peak ? COLOR_WARN : COLOR_IDLE_DOT,
                },
              }),
              wide ? badge.text : null,
            )
          : null,
        wide && spentText !== null
          ? h(
              'span',
              {
                style: {
                  flex: 'none',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: '10.5px',
                  fontWeight: 400,
                  lineHeight: '15px',
                  whiteSpace: 'nowrap',
                },
              },
              spentText,
            )
          : null,
      )
    }

    function rowOf(label, value, tone) {
      return h(
        'div',
        {
          key: label,
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '3px 0',
            fontSize: '12px',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h(
          'span',
          {
            style: {
              color:
                tone === 'warn'
                  ? COLOR_WARN
                  : tone === 'error'
                    ? COLOR_OVER
                    : 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 600,
              textAlign: 'right',
            },
          },
          value,
        ),
      )
    }

    function sectionTitle(text) {
      return h(
        'div',
        {
          key: `t-${text}`,
          style: {
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--dsw-alias-label-secondary)',
            marginBottom: '4px',
          },
        },
        text,
      )
    }

    function sectionOf(title, children) {
      return h('div', { key: title, style: { marginTop: '12px' } }, sectionTitle(title), children)
    }

    /**
     * 今日各对话花费。
     * 收起时只露最高的一条，点开列出当天全部对话；有子代理的行再点一下展开明细。
     */
    function conversationSection(options) {
      const conversations = Array.isArray(options.conversations) ? options.conversations : []
      const count = Number.isInteger(options.count) ? options.count : conversations.length
      if (conversations.length === 0) {
        return sectionOf('今日各对话花费', rowOf('状态', '今天还没有用量'))
      }
      const top = conversations[0]
      const header = h(
        'button',
        {
          type: 'button',
          onClick: options.onToggleExpanded,
          'data-dsh-balance': 'conversations-toggle',
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            width: '100%',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '7px',
            background: 'transparent',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: '11px',
            padding: '4px 7px',
            cursor: 'pointer',
            textAlign: 'left',
          },
        },
        h(
          'span',
          { style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0, flex: 1 } },
          h(
            'span',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            top.title,
          ),
          h(
            'span',
            {
              style: {
                flex: 'none',
                color: 'var(--dsw-alias-label-primary)',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              },
            },
            `¥${money(top.costCNY)}`,
          ),
        ),
        h(
          'span',
          { style: { flex: 'none', color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 } },
          options.expanded ? '收起' : `展开 ${count} 个`,
        ),
      )
      const list = options.expanded
        ? h(
            'div',
            { style: { marginTop: '6px', maxHeight: '240px', overflowY: 'auto' } },
            conversations.map((row) => {
              const rowExpanded = options.expandedRow === row.id
              const clickable = row.subagentCount > 0
              return h(
                'div',
                {
                  key: row.id,
                  style: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '5px 0 4px' },
                },
                h(
                  'div',
                  {
                    role: clickable ? 'button' : undefined,
                    onClick: clickable ? () => options.onToggleRow(row.id) : undefined,
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '8px',
                      cursor: clickable ? 'pointer' : 'default',
                    },
                  },
                  h(
                    'span',
                    {
                      title: row.title,
                      style: {
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '12px',
                      },
                    },
                    row.title,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        flex: 'none',
                        fontSize: '12px',
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                      },
                    },
                    `¥${money(row.costCNY)}`,
                  ),
                ),
                h(
                  'div',
                  {
                    style: {
                      fontSize: '10px',
                      lineHeight: '15px',
                      color: 'var(--dsw-alias-label-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  `${shortNumber(row.totalTokens)} tokens · ${row.requests} 次请求` +
                    (row.subagentCount > 0 ? ` · 含 ${row.subagentCount} 个子代理` : '') +
                    (row.untitled === true ? ' · 名称待补' : ''),
                ),
                rowExpanded
                  ? row.subagents.map((subagent) =>
                      h(
                        'div',
                        {
                          key: subagent.id,
                          style: {
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: '8px',
                            paddingLeft: '10px',
                            marginTop: '3px',
                            fontSize: '11px',
                            color: 'var(--dsw-alias-label-secondary)',
                          },
                        },
                        h(
                          'span',
                          {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          `子代理 ${subagent.title}`,
                        ),
                        h(
                          'span',
                          { style: { flex: 'none', fontVariantNumeric: 'tabular-nums' } },
                          `¥${money(subagent.costCNY)}`,
                        ),
                      ),
                    )
                  : null,
              )
            }),
          )
        : null
      return sectionOf('今日各对话花费', h('div', null, header, list))
    }

    /** 抬头那张渐变卡。 */
    function heroCard(snapshot) {
      const balanceText = snapshot.primary ? money(Number(snapshot.primary.balance)) : '--'
      const bonusText = snapshot.bonus ? money(Number(snapshot.bonus.balance)) : null
      const compare =
        snapshot.avg === null
          ? '还没有足够的历史可比'
          : `近 7 日均值 ¥${money(snapshot.avg)}`
      const ratioText =
        snapshot.ratio === null ? '' : `占均值 ${Math.round(snapshot.ratio * 100)}%`
      return h(
        'div',
        {
          style: {
            position: 'relative',
            padding: '14px 14px 12px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #06276f 0%, #1f5ad0 58%, #5c9bff 100%)',
            color: '#ffffff',
            boxShadow: '0 8px 20px rgba(8, 48, 144, 0.28)',
            overflow: 'hidden',
          },
        },
        h(
          'div',
          {
            style: {
              position: 'absolute',
              right: '-18px',
              top: '-24px',
              width: '92px',
              height: '92px',
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.12)',
            },
          },
          null,
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '8px',
              opacity: 0.82,
              fontSize: '11px',
            },
          },
          h('span', null, '可用余额'),
          bonusText === null ? null : h('span', null, `赠送 ¥${bonusText}`),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: '2px',
              margin: '2px 0 8px',
            },
          },
          h('span', { style: { fontSize: '15px', fontWeight: 600, opacity: 0.9 } }, '¥'),
          h(
            'span',
            { style: { fontSize: '27px', fontWeight: 700, letterSpacing: '-0.02em' } },
            balanceText,
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              gap: '8px',
              fontSize: '11px',
              opacity: 0.9,
              marginBottom: '4px',
            },
          },
          h('span', null, `今日 ¥${money(snapshot.spent)}`),
          h('span', null, ratioText === '' ? compare : `${ratioText}，${compare}`),
        ),
        bar(snapshot, {
          height: '5px',
          track: 'rgba(255, 255, 255, 0.22)',
          radius: '3px',
          fill: snapshot.level === 'over' ? '#ff8f8f' : snapshot.level === 'warn' ? '#ffd166' : '#bcd8ff',
        }),
      )
    }

    /** 当前计费时段的提示条：空闲半价还是高峰全价，下一次什么时候切换。 */
    function tariffBanner(tariff) {
      const text = tariffText(tariff)
      if (text === '') return null
      const peak = tariff.peak === true
      return h(
        'div',
        {
          'data-dsh-balance': 'tariff',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '8px',
            padding: '4px 7px',
            borderRadius: '7px',
            fontSize: '10.5px',
            lineHeight: '15px',
            color: peak ? COLOR_WARN : 'var(--dsw-alias-label-secondary)',
            background: peak
              ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)'
              : 'color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)',
          },
        },
        h('span', {
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flex: 'none',
            background: peak ? COLOR_WARN : COLOR_IDLE_DOT,
          },
        }),
        h('span', { style: { minWidth: 0 } }, text),
      )
    }

    /** 明细面板。 */
    function Panel() {
      const state = useStore()
      const [conversationsExpanded, setConversationsExpanded] = React.useState(false)
      const [expandedConversation, setExpandedConversation] = React.useState(null)
      React.useEffect(() => {
        if (!state.open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest('[data-dsh-balance]')) {
            return
          }
          patch({ open: false })
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') patch({ open: false })
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state.open])
      if (!state.open) return null

      const snapshot = readSnapshot()
      const day = snapshot.day
      const usage = state.sessionUsage
      const pressure = state.contextPressure
      const sessionTotal = usage
        ? usage.uncachedInputTokens +
          usage.outputTokens +
          usage.cacheReadTokens +
          usage.cacheWriteTokens
        : null
      const occupancy =
        pressure && typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
          ? Math.min(
              100,
              Math.round(
                ((pressure.projectedTokens ?? pressure.pressureTokens ?? 0) /
                  pressure.contextWindow) *
                  100,
              ),
            )
          : null
      const conversations =
        state.today && Array.isArray(state.today.conversations) ? state.today.conversations : []
      const conversationCount =
        state.today &&
        state.today.conversationSummary &&
        Number.isInteger(state.today.conversationSummary.count)
          ? state.today.conversationSummary.count
          : conversations.length

      return h(
        'div',
        {
          'data-dsh-balance': 'panel',
          style: {
            position: 'fixed',
            left: '12px',
            bottom: '104px',
            width: '300px',
            maxHeight: 'calc(100vh - 140px)',
            overflowY: 'auto',
            zIndex: 60,
            pointerEvents: 'auto',
            padding: '12px',
            borderRadius: '14px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-overlay)',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.22)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '10px',
            },
          },
          h('div', { style: { fontSize: '13px', fontWeight: 700 } }, '余额与用量'),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void refresh(),
              disabled: state.loading,
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontFamily: 'inherit',
                fontSize: '11px',
                padding: '2px 7px',
                cursor: state.loading ? 'default' : 'pointer',
              },
            },
            state.loading ? '刷新中' : '刷新',
          ),
        ),
        tariffBanner(state.today && state.today.tariff),
        state.balanceError ? rowOf('余额状态', state.balanceError, 'warn') : heroCard(snapshot),
        sectionOf(
          '今日累计（全部会话）',
          state.todayError
            ? rowOf('状态', state.todayError, 'warn')
            : h(
                'div',
                null,
                day
                  ? [
                      rowOf('Token 合计', shortNumber(day.totalTokens)),
                      rowOf('输入（未命中缓存）', shortNumber(day.uncachedInputTokens)),
                      rowOf('输入（命中缓存）', shortNumber(day.cacheReadTokens)),
                      rowOf('输出', shortNumber(day.outputTokens)),
                      rowOf('请求数', String(day.requests)),
                      store.today && store.today.pending > 0
                        ? rowOf('后台扫描', `还剩 ${store.today.pending} 个会话`, 'warn')
                        : null,
                      day.unpricedModels && day.unpricedModels.length > 0
                        ? rowOf('未定价模型', day.unpricedModels.join('、'), 'warn')
                        : null,
                    ]
                  : [rowOf('Token 合计', '--')],
              ),
        ),
        state.today && state.today.conversationSummary
          ? conversationSection({
              conversations,
              count: conversationCount,
              expanded: conversationsExpanded,
              expandedRow: expandedConversation,
              onToggleExpanded: () => setConversationsExpanded((value) => !value),
              onToggleRow: (id) =>
                setExpandedConversation((current) => (current === id ? null : id)),
            })
          : null,
        sectionOf(
          '本次会话',
          sessionTotal === null
            ? rowOf('状态', '当前没有打开的会话')
            : h(
                'div',
                null,
                rowOf('Token 合计', shortNumber(sessionTotal)),
                occupancy === null ? null : rowOf('上下文占用', `${occupancy}%`),
              ),
        ),
        h(
          'div',
          {
            style: {
              marginTop: '12px',
              paddingTop: '8px',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              fontSize: '10px',
              lineHeight: 1.5,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          '进度条按今日花费相对最近 7 天日均显示，没开机用量的日子不计入均值。花费按 DeepSeek 官方价目估算，法定节假日按高峰计价，只会偏高。对话花费按当天会话日志累计，子代理的花费并入发起它的对话。',
        ),
      )
    }

    /** 会话探针：只把当前会话的投影抄进共享状态，什么都不渲染。 */
    function SessionProbe({ sessionId, useProjection }) {
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
      const pressure =
        typeof useProjection === 'function' ? useProjection('contextPressure') : undefined
      React.useEffect(() => {
        patch({
          sessionId: sessionId ?? null,
          sessionUsage: usage ?? null,
          contextPressure: pressure ?? null,
        })
      }, [sessionId, usage, pressure])
      React.useEffect(
        () => () => {
          patch({ sessionId: null, sessionUsage: null, contextPressure: null })
        },
        [],
      )
      return null
    }

    function apply(ctx) {
      // 先把第一次取数发出去。这一句必须排在最前面：下面任何一句抛异常，
      // 都不会再让它被跳过，否则界面会永远停在“取不到数据”。
      void refresh()
      try {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'balance-widget', order: 10 }, Trigger),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'balance-widget-panel', order: 90 }, Panel),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'balance-widget-probe', order: 90 },
            SessionProbe,
          ),
        )
        // 定时器用浏览器原生 setInterval，不用 ctx.interval。
        // ctx.interval 需要先声明 timer 服务依赖，否则读取即抛错；
        // 本机另一个能正常工作的插件也是用原生 setInterval。
        ctx.effect(() => {
          const timer = window.setInterval(() => void refresh(), 60000)
          return () => window.clearInterval(timer)
        }, 'balance-widget: poll')
      } catch (error) {
        if (typeof console !== 'undefined') console.error('balance-widget: apply failed', error)
      }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
