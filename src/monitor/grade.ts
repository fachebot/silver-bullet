// FVG 质量分级：按创建 bar 的收盘在其自身区间中的「顺势端」占比分级
//
// 说明：早期实现按 close 相对 FVG 缺口边界（top/bottom）分级，但创建 bar 必然
//   close ≥ low = 缺口上沿（bull）/ close ≤ high = 缺口下沿（bear），永远落在“强侧”，
//   导致 2★/1★ 分支不可达。故改用「收盘动量分位」口径。
//
// 规则：
//   strong = bull ? close − low : high − close   （收盘距顺势端突破边的距离）
//   range  = high − low
//   逆势（仅 All FVG 模式可能）→ ⭐ 逆势（封顶）
//   range = 0（平 K）        → ⭐ 弱
//   3·strong ≥ 2·range       → ⭐⭐⭐ 强
//   3·strong ≥ 1·range       → ⭐⭐ 中
//   其余                     → ⭐ 弱
//
// 用整数比较（3·strong vs 2·range/range）避免浮点误差。

import type BigNumber from 'bignumber.js'

export interface FvgGrade {
  stars: 1 | 2 | 3
  label: string
}

const LABEL_STRONG = '强'
const LABEL_MEDIUM = '中'
const LABEL_WEAK = '弱'
const LABEL_COUNTER_TREND = '逆势'

export function gradeFvg(
  trend: number,
  type: 'bull' | 'bear',
  close: BigNumber,
  high: BigNumber,
  low: BigNumber,
): FvgGrade {
  const bullish = type === 'bull'
  // 顺势判定与引擎 iTrend 一致：bull 需 trend==1，bear 需 trend≠1
  const withTrend = bullish ? trend === 1 : trend !== 1
  if (!withTrend) return { stars: 1, label: LABEL_COUNTER_TREND }

  const range = high.minus(low)
  if (range.lte(0)) return { stars: 1, label: LABEL_WEAK }

  const strong = bullish ? close.minus(low) : high.minus(close)
  const s3 = strong.times(3)
  if (s3.gte(range.times(2))) return { stars: 3, label: LABEL_STRONG }
  if (s3.gte(range)) return { stars: 2, label: LABEL_MEDIUM }
  return { stars: 1, label: LABEL_WEAK }
}
