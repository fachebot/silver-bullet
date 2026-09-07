// ta.pivothigh / ta.pivotlow 的等价实现
// 语义（与 Pine 内置函数一致，参考社区逐 bar 对拍实现）：
//   在当前 bar n 上，候选 pivot bar 为 n - right。
//   候选须为窗口 [n-left-right, n] 内的最值，且：
//     - pivothigh：候选是窗口内"最后一次"出现的最大值
//       → 右侧 right 根都严格低于候选，左侧 left 根可相等
//     - pivotlow：候选是窗口内"第一次"出现的最小值
//       → 右侧 right 根都严格高于候选，左侧 left 根可相等
//   返回候选的 high/low 值；未命中返回 null（对应 Pine 的 na）。
// 注：原指标调用为 ta.pivothigh(left, 1)，故候选 bar 恒为 n-1。

import type BigNumber from 'bignumber.js'

// 判定 bar n-1 是否为 pivot high，返回其 high 值或 null
export function pivotHighAt(
  n: number,
  left: number,
  right: number,
  highs: BigNumber[],
): BigNumber | null {
  if (n < left + right) return null // 窗口历史不足
  const cand = n - right
  const ph = highs[cand]
  // 右侧（严格小于候选）
  for (let k = 1; k <= right; k++) {
    if (highs[cand + k].gte(ph)) return null
  }
  // 左侧（可等于候选）
  for (let k = 1; k <= left; k++) {
    if (highs[cand - k].gt(ph)) return null
  }
  return ph
}

// 判定 bar n-1 是否为 pivot low，返回其 low 值或 null
export function pivotLowAt(
  n: number,
  left: number,
  right: number,
  lows: BigNumber[],
): BigNumber | null {
  if (n < left + right) return null
  const cand = n - right
  const pl = lows[cand]
  // 右侧（严格高于候选）
  for (let k = 1; k <= right; k++) {
    if (lows[cand + k].lte(pl)) return null
  }
  // 左侧（可等于候选）
  for (let k = 1; k <= left; k++) {
    if (lows[cand - k].lt(pl)) return null
  }
  return pl
}