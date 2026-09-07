// 健壮性/性能测试：用随机游走行情跑 10 万根 bar，验证引擎不崩溃、输出完整且可序列化

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'
import { Engine } from '../src/engine/engine.js'
import { deriveConfig } from '../src/config/load.js'
import { defaultConfig } from '../src/config/default.js'
import { serialize } from '../src/output/serialize.js'
import type { Kline } from '../src/data/types.js'

// 伪随机数生成器（确定性）
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 生成随机游走 K 线（覆盖 60 天，5m 周期 = 17280 根/天 → 可循环复用时间戳）
function generateBars(count: number, seed = 42): Kline[] {
  const rand = mulberry32(seed)
  const bars: Kline[] = []
  const base = new BigNumber(60000)
  let price = base
  const t0 = Date.UTC(2024, 5, 1, 0, 0)
  const m5 = 300_000
  for (let k = 0; k < count; k++) {
    const drift = (rand() - 0.48) * 80
    const open = price
    const close = price.plus(drift)
    const high = BigNumber.maximum(open, close).plus(rand() * 40)
    const low = BigNumber.minimum(open, close).minus(rand() * 40)
    bars.push({ time: t0 + k * m5, open, high, low, close, volume: new BigNumber(0) })
    price = close
  }
  return bars
}

describe('引擎健壮性', () => {
  it('10 万根 bar 完整运行并输出可序列化 JSON', () => {
    const config = structuredClone(defaultConfig)
    const cfg = deriveConfig(config, new BigNumber('0.1'))
    const bars = generateBars(100_000)
    const engine = new Engine(cfg, 'BTCUSDT', '5m')

    const t0 = Date.now()
    const out = engine.run(bars)
    const elapsed = Date.now() - t0

    expect(out.meta.barCount).toBe(100_000)
    expect(out.trend).toHaveLength(100_000)
    expect(out.sessions.length).toBeGreaterThan(0)
    expect(out.pivots.length).toBeGreaterThan(0)

    const json = JSON.stringify(serialize(out))
    const parsed = JSON.parse(json)
    expect(parsed.fvgs.length).toBe(out.fvgs.length)
    expect(parsed.targets.length).toBe(out.targets.length)

    // 所有价格字段必须是字符串（无浮点精度损失）
    for (const p of parsed.pivots) expect(typeof p.price).toBe('string')
    for (const f of parsed.fvgs) {
      expect(typeof f.top).toBe('string')
      expect(typeof f.bottom).toBe('string')
    }
    for (const t of parsed.targets) expect(typeof t.level).toBe('string')

    console.log(`[性能] ${elapsed}ms 处理 10 万根 bar，产出 ${out.fvgs.length} 个 FVG、${out.targets.length} 条目标线`)
  })
})