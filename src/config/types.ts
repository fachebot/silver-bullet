// 配置相关类型定义
// 结构与 Pine 指标 input.* 一一对应，默认值见 default.ts

import type BigNumber from 'bignumber.js'

// FVG 过滤模式（对应 Pine 的 choice 选项）
export type FvgMode =
  | 'All FVG'
  | 'Only FVG in the same direction of trend'
  | 'Strict'
  | 'Super-Strict'

// 目标会话选项（对应 Pine 的 opt 选项）
export type TargetOption = 'previous session (any)' | 'previous session (similar)'

// 品种类型（对应 Pine 的 syminfo.type，用于计算 minimum_trade_framework）
export type SyminfoType = 'stock' | 'futures' | 'index' | 'forex' | 'crypto' | 'fund'

// 摆动点设置（对应 Pine: left）
export interface SwingsConfig {
  left: number
}

// FVG 设置（对应 Pine: choice / extend）
export interface FvgConfig {
  mode: FvgMode
  extend: boolean
}

// 目标支撑/阻力设置（对应 Pine: opt / keep）
export interface TargetsConfig {
  sessionOption: TargetOption
  keepLines: boolean
}

// 数据源设置（非 Pine 指标输入，独立分组）
export interface DataConfig {
  exchange: string // 交易所标识（当前支持: binance）
  symbol: string
  interval: string
  startTime: number | null
  endTime: number | null
  syminfoType: SyminfoType
  baseUrl: string | null // 覆盖交易所默认 base URL（空则用内置默认）
  proxyUrl: string | null // HTTP/SOCKS 代理，如 http://127.0.0.1:7890、socks5://127.0.0.1:1080
  proxyUsername: string | null // 代理认证（可选）
  proxyPassword: string | null // 代理认证（可选）
  refresh: boolean
}

// 实时监控配置（非 Pine 指标输入）
export interface LarkMonitorConfig {
  appId: string
  appSecret: string
  baseUrl: string // https://open.feishu.cn 或 https://open.larksuite.com
  userIdType: 'open_id' | 'union_id' | 'user_id'
  urgentOpenIds: string[] // 告警目标（应用内加急）
}

export interface MonitorConfig {
  symbols: string[] // 监控币种
  warmupDays: number // 启动预热历史天数
  pollSeconds: number // REST 轮询间隔（秒），0 = 关闭（WS 兜底）
  useWebSocket: boolean // 是否订阅 WS（fstream 可能被网络封锁，可关）
  notifySessionBoundary: boolean // 会话开始/结束时 Lark 加急通知（整点）
  lark: LarkMonitorConfig
}

// 日志配置（winston）
export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly'

export interface LoggingConfig {
  level: LogLevel
  dir: string // 日志目录
  maxSizeMb: number // 单文件超过即滚动
  maxFiles: number // 保留文件数
  zipped: boolean // 滚动后是否压缩
}

// 市场交易日历配置（FinCal API + 本地降级）
export interface MarketCalendarConfigCfg {
  statusApiBase: string // FinCal API base（https://fincalapi.com）
  apiKey: string // FinCal API key（fincal_live_...），空则仅本地规则
  cacheSeconds: number // 同市场状态缓存秒数
  useLocalFallback: boolean // API 失败时降级本地规则
}

// 用户配置文件（config.json 的结构）
export interface Config {
  swings: SwingsConfig
  fvg: FvgConfig
  targets: TargetsConfig
  data: DataConfig
  monitor: MonitorConfig
  logging: LoggingConfig
  market: MarketCalendarConfigCfg
}

// 加载配置后解析出的运行期配置（含派生布尔值与数据层结果）
export interface DerivedConfig {
  left: number
  mode: FvgMode
  // 派生布尔值（对应 Pine 的 superstrict / iTrend / strict / stricty / prev）
  superstrict: boolean
  iTrend: boolean
  strict: boolean
  stricty: boolean
  extend: boolean
  prev: boolean
  keep: boolean
  syminfoType: SyminfoType
  // 数据层结果：最低交易框架（Pine: minimum_trade_framework）
  minimumTradeFramework: BigNumber
}