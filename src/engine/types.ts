// 引擎内部类型：对应 Pine 指标中的 UDT 与 var 全局状态
// 对照来源（ict-silver-bullet.pine）：
//   type piv / ZZ / FVG / actLine / aPiv

import type BigNumber from 'bignumber.js'

// Pine `type piv`：摆动点记录（br 字段原指标未使用，保留以对齐结构）
export interface Piv {
  b: number // bar_index
  p: BigNumber // 价格
  br: boolean
}

// Pine `type ZZ`：ZigZag 环形缓冲（容量 maxSize=250，unshift+pop 保持最新在前）
export interface ZZ {
  d: number[] // 方向：1=摆动高点, -1=摆动低点, 0=初始
  x: number[] // bar_index
  y: (BigNumber | null)[] // 价格（Pine 的 na → null）
}

// FVG box：数据模式下 left/right 为 bar 索引，top/bottom 为价格
export interface Box {
  left: number
  top: BigNumber
  right: number
  bottom: BigNumber
}

// Pine `type FVG`
export interface FVG {
  box: Box
  active: boolean
  current: boolean
  id: number // 输出用唯一编号
}

// 目标线（输出用）：记录某次会话结束时生成的支撑/阻力水平线
export interface TargetLine {
  session: string
  kind: 'res' | 'sup'
  level: BigNumber
  swingBar: number // 摆动点所在 bar
  endBar: number // 会话结束 bar（生成时刻）
  brokenBar: number | null // 被突破的 bar（null 表示未突破）
  brokenTime: number | null
}

// Pine `type actLine`：活跃目标线（用于每日延伸与突破检测）
export interface ActLine {
  y: BigNumber
  active: boolean
  target: TargetLine | null // 反向关联输出目标线（突破时标记）
}

// Pine `type aPiv` 中某一会话的一组字段 + f_swings 内的 `var` 变量
export interface SessionState {
  swingH: Piv[]
  swingL: Piv[]
  mnPiv: BigNumber // 会话内最小摆动低点（初始 10e6）
  mxPiv: BigNumber // 会话内最大摆动高点（初始 0）
  mssDir: number // f_swings 内部的 `var int MSS_dir`（按调用点独立持久）
  targets: TargetLine[]
}

// 会话标识
export type SessionKey = 'GN' | 'LN' | 'AM' | 'PM'

// 引擎全局持久状态（对应 Pine 的顶层 `var` 变量）
export interface EngineState {
  a: Record<SessionKey, SessionState>
  aZZ: ZZ
  bFVG_bull: FVG[]
  bFVG_bear: FVG[]
  min: BigNumber // 全局 min（激活 bull FVG 底部累计）
  max: BigNumber // 全局 max（激活 bear FVG 顶部累计）
  hilo0: BigNumber // 会话内最高价（对应 hilo.get(0)）
  hilo1: BigNumber // 会话内最低价（对应 hilo.get(1)）
  trend: number // aTrend
  highs: ActLine[] // 活跃阻力线
  lows: ActLine[] // 活跃支撑线
  nextFvgId: number
}