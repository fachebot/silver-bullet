# ICT Silver Bullet 实时监控系统

LuxAlgo **ICT Silver Bullet**（`ict-silver-bullet.pine`）的 TypeScript 实现，以**实时监控**为核心：订阅 Binance 合约 5m K 线，在 killzone（LN/AM/PM）内检测收盘新 FVG 并即时推送 **Lark 应用内加急**通知；同时保留批量信号引擎，可拉历史数据运行同一引擎输出 JSON 供研究。

- **实时监控（主）** `npm run monitor`：长驻运行，WS + REST 双通道，自动重连补数，告警即推 Lark
- **批量信号引擎（次）** `npm start`：拉历史 → 引擎 → 输出 JSON（与研究对照/回看用）
- 价格/金额计算统一使用 [bignumber.js](https://mikemcl.github.io/bignumber.js/)（精确十进制字符串），会话时间基于 `America/New_York`（Luxon 处理 DST）
- **支持 HTTP / SOCKS4 / SOCKS5（含 socks5h）代理**，可穿透受限网络
- winston 日志（控制台 + 按日滚动文件）；配置化 `config.json`，`zod` 启动校验

## 功能总览

| 能力 | 说明 |
|---|---|
| Killzone FVG 告警 | 会话内 5m 收盘产生 FVG → Lark 加急，附质量星级 |
| 会话边界通知 | LN/AM/PM 开始/结束在 **NY 整点**精确通知（每边界一次、全局加急） |
| 市场开闭状态 | 每条通知附当前对应市场是否开盘（FinCal API + 本地规则降级，含半天日） |
| 高可用数据链路 | 单条合并 WebSocket + 断线指数退避重连 + 重连后 REST 补数 + REST 轮询兜底 |
| 多币种去重 | 跨通道共享 `lastProcessed`，绝不重复告警 |
| 批量分析 | 同一引擎离线跑任意历史区间，输出完整 JSON（pivot/zigzag/FVG/MSS/目标线/信号） |

## 快速开始

```bash
npm install
cp config.json.sample config.json   # 复制配置模板并填写（代理、Lark 凭据、FinCal key）
npm run monitor    # 实时监控（主流程，长驻运行）
npm start          # 批量信号引擎：拉数据 → 运行 → 输出 JSON 到 output/
npm test           # 运行测试
npm run typecheck  # 类型检查
```

> `config.json` 含本机代理/Lark 凭据/FinCal key 等敏感配置，**不入库**（已在 `.gitignore`）；`config.json.sample` 为提交的模板。若未复制 `config.json`，各命令会因读取失败报错。

> Binance API 在部分网络环境下可能无法访问，需在可访问的环境运行（可用 `data.proxyUrl` 走代理）。

## 实时监控（npm run monitor）

### 架构

长驻进程，`monitor.symbols` 各币种通过**一条合并 WebSocket 连接**（`wss://fstream.binance.com/market/stream?streams=<sym>@kline_5m/...`，注意 2026-04-23 起旧 `/stream`、`/ws` 路径已退役）订阅 5m K 线（走 `data.proxyUrl` 代理）；启动时用最近 `warmupDays` 天历史预热引擎状态。每当一根 K 线收盘且处于 killzone（LN/AM/PM）内并产生新 FVG，就向 Lark 发送**应用内加急**消息。

WS 断线自动重连（指数退避 1s→60s 封顶，`error` 也触发重连）；重连成功后用 REST 补拉断线期间收盘的 bar，避免漏报。

### Killzone FVG 告警

引擎以 `fvg.mode=All FVG` 运行，对每个 FVG 按创建 bar 的趋势与收盘价相对 FVG 范围分级，用 ⭐ 表示：

| 条件 | 星级 | 标签 |
|---|---|---|
| 逆势（仅 All FVG 会创建） | ⭐ | All FVG |
| 顺势 且收盘在 FVG 强侧 | ⭐⭐⭐ | Super-Strict |
| 顺势 且收盘在 FVG 内 | ⭐⭐ | Strict |
| 顺势 且收盘在 FVG 弱侧 | ⭐ | Only FVG in the same direction of trend |

消息示例：

```
🚨 KILLZONE FVG · BTCUSDT
会话：LN（03-04 NY）
时间：2026-09-07 15:35（北京）
现价：64310.4
方向：看涨 FVG
范围：64281.4 ~ 64310.4
质量：⭐⭐⭐ Super-Strict
纽约早盘：当前已开盘
```

### 会话边界通知

`monitor.notifySessionBoundary`（默认开）在 **America/New_York 整点**精确通知 LN/AM/PM 会话开始与结束（每边界一次、全局加急）：

```
🔔 LN 会话开始 LN（03-04 NY）
时间：2026-09-07 15:00（北京）
伦敦盘：当前已开盘
```

### 市场开闭状态

所有通知（FVG 告警与会话边界）都附带**当前时刻对应市场是否开盘**——LN 会话显示伦敦盘（LSE），AM/PM 会话显示纽约盘（NYSE）。判定时刻为通知实际触发时刻，因此**半天日**（如美股感恩节次日 13:00 收市、LSE 平安夜 12:30 收市）在过收盘点后即显示"已收市"。

状态来源（`market` 配置）：优先调用 **FinCal API**（`https://fincalapi.com/v1/day_status`，免费注册获取 `fincal_live_` key 填到 `market.apiKey`，走 `data.proxyUrl` 代理），支持 **NYSE 与 LSE** 两个市场日历，`close_time` 给出半天日收盘时刻。`useLocalFallback`（默认开）在 API 不可用或未配置 key 时降级为**内置本地节假日规则**（美股/伦敦法定假日 + 半天日 + 周末顺延，纯计算无年份表）。`cacheSeconds` 为同市场状态缓存秒数。

### REST 轮询兜底

`monitor.pollSeconds`（默认 5s）REST 轮询兜底——每轮拉取最近 K 线检测新收盘 bar；与 WS 共享 `lastProcessed` 去重，不会重复告警。WS 正常时可设 `monitor.pollSeconds: 0` 关闭轮询、纯 WS 运行。

### Lark 配置

`config.json` 的 `monitor.lark`：需要**企业自建应用**机器人（app_id/app_secret），配置 `urgentOpenIds`（告警目标的 open_id）。加急流程：发送消息到用户 → `urgent_app` 应用内加急。baseUrl 默认 `https://open.larksuite.com`（海外版），国内版用 `https://open.feishu.cn`。

```jsonc
"monitor": {
  "symbols": ["BTCUSDT", "ETHUSDT"],
  "warmupDays": 30,
  "lark": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "baseUrl": "https://open.larksuite.com",
    "userIdType": "open_id",
    "urgentOpenIds": ["ou_xxx"]
  }
}
```

辅助脚本：
- `npx tsx scripts/get-openid.ts`：用手机号/邮箱反查用户 open_id（`batch_get_id`）
- `npx tsx scripts/test-lark.ts`：发送一条加急测试消息验证链路连通

## 信号引擎（npm start）

拉取历史 K 线（支持本地缓存与 `refresh` 强制刷新）运行引擎，输出完整 JSON 到 `output/<symbol>_<interval>_<时间戳>.json`，并在控制台打印运行摘要（会话数、pivot、FVG、目标线、突破信号、MSS 等）。适用于对任意历史区间做离线分析/对照 TradingView 图表。

### 输出结构

```jsonc
{
  "meta": { "symbol", "interval", "barCount", "startTime", "endTime" },
  "sessions": [ { "session": "LN", "startBar", "startTime", "endBar", "endTime" } ],
  "pivots":   [ { "kind": "high|low", "bar", "time", "price": "150.00" } ],
  "zigzag":   [ { "dir": 1|-1, "bar", "time", "price" } ],
  "fvgs":     [ { "id", "type": "bull|bear", "left", "right", "top", "bottom",
                  "current", "active", "events": [ { "event", "bar", "time" } ] } ],
  "targets":  [ { "session", "kind": "res|sup", "level", "swingBar", "endBar", "brokenBar" } ],
  "mss":      [ { "session", "direction": 1|-1, "bar", "time", "timeBjt" } ],
  "trend":    [ { "bar", "time", "value": 1|0|-1 } ],
  "signals":  [ { "type": "targetHi|targetLo", "bar", "time" } ]
}
```

FVG 生命周期事件类型：`created`（创建）/ `activated`（回踩激活）/ `invalidated`（Super-Strict 越界失效，隐藏）/ `expired`（会话结束未激活隐藏）/ `closed`（会话结束 strict/superstrict 收盘过滤失败，隐藏）/ `deactivated`（会话结束后第二根 bar 置失效，box 保留不隐藏）。其中 `invalidated`/`expired`/`closed` 对应 Pine 中 box 被设为透明的时刻（图表上不可见）。

### 引擎说明

逐 bar 重放 Pine 逻辑，语义等价点：

- `var` 持久状态 → 引擎类字段跨 bar 保留
- series 回溯（`high[2]`、`is_in_SB[1]`）→ 历史数组
- `na`/`nz` → `null`/`?? 0`
- `ta.pivothigh(left, 1)` → 候选 pivot bar 为 `n-1`，要求左侧 `left` 根可相等、右侧严格更低（详见 `src/engine/pivots.ts`）
- ZigZag 环形缓冲（容量 250，unshift+pop）
- 会话判定：bar 开盘时间 → `America/New_York` 本地时刻，落在 `[start, end)` 区间

## 目录结构

```
src/
  config/     配置加载（默认值、zod 校验、派生布尔）
  data/       数据源抽象层
    exchange.ts    DataSource 接口
    httpClient.ts  代理感知 HTTP 客户端（node-fetch + proxy-agent，含重试）
    cache.ts       通用 K 线本地缓存
    binance.ts     Binance 实现（合并 WS 订阅 + REST）
    index.ts       createDataSource 工厂
  engine/     Pine 语义等价引擎（会话、pivot、ZigZag、MSS、FVG、目标线）
  market/     市场交易日历（本地节假日规则 + FinCal API 状态解析）
  monitor/    实时监控核心（WS 订阅、告警格式化、会话边界调度、市场状态、Lark 发送）
  output/     JSON 序列化
  log/        winston 日志单例
  index.ts    CLI 入口（批量信号引擎）
  monitor-cli.ts  监控 CLI 入口
config.json   用户配置（敏感项不入库）
scripts/      Lark 辅助脚本（get-openid / test-lark）
tests/        单元测试与集成测试
```

## 配置说明（config.json）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `swings.left` | `5` | pivot 左半径（1~20，对应 Pine `left`） |
| `fvg.mode` | `Super-Strict` | 对应 Pine `choice`：All FVG / Only FVG in the same direction of trend / Strict / Super-Strict |
| `fvg.extend` | `true` | 对应 Pine `extend` |
| `targets.sessionOption` | `previous session (similar)` | 对应 Pine `opt`：previous session (any) / previous session (similar) |
| `targets.keepLines` | `true` | 对应 Pine `keep`（仅 [super-]strict 模式生效） |
| `data.symbol` | `BTCUSDT` | 批量引擎币种 |
| `data.interval` | `5m` | 支持 1m/3m/5m/15m/30m/1h/… |
| `data.syminfoType` | `crypto` | 对应 Pine `syminfo.type`（决定 `minimum_trade_framework`） |
| `data.exchange` | `binance` | 数据源标识（当前仅 binance） |
| `data.baseUrl` | `null` | 覆盖交易所默认 API 地址 |
| `data.proxyUrl` | `null` | 代理地址，见"代理配置" |
| `data.proxyUsername` / `data.proxyPassword` | `null` | 代理认证（可选） |
| `monitor.symbols` | `["BTCUSDT","ETHUSDT"]` | 实时监控币种 |
| `monitor.warmupDays` | `30` | 启动预热历史天数 |
| `monitor.pollSeconds` | `5` | REST 轮询兜底间隔（秒），0 = 关闭 |
| `monitor.useWebSocket` | `true` | 是否订阅 WS（fstream 可能被网络封锁，可关） |
| `monitor.notifySessionBoundary` | `true` | 会话开始/结束时 Lark 加急通知（NY 整点） |
| `monitor.lark.*` | — | Lark 应用加急配置（见"实时监控"） |
| `market.statusApiBase` | `https://fincalapi.com` | FinCal API 地址 |
| `market.apiKey` | `` | FinCal API key（`fincal_live_...`，免费注册 fincalapi.com） |
| `market.cacheSeconds` | `300` | 同市场状态缓存秒数 |
| `market.useLocalFallback` | `true` | API 不可用/无 key 时降级本地节假日规则 |
| `logging.level` | `info` | 日志级别（error/warn/info/http/verbose/debug/silly） |
| `logging.dir` | `logs` | 日志目录 |
| `logging.maxSizeMb` | `10` | 单文件超过即滚动 |
| `logging.maxFiles` | `10` | 保留文件数 |
| `logging.zipped` | `false` | 滚动后是否压缩 |

## 日志

使用 [winston](https://github.com/winstonjs/winston) + `winston-daily-rotate-file`，**控制台 + 文件双输出**（可读文本格式，带时间戳与级别）。文件按日期分文件，单文件超过 `maxSizeMb` 自动滚动，`maxFiles` 限制保留数，`zipped` 可选压缩滚动文件。

```
logs/app-2026-09-07.log
2026-09-07 12:15:19.885 [INFO] [配置] exchange=binance symbol=BTCUSDT ...
```

所有模块通过 `src/log/logger.ts` 的模块级单例 `getLogger()` 记录日志（`initLogger` 在 CLI 入口初始化）。

## 代理配置

`data.proxyUrl` 支持以下协议（由 `proxy-agent` 自动识别）：

- HTTP / HTTPS 代理：`http://127.0.0.1:7890`（Clash 默认端口）
- SOCKS5 代理：`socks5://127.0.0.1:1080`
- SOCKS5h（远端 DNS）：`socks5h://127.0.0.1:1080`
- SOCKS4 代理：`socks4://127.0.0.1:1080`

示例（Clash/V2Ray 本地端口）：

```jsonc
"data": {
  "proxyUrl": "http://127.0.0.1:7890"
}
```

需要认证时，可把账号密码写入 URL（`http://user:pass@127.0.0.1:7890`），或使用独立的 `proxyUsername` / `proxyPassword` 字段。

## 接入新交易所

数据源通过 `DataSource` 接口（`src/data/exchange.ts`）抽象，接入新交易所只需两步：

1. 实现接口（可参考 `src/data/binance.ts`）：

```ts
export class OkxSource implements DataSource {
  readonly name = 'okx'
  intervalToMs(interval: string): number { /* ... */ }
  fetchKlines(req: KlineRequest): Promise<Kline[]> { /* ... */ }
  fetchTickSize(symbol: string): Promise<BigNumber> { /* ... */ }
}
```

2. 在工厂 `src/data/index.ts` 中注册：

```ts
case 'okx':
  return new OkxSource({ baseUrl: config.baseUrl, proxy })
```

引擎与 CLI 无需任何改动；HTTP 请求统一走 `createHttpClient(proxy)`，自动获得代理支持与重试。

`minimum_trade_framework` 计算（与 Pine 一致）：
- `forex` → `mintick × 15 × 10`
- `index` / `futures` → `mintick × 40`
- 其他（含 `crypto`）→ `0`