// FVG 质量分级：在 All FVG 模式下，按创建 bar 的趋势与 close 相对 FVG box 的位置分级

import type BigNumber from 'bignumber.js'

export interface FvgGrade {
  stars: 1 | 2 | 3
  label: string
}

// 分级规则（与用户确认）：
//   - 逆势（bull 需 trend≠1；bear 需 trend==1）→ ⭐ All FVG（仅 All FVG 模式会创建）
//   - 顺势 且 close 在 box 强侧（bull: close ≥ top；bear: close ≤ bottom）→ ⭐⭐⭐ Super-Strict
//   - 顺势 且 close 在 box 内（bull: bottom ≤ close < top；bear: bottom < close ≤ top）→ ⭐⭐ Strict
//   - 顺势 且 close 在 box 弱侧（bull: close < bottom；bear: close > top）→ ⭐ Only FVG in the same direction of trend
//
// 说明：bull 的 box top=更高价（形成 bar low）、bottom=更低价（high[2]）；bear 对称。
export function gradeFvg(
  trend: number,
  type: 'bull' | 'bear',
  close: BigNumber,
  top: BigNumber,
  bottom: BigNumber,
): FvgGrade {
  const bullish = type === 'bull'
  // 顺势判定与指标 iTrend 一致：bull 需 trend==1，bear 需 trend≠1
  const withTrend = bullish ? trend === 1 : trend !== 1
  if (!withTrend) return { stars: 1, label: 'All FVG' }

  if (bullish) {
    if (close.gte(top)) return { stars: 3, label: 'Super-Strict' }
    if (close.gte(bottom)) return { stars: 2, label: 'Strict' }
    return { stars: 1, label: 'Only FVG in the same direction of trend' }
  }
  // bear
  if (close.lte(bottom)) return { stars: 3, label: 'Super-Strict' }
  if (close.lte(top)) return { stars: 2, label: 'Strict' }
  return { stars: 1, label: 'Only FVG in the same direction of trend' }
}