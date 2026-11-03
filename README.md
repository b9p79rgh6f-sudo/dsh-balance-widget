# 余额与用量挂件 / Balance & Usage Widget for DSH

DSH 侧边栏底部的常驻小挂件：显示 DeepSeek 账户余额、今日 token 用量与估算花费，点开还能看今天每个对话花了多少钱，以及当前处在高峰还是空闲计费时段。

## 界面

- **侧边栏底部**：一行余额数字，后面跟着今日花费；右边一个小标签写着「空闲半价」或「高峰全价」，前面的圆点空闲是绿色、高峰是黄色。
- **点开面板**：余额卡与今日花费进度条（相对最近 7 天日均），今日累计 token、请求数，每个对话的花费（子代理并进发起它的对话），以及下一次计费时段切换的时间。

## 数据从哪来

- **余额**：DSH 官方的账户服务 `deepseekAccount`，读的是充值余额与赠送余额两个钱包，不经过任何第三方。
- **今日用量**：宿主侧扫描每个会话日志里带 `usage` 的 `assistant/message` 事件，按事件时间归到北京时间的某一天，结果缓存在 `~/.dsh/storages/balance-widget-cache.json`。
- **花费**：按 DeepSeek 官方价目从 token 折算，**是估算，不是账单**。价目取自官方文档，抓取日期 2026-11-03；官方调价后需要改 `index.js` 里的 `PRICES`。
- **计费时段**：北京时间周一至周五 9:00-12:00 与 14:00-18:00 是高峰，其余时段半价。法定节假日这里仍按工作日算，所以估算只会偏高。

## 安装

从插件市场安装，或者：

```sh
dsh plugin --profile <profile> add @b9p79rgh6f-sudo/dsh-balance-widget
```

也可以直接从 GitHub 装：

```sh
dsh plugin --profile <profile> add github:b9p79rgh6f-sudo/dsh-balance-widget
```

装完刷新页面（宿主页有改动时重启 DSH）。

## 依赖

- DSH Web 0.2.x 及以上（用到 `sidebar.footer.action` 与 `shell.overlay` 槽位、`deepseekAccount` 服务）。
- 读用量需要会话日志和官方账户服务都可用；登录状态下才能显示余额。

## 开发

`tools/` 下是开发时用的自查脚本，其中 `test-client-render.mjs` 用假的 React 桩渲染界面，不需要启动 DSH；`verify-usage.py` 会直接读本机会话日志重算一遍用量和花费，用来和面板数字对账。这些脚本依赖本机的会话日志，换台机器不一定能直接跑。

---

# Balance & Usage Widget for DSH

A persistent widget at the DSH sidebar foot: account balance, today's token usage and estimated spend, a panel with per-conversation cost for the day, and the current peak/idle pricing window.

Balance comes from DSH's official `deepseekAccount` service (no third party). Usage is folded host-side from `assistant/message` usage events into Beijing-time days and cached under `~/.dsh/storages/balance-widget-cache.json`. Cost is estimated from DeepSeek's official price table (captured 2026-11-03) — an estimate, not a bill. Peak hours are Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time; everything else is half price.

The sidebar dot is green during idle (half-price) hours and yellow during peak hours.

Install from the plugin market, or:

```sh
dsh plugin --profile <profile> add @b9p79rgh6f-sudo/dsh-balance-widget
dsh plugin --profile <profile> add github:b9p79rgh6f-sudo/dsh-balance-widget
```

MIT licensed.
