// 监控告警消息格式化（Lark 文本消息）

import type BigNumber from 'bignumber.js'
import { bjt } from '../output/serialize.js'
import type { FvgGrade } from './grade.js'
import type { MarketStatus } from '../market/marketCalendar.js'

export interface FvgAlertInfo {
  symbol: string
  session: 'LN' | 'AM' | 'PM'
  time: number
  close: BigNumber
  fvg: { type: 'bull' | 'bear'; top: BigNumber; bottom: BigNumber }
  grade: FvgGrade
  marketName?: string
  marketStatus?: MarketStatus
}

const SESSION_LABEL: Record<string, string> = {
  LN: 'LN（03-04 NY）',
  AM: 'AM（10-11 NY）',
  PM: 'PM（14-15 NY）',
}

// 市场开闭状态行
export function formatMarketLine(marketName: string, s: MarketStatus): string {
  switch (s.phase) {
    case 'open':
      return `${marketName}：当前已开盘`
    case 'open-early':
      return `${marketName}：当前已开盘（今日半天 ${s.closeTime} 收市）`
    case 'closed':
      return `${marketName}：已收市（${s.closeTime}）`
    case 'closed-early':
      return `${marketName}：已收市（今日半天 ${s.closeTime}）`
    case 'before-open':
      return `${marketName}：尚未开盘（${s.openTime} 开盘）`
    case 'holiday':
      return `${marketName}：今日未开盘（休市）`
  }
}

export function formatFvgAlert(a: FvgAlertInfo): string {
  const direction = a.fvg.type === 'bull' ? '看涨 FVG' : '看跌 FVG'
  const range = `${a.fvg.bottom.toString()} ~ ${a.fvg.top.toString()}`
  const stars = '⭐'.repeat(a.grade.stars)
  const lines = [
    `🚨 KILLZONE FVG · ${a.symbol}`,
    `会话：${SESSION_LABEL[a.session] ?? a.session}`,
    `时间：${bjt(a.time)}（北京）`,
    `现价：${a.close.toString()}`,
    `方向：${direction}`,
    `范围：${range}`,
    `质量：${stars} ${a.grade.label}`,
  ]
  if (a.marketName && a.marketStatus) {
    lines.push(formatMarketLine(a.marketName, a.marketStatus))
  }
  return lines.join('\n')
}

// 会话边界通知（整点触发，加急）
export function formatSessionAlert(
  session: 'LN' | 'AM' | 'PM',
  edge: 'start' | 'end',
  timeMs: number,
  marketName?: string,
  marketStatus?: MarketStatus,
): string {
  const label = SESSION_LABEL[session] ?? session
  const dir = edge === 'start' ? '开始' : '结束'
  const lines = [`🔔 ${session} 会话${dir} ${label}`, `时间：${bjt(timeMs)}（北京）`]
  if (marketName && marketStatus) {
    lines.push(formatMarketLine(marketName, marketStatus))
  }
  return lines.join('\n')
}