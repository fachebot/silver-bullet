// 单元测试：ta.pivothigh / ta.pivotlow 等价实现
// 语义要点：候选 pivot bar = n - right；右侧须严格更小/更大，左侧可相等

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'
import { pivotHighAt, pivotLowAt } from '../src/engine/pivots.js'

const bn = (n: number) => new BigNumber(n)

describe('pivotHighAt', () => {
  it('识别明显的摆动高点（right=1，候选 bar=n-1）', () => {
    // bar5 高点 150，高于左侧 5 根（0..4）与右侧 1 根（6）
    const highs = [100, 100, 100, 100, 100, 150, 102, 101, 100]
    const ph = pivotHighAt(6, 5, 1, highs.map(bn))
    expect(ph).not.toBeNull()
    expect(ph!.toNumber()).toBe(150)
  })

  it('左侧存在更高点时不是 pivot', () => {
    const highs = [100, 100, 100, 100, 160, 150, 102]
    const ph = pivotHighAt(6, 5, 1, highs.map(bn))
    expect(ph).toBeNull()
  })

  it('右侧更高时尚未确认（历史不足/未被确认返回 null）', () => {
    const highs = [100, 100, 100, 100, 100, 150, 160]
    const ph = pivotHighAt(6, 5, 1, highs.map(bn))
    expect(ph).toBeNull()
  })

  it('左侧可相等（最后一次出现最大值）', () => {
    // 左侧 bar2 与候选 bar5 同为 150 → 仍为 pivot
    const highs = [100, 100, 150, 100, 100, 150, 102]
    const ph = pivotHighAt(6, 5, 1, highs.map(bn))
    expect(ph).not.toBeNull()
    expect(ph!.toNumber()).toBe(150)
  })

  it('右侧相等时不是 pivot（候选须是窗口内最后一次最大）', () => {
    const highs = [100, 100, 100, 100, 100, 150, 150]
    const ph = pivotHighAt(6, 5, 1, highs.map(bn))
    expect(ph).toBeNull()
  })

  it('历史不足（n < left + right）返回 null', () => {
    const highs = [100, 100, 100]
    expect(pivotHighAt(3, 5, 1, highs.map(bn))).toBeNull()
  })
})

describe('pivotLowAt', () => {
  it('识别明显的摆动低点', () => {
    const lows = [110, 110, 110, 110, 110, 90, 108, 109]
    const pl = pivotLowAt(6, 5, 1, lows.map(bn))
    expect(pl).not.toBeNull()
    expect(pl!.toNumber()).toBe(90)
  })

  it('右侧更低时不是 pivot', () => {
    const lows = [110, 110, 110, 110, 110, 90, 85]
    expect(pivotLowAt(6, 5, 1, lows.map(bn))).toBeNull()
  })

  it('左侧可相等', () => {
    const lows = [110, 110, 90, 110, 110, 90, 108]
    const pl = pivotLowAt(6, 5, 1, lows.map(bn))
    expect(pl).not.toBeNull()
  })
})