// 集成测试：配置加载 + 引擎端到端
// 场景（All FVG 模式，非严格）：
//   - LN 会话 07:00-08:00 UTC（EDT 2024-07-01），bar 6..17
//   - bar5 为会前摆动高点 150（bar6 确认）→ 会话结束生成阻力目标
//   - bar8 满足 low[8] > high[6] → 创建 bull FVG
//   - bar9 回踩激活 FVG
//   - bar18 endSB；bar19 突破 150 → targetHi 信号

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'
import { Engine, LIVE_MAX_FVG_AGE } from '../src/engine/engine.js'
import { defaultConfig } from '../src/config/default.js'
import { deriveConfig } from '../src/config/load.js'
import type { Kline } from '../src/data/types.js'
import type { Config } from '../src/config/types.js'

function mkBar(time: number, o: number, h: number, l: number, c: number): Kline {
  return {
    time,
    open: new BigNumber(o),
    high: new BigNumber(h),
    low: new BigNumber(l),
    close: new BigNumber(c),
    volume: new BigNumber(0),
  }
}

const T0 = Date.UTC(2024, 6, 1, 6, 30) // 2024-07-01 06:30 UTC
const M5 = 5 * 60 * 1000

function buildBars(): Kline[] {
  const bars: Kline[] = []
  for (let k = 0; k < 20; k++) {
    let o = 100, h = 105, l = 95, c = 102
    if (k === 5) { o = 149; h = 150; l = 95; c = 149 } // 会前摆动高点 150
    if (k === 6) { o = 100; h = 102; l = 98; c = 100 } // 会话开始
    if (k === 7) { o = 101; h = 103; l = 96; c = 102 }
    if (k === 8) { o = 104; h = 106; l = 105; c = 105 } // bull FVG：low=105 > high[6]=102
    if (k === 9) { o = 105; h = 130; l = 100; c = 128 } // 回踩激活：low<105 & close>102
    if (k === 17) { o = 105; h = 110; l = 103; c = 108 }
    if (k === 18) { o = 106; h = 108; l = 100; c = 107 } // endSB
    if (k === 19) { o = 155; h = 160; l = 152; c = 158 } // 突破 150
    bars.push(mkBar(T0 + k * M5, o, h, l, c))
  }
  return bars
}

function makeEngine(mode: Config['fvg']['mode']) {
  const config = structuredClone(defaultConfig)
  config.fvg.mode = mode
  const cfg = deriveConfig(config, new BigNumber('0.01'))
  return new Engine(cfg, 'TESTUSDT', '5m')
}

describe('引擎端到端（All FVG 模式）', () => {
  const out = makeEngine('All FVG').run(buildBars())

  it('识别 LN 会话', () => {
    const ln = out.sessions.find((s) => s.session === 'LN')
    expect(ln).toBeDefined()
    expect(ln!.startBar).toBe(6)
    expect(ln!.endBar).toBe(17)
  })

  it('确认会前摆动高点', () => {
    const ph = out.pivots.find((p) => p.kind === 'high' && p.price.toNumber() === 150)
    expect(ph).toBeDefined()
    expect(ph!.bar).toBe(5)
  })

  it('创建并激活 bull FVG', () => {
    const f = out.fvgs.find((f) => f.type === 'bull')
    expect(f).toBeDefined()
    expect(f!.left).toBe(8)
    expect(f!.bottom.toNumber()).toBe(102)
    expect(f!.top.toNumber()).toBe(105)
    expect(f!.right).toBe(18)
    expect(f!.events.some((e) => e.event === 'created' && e.bar === 8)).toBe(true)
    expect(f!.events.some((e) => e.event === 'activated' && e.bar === 9)).toBe(true)
    expect(f!.events.some((e) => e.event === 'deactivated' && e.bar === 19)).toBe(true)
  })

  it('会话结束生成阻力目标（摆动高点 150）', () => {
    const t = out.targets.find((t) => t.kind === 'res' && t.level.toNumber() === 150)
    expect(t).toBeDefined()
    expect(t!.session).toBe('LN')
    expect(t!.swingBar).toBe(5)
    expect(t!.endBar).toBe(18)
  })

  it('bar19 突破目标 → targetHi 信号', () => {
    expect(out.signals).toContainEqual(
      expect.objectContaining({ type: 'targetHi', bar: 19 }),
    )
    const t = out.targets.find((t) => t.level.toNumber() === 150)
    expect(t!.brokenBar).toBe(19)
  })

  it('每 bar 输出趋势序列', () => {
    expect(out.trend).toHaveLength(20)
    expect(out.trend[0].value).toBe(0)
  })
})

describe('引擎端到端（Super-Strict 模式）', () => {
  // 场景：趋势保持 0 → iTrend 模式下仅创建 bear FVG
  // bar6 低点 88 形成 bear FVG（high[8]=85 < low[6]=88）
  // bar9 close=90 > bTop=88 → Super-Strict 立即失效
  function buildStrictBars(): Kline[] {
    const bars: Kline[] = []
    for (let k = 0; k < 20; k++) {
      let o = 100, h = 105, l = 95, c = 102
      if (k === 6) { o = 100; h = 90; l = 88; c = 89 } // 低点，会内
      if (k === 7) { o = 96; h = 97; l = 94; c = 95 }
      if (k === 8) { o = 86; h = 85; l = 84; c = 84 } // bear FVG：high=85 < low[6]=88
      if (k === 9) { o = 88; h = 92; l = 87; c = 90 } // close=90 > bTop=88 → invalidated
      if (k === 17) { o = 105; h = 110; l = 103; c = 108 }
      if (k === 18) { o = 106; h = 108; l = 100; c = 107 }
      if (k === 19) { o = 107; h = 109; l = 100; c = 108 }
      bars.push(mkBar(T0 + k * M5, o, h, l, c))
    }
    return bars
  }

  const out = makeEngine('Super-Strict').run(buildStrictBars())

  it('Super-Strict：close 越界即失效（current=false, active=false）', () => {
    const f = out.fvgs.find((f) => f.type === 'bear' && f.left === 6)
    expect(f).toBeDefined()
    expect(f!.left).toBe(6)
    expect(f!.top.toNumber()).toBe(88)
    expect(f!.bottom.toNumber()).toBe(85)
    expect(f!.current).toBe(false)
    expect(f!.active).toBe(false)
    expect(f!.right).toBe(6) // 失效后收口到 left
    expect(f!.events.some((e) => e.event === 'invalidated' && e.bar === 9)).toBe(true)
  })
})

describe('引擎端到端（Super-Strict endSB 收盘过滤 → closed）', () => {
  // 场景：趋势保持 0 → 创建并激活 bear FVG，会话中始终未越界（current 保持 true）
  // bar18（endSB）close=91 > bBot=85 → Super-Strict 收盘过滤失败 → closed（隐藏）
  function buildClosedBars(): Kline[] {
    const bars: Kline[] = []
    for (let k = 0; k < 20; k++) {
      let o = 100, h = 105, l = 95, c = 102
      if (k === 6) { o = 96; h = 96; l = 88; c = 89 } // 低点，会内（不触发额外 FVG）
      if (k === 7) { o = 94; h = 97; l = 94; c = 95 }
      if (k === 8) { o = 86; h = 85; l = 84; c = 84 } // bear FVG：high=85 < low[6]=88
      if (k === 9) { o = 86; h = 95; l = 84; c = 86 } // 激活：high>85 & close<88
      if (k >= 10) { o = 86; h = 87; l = 84; c = 86 } // 会话中 close<88 避免越界失效
      bars.push(mkBar(T0 + k * M5, o, h, l, c))
    }
    bars[18] = mkBar(T0 + 18 * M5, 90, 92, 86, 91) // endSB：close=91 > bBot=85 → closed
    bars[19] = mkBar(T0 + 19 * M5, 90, 92, 86, 91)
    return bars
  }

  const out = makeEngine('Super-Strict').run(buildClosedBars())

  it('endSB 收盘过滤失败 → closed（current 仍 true，active=false）', () => {
    const f = out.fvgs.find((f) => f.type === 'bear' && f.left === 6)
    expect(f).toBeDefined()
    expect(f!.current).toBe(true) // 会话中未被越界失效
    const evs = f!.events.map((e) => e.event)
    expect(evs).toContain('created')
    expect(evs).toContain('activated')
    expect(evs).toContain('closed')
    expect(f!.events.find((e) => e.event === 'closed')!.bar).toBe(18)
    // 会话中越界失效（invalidated）不应出现
    expect(evs).not.toContain('invalidated')
    expect(f!.active).toBe(false)
    expect(f!.right).toBe(f!.left) // 收口
  })
})

describe('Engine live 模式（监控长跑剪枝）', () => {
  const makeEngine = (live: boolean) => {
    const config = structuredClone(defaultConfig)
    config.fvg.mode = 'All FVG'
    const cfg = deriveConfig(config, new BigNumber('0.01'))
    return new Engine(cfg, 'TESTUSDT', '5m', { live })
  }

  // 确定性行情：t0=06:30 UTC（02:30 NY）。每个 288-bar 日周期内 LN 会话（NY 03:00-04:00 = bar 6..17）
  // 用 dip+gap 造 2 个 bull FVG（All FVG 需 low > high[2]）：
  //   bar 6 高=100（作 m=8 的下沿），bar 8 low=110 → FVG；bar 9 高=100，bar 11 low=112 → FVG
  // 会话外 bar 高=105/low=95，不产生 FVG。
  function barAt(k: number): Kline {
    const m = k % 288
    if (m === 6 || m === 9) return mkBar(t0(k), 100, 100, 90, 100)
    if (m === 8) return mkBar(t0(k), 108, 112, 110, 111)
    if (m === 11) return mkBar(t0(k), 110, 114, 112, 113)
    return mkBar(t0(k), 100, 105, 95, 104)
  }
  const t0 = (k: number): number => Date.UTC(2024, 6, 1, 6, 30) + k * 300_000

  function feed(engine: Engine, count: number): number {
    let created = 0
    for (let k = 0; k < count; k++) {
      created += engine.feedBar(barAt(k)).createdFvgs.length
    }
    return created
  }

  it('live 模式：长跑后 FVG 被剪枝、总量远小于总创建数', () => {
    const live = makeEngine(true)
    const batch = makeEngine(false)
    const days = 100 // 100 天 = 28800 bar
    const n = days * 288
    const liveCreated = feed(live, n)
    const batchCreated = feed(batch, n)
    expect(liveCreated).toBeGreaterThan(0)
    expect(batchCreated).toBeGreaterThan(0)
    expect(liveCreated).toBe(batchCreated) // 同一行情，创建数一致
    // 批量模式累积全部 FVG（100 天 → 每会话 2 个 → ~200）
    expect(batch.fvgCount).toBeGreaterThan(100)
    // live 模式仅保留存活窗口内的 FVG（≈ 1000/288 会话 × 2）
    expect(live.fvgCount).toBeLessThanOrEqual(LIVE_MAX_FVG_AGE)
    expect(live.fvgCount).toBeLessThan(50)
    expect(live.fvgCount).toBeGreaterThan(0)
  })

  it('live 与批量 feedBar 结果一致（created/趋势不受剪枝影响）', () => {
    const a = makeEngine(true)
    const b = makeEngine(false)
    // 跨多个会话喂 3 天，逐 bar 对比 createdFvgs
    const n = 3 * 288
    for (let k = 0; k < n; k++) {
      const ra = a.feedBar(barAt(k))
      const rb = b.feedBar(barAt(k))
      expect(ra.createdFvgs.length).toBe(rb.createdFvgs.length)
    }
    // 被剪枝的是批量里已经"过期"的；活跃窗口内二者数量相当（live ≤ batch）
    expect(a.fvgCount).toBeGreaterThan(0)
    expect(a.fvgCount).toBeLessThanOrEqual(b.fvgCount)
  })
})