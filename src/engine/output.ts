// 引擎输出结构：运行后生成的结构化信号/数据

import type BigNumber from 'bignumber.js'

export interface SessionRecord {
  session: 'GN' | 'LN' | 'AM' | 'PM'
  startBar: number
  startTime: number
  endBar: number
  endTime: number
}

export interface PivotRecord {
  kind: 'high' | 'low'
  bar: number
  time: number
  price: BigNumber
}

export interface ZigzagRecord {
  dir: 1 | -1
  bar: number
  time: number
  price: BigNumber | null
}

export type FvgEventType =
  | 'created' // 创建
  | 'activated' // 回踩触发激活
  | 'invalidated' // Super-Strict 下 close 越界立即失效（隐藏）
  | 'expired' // 会话结束未激活被隐藏
  | 'closed' // 会话结束 strict/superstrict 收盘过滤失败（隐藏）
  | 'deactivated' // 会话结束后第二根 bar（endSB[1]）置 active=false（不隐藏，box 保留）

export interface FvgEvent {
  event: FvgEventType
  bar: number
  time: number
}

export interface FvgRecord {
  id: number
  type: 'bull' | 'bear'
  left: number
  right: number
  top: BigNumber
  bottom: BigNumber
  current: boolean
  active: boolean
  events: FvgEvent[]
}

export interface MssRecord {
  session: string // 所属会话（GN/LN/AM/PM）
  direction: 1 | -1
  bar: number
  time: number
}

export interface TrendRecord {
  bar: number
  time: number
  value: number
}

export interface SignalRecord {
  type: 'targetHi' | 'targetLo'
  bar: number
  time: number
}

export interface EngineOutput {
  meta: {
    symbol: string
    interval: string
    barCount: number
    startTime: number
    endTime: number
  }
  sessions: SessionRecord[]
  pivots: PivotRecord[]
  zigzag: ZigzagRecord[]
  fvgs: FvgRecord[]
  targets: Array<{
    session: string
    kind: 'res' | 'sup'
    level: BigNumber
    swingBar: number
    endBar: number
    brokenBar: number | null
    brokenTime: number | null
  }>
  mss: MssRecord[]
  trend: TrendRecord[]
  signals: SignalRecord[]
}

// 增量处理（feedBar）本 bar 新建的 FVG
export interface CreatedFvg {
  id: number
  type: 'bull' | 'bear'
  top: BigNumber
  bottom: BigNumber
}

// feedBar 返回的每根 bar 处理结果（供实时监控）
export interface FedBarResult {
  barIndex: number
  time: number
  close: BigNumber
  trend: number // FVG 创建时使用的趋势（fSetTrend 后、f_swings 前）
  inSb: boolean // 是否处于 killzone
  session: 'LN' | 'AM' | 'PM' | null
  createdFvgs: CreatedFvg[] // 本 bar 新建的 FVG
}