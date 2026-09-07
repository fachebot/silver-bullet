// 主引擎：逐 bar 重放 Pine 逻辑，语义等价于 ict-silver-bullet.pine
//
// 执行顺序（与 Pine 脚本逐行对应）：
//   1. ph/pl pivot 检测（Pine 顶部）
//   2. f_setTrend()：全局 MSS 趋势
//   3. 目标线突破检测（highs/lows）
//   4. if strSB：重置 min/max + 锁定上一会话 FVG
//   5. if is_in_SB：创建 FVG（用 f_setTrend 之后的趋势）
//   6. FVG 处理：bull → bear（更新 min/max）
//   7. f_swings：GN 或 LN/AM/PM 会话处理

import BigNumber from 'bignumber.js'

import type { Kline } from '../data/types.js'
import type { DerivedConfig } from '../config/types.js'
import { pivotHighAt, pivotLowAt } from './pivots.js'
import { computeSessions, emptySessionFlags, type SessionFlags } from './sessions.js'
import type {
  ActLine,
  Box,
  EngineState,
  FVG,
  SessionKey,
  SessionState,
  TargetLine,
  ZZ,
} from './types.js'
import type {
  EngineOutput,
  FedBarResult,
  FvgEventType,
  FvgRecord,
  MssRecord,
} from './output.js'

// ZigZag 环形缓冲容量（Pine: maxSize = 250）
const ZZ_SIZE = 250

// 创建初始全局状态（对应 Pine 的 var 变量初始化）
function createInitialState(): EngineState {
  const mkSession = (): SessionState => ({
    swingH: [],
    swingL: [],
    mnPiv: new BigNumber(10e6),
    mxPiv: new BigNumber(0),
    mssDir: 0,
    targets: [],
  })
  return {
    a: { GN: mkSession(), LN: mkSession(), AM: mkSession(), PM: mkSession() },
    aZZ: {
      d: new Array(ZZ_SIZE).fill(0),
      x: new Array(ZZ_SIZE).fill(0),
      y: new Array(ZZ_SIZE).fill(null),
    },
    bFVG_bull: [],
    bFVG_bear: [],
    min: new BigNumber(10e6),
    max: new BigNumber(0),
    hilo0: new BigNumber(0),
    hilo1: new BigNumber(10e6),
    trend: 0,
    highs: [],
    lows: [],
    nextFvgId: 1,
  }
}

function createEmptyOutput(symbol: string, interval: string): EngineOutput {
  return {
    meta: { symbol, interval, barCount: 0, startTime: 0, endTime: 0 },
    sessions: [],
    pivots: [],
    zigzag: [],
    fvgs: [],
    targets: [],
    mss: [],
    trend: [],
    signals: [],
  }
}

export class Engine {
  private cfg: DerivedConfig
  private state: EngineState
  private out: EngineOutput
  private fvgMap = new Map<number, FvgRecord>()
  private sessionsOpen: Partial<Record<SessionKey, { startBar: number; startTime: number }>> = {}

  // series（逐 bar 追加，供 [1]/[2] 回溯）
  private times: number[] = []
  private highSeries: BigNumber[] = []
  private lowSeries: BigNumber[] = []
  private closeSeries: BigNumber[] = []

  private prevFlags: SessionFlags = emptySessionFlags()
  private lastCreationTrend = 0

  constructor(cfg: DerivedConfig, symbol: string, interval: string) {
    this.cfg = cfg
    this.state = createInitialState()
    this.out = createEmptyOutput(symbol, interval)
  }

  // 运行引擎，返回结构化输出（内部按 feedBar 逐根处理）
  run(bars: Kline[]): EngineOutput {
    for (const bar of bars) {
      this.feedBar(bar)
    }
    this.finalizeOutput()
    this.out.meta.barCount = bars.length
    this.out.meta.startTime = bars[0]?.time ?? 0
    this.out.meta.endTime = bars[bars.length - 1]?.time ?? 0
    return this.out
  }

  // 增量处理单根 bar（实时监控用）：返回本 bar 的结果（新建 FVG / 会话 / 趋势）
  feedBar(bar: Kline): FedBarResult {
    const i = this.times.length
    this.times.push(bar.time)
    this.highSeries.push(bar.high)
    this.lowSeries.push(bar.low)
    this.closeSeries.push(bar.close)
    const flags = computeSessions(this.prevFlags, bar.time)
    this.processBar(i, bar, flags)
    this.prevFlags = flags

    // 收集本 bar 新建的 FVG（created 事件 bar == 本 bar）
    const createdFvgs: Array<{ id: number; type: 'bull' | 'bear'; top: BigNumber; bottom: BigNumber }> = []
    for (const rec of this.fvgMap.values()) {
      const created = rec.events.find((e) => e.event === 'created')
      if (created && created.bar === i) {
        createdFvgs.push({ id: rec.id, type: rec.type, top: rec.top, bottom: rec.bottom })
      }
    }

    return {
      barIndex: i,
      time: bar.time,
      close: bar.close,
      trend: this.lastCreationTrend,
      inSb: flags.isInSB,
      session: flags.ln ? 'LN' : flags.am ? 'AM' : flags.pm ? 'PM' : null,
      createdFvgs,
    }
  }

  // 单根 bar 的处理（对应 Pine 脚本主执行区）
  private processBar(i: number, bar: Kline, flags: SessionFlags): void {
    const cfg = this.cfg
    const state = this.state

    // 1. ph/pl：ta.pivothigh(left, 1) / ta.pivotlow(left, 1)
    const ph = pivotHighAt(i, cfg.left, 1, this.highSeries)
    const pl = pivotLowAt(i, cfg.left, 1, this.lowSeries)

    // 2. f_setTrend()
    this.fSetTrend(bar.close)

    // 3. 目标线突破检测（Pine: targetHi/targetLo）
    let targetHi = false
    let targetLo = false
    if (state.highs.length > 200) state.highs.pop()
    for (const ln of state.highs) {
      if (ln.active) {
        if (bar.high.gt(ln.y)) {
          ln.active = false
          targetHi = true
          if (ln.target) {
            ln.target.brokenBar = i
            ln.target.brokenTime = bar.time
          }
        }
      }
    }
    if (state.lows.length > 200) state.lows.pop()
    for (const ln of state.lows) {
      if (ln.active) {
        if (bar.low.lt(ln.y)) {
          ln.active = false
          targetLo = true
          if (ln.target) {
            ln.target.brokenBar = i
            ln.target.brokenTime = bar.time
          }
        }
      }
    }
    if (targetHi) this.out.signals.push({ type: 'targetHi', bar: i, time: bar.time })
    if (targetLo) this.out.signals.push({ type: 'targetLo', bar: i, time: bar.time })

    // 4. if strSB：重置 min/max、锁定上一会话 FVG
    if (flags.strSB) {
      state.min = new BigNumber(10e6)
      state.max = new BigNumber(0)
      this.lockFvgs(i)
    }

    // 5. if is_in_SB：创建 FVG（趋势为 f_setTrend 之后、f_swings 之前的值）
    //    捕获该趋势，供 feedBar 返回（实时监控质量判定用）
    this.lastCreationTrend = state.trend
    if (flags.isInSB) {
      this.createFvgs(i, bar)
    }

    // 6. FVG 处理：bull → bear
    this.processBullFvgs(i, bar, flags)
    this.processBearFvgs(i, bar, flags)

    // 7. f_swings：prev → GN；否则 LN/AM/PM
    if (cfg.prev) {
      this.processSwings('GN', flags.strSB, flags.endSB, flags.isInSB, i, bar, ph, pl)
    } else {
      this.processSwings('LN', flags.strLN, flags.endLN, flags.ln, i, bar, ph, pl)
      this.processSwings('AM', flags.strAM, flags.endAM, flags.am, i, bar, ph, pl)
      this.processSwings('PM', flags.strPM, flags.endPM, flags.pm, i, bar, ph, pl)
    }

    // 会话记录（输出用）
    this.trackSessions(flags, i, bar.time)

    // 每 bar 趋势输出（aTrend 最终值 = 最后执行的 f_swings 的 MSS_dir）
    this.out.trend.push({ bar: i, time: bar.time, value: state.trend })
  }

  // f_setTrend()：基于 ZigZag 的全局 MSS 趋势
  private fSetTrend(close: BigNumber): void {
    const zz = this.state.aZZ
    const mss = this.state.trend
    const iH = zz.d[2] === 1 ? 2 : 1
    const iL = zz.d[2] === -1 ? 2 : 1
    const yIH = zz.y[iH]
    const yIL = zz.y[iL]
    // switch：MSS Bullish
    if (yIH !== null && zz.d[iH] === 1 && mss < 1 && close.gt(yIH)) {
      this.state.trend = 1
    } else if (yIL !== null && zz.d[iL] === -1 && mss > -1 && close.lt(yIL)) {
      // MSS Bearish
      this.state.trend = -1
    }
  }

  // f_swings(start, end, str, col, min, max) 的等价实现（针对某一会话）
  private processSwings(
    sess: SessionKey,
    start: boolean,
    end: boolean,
    active: boolean,
    i: number,
    bar: Kline,
    ph: BigNumber | null,
    pl: BigNumber | null,
  ): void {
    const cfg = this.cfg
    const state = this.state
    const s = state.a[sess]
    const x2 = i - 1
    // nz(high[1]) / nz(low[1])：bar 0 时回溯为 na → 0
    const nzHigh1 = i >= 1 ? this.highSeries[i - 1] : new BigNumber(0)
    const nzLow1 = i >= 1 ? this.lowSeries[i - 1] : new BigNumber(0)

    // if start：重置会话高低点，并按需清理历史线
    if (start) {
      state.hilo0 = new BigNumber(0)
      state.hilo1 = new BigNumber(10e6)
      // Pine: if (stricty ? not keep : true) → 清理全部目标线与活跃线
      const doCleanup = !cfg.stricty || !cfg.keep
      if (doCleanup) {
        state.highs = []
        state.lows = []
        for (const key of Object.keys(state.a) as SessionKey[]) {
          state.a[key].targets = []
        }
      }
    }

    // if active：累计会话内最高/最低
    if (active) {
      state.hilo0 = BigNumber.maximum(state.hilo0, bar.high)
      state.hilo1 = BigNumber.minimum(state.hilo1, bar.low)
    }

    // if ph：摆动高点收集 + 过滤 + ZigZag 更新（仅 GN/LN）
    if (ph !== null) {
      if (ph.gt(s.mxPiv)) s.mxPiv = ph
      for (let k = s.swingH.length - 1; k >= 0; k--) {
        if (ph.gte(s.swingH[k].p)) s.swingH.splice(k, 1)
      }
      s.swingH.unshift({ b: i - 1, p: ph, br: false })
      this.out.pivots.push({
        kind: 'high',
        bar: i - 1,
        time: i >= 1 ? this.times[i - 1] : bar.time,
        price: ph,
      })
      if (sess === 'GN' || sess === 'LN') {
        const zz = state.aZZ
        const dir = zz.d[0]
        const y1 = zz.y[0]
        const y2 = nzHigh1
        if (dir < 1) {
          // 前一点是低点（或初始）→ 新增高点节点
          this.zzInOut(1, y1, x2, y2)
        } else if (dir === 1 && y1 !== null && ph.gt(y1)) {
          // 同向且更高 → 更新最后节点
          zz.x[0] = x2
          zz.y[0] = y2
        }
      }
    }

    // if pl：摆动低点收集 + 过滤 + ZigZag 更新（仅 GN/LN）
    if (pl !== null) {
      if (pl.lt(s.mnPiv)) s.mnPiv = pl
      for (let k = s.swingL.length - 1; k >= 0; k--) {
        if (pl.lte(s.swingL[k].p)) s.swingL.splice(k, 1)
      }
      s.swingL.unshift({ b: i - 1, p: pl, br: false })
      this.out.pivots.push({
        kind: 'low',
        bar: i - 1,
        time: i >= 1 ? this.times[i - 1] : bar.time,
        price: pl,
      })
      if (sess === 'GN' || sess === 'LN') {
        const zz = state.aZZ
        const dir = zz.d[0]
        const y1 = zz.y[0]
        const y2 = nzLow1
        if (dir > -1) {
          this.zzInOut(-1, y1, x2, y2)
        } else if (dir === -1 && y1 !== null && pl.lt(y1)) {
          zz.x[0] = x2
          zz.y[0] = y2
        }
      }
    }

    // MSS 检测（基于 ZigZag，逐会话独立 mssDir）
    const iH = state.aZZ.d[2] === 1 ? 2 : 1
    const iL = state.aZZ.d[2] === -1 ? 2 : 1
    const yIH = state.aZZ.y[iH]
    const yIL = state.aZZ.y[iL]
    if (yIH !== null && state.aZZ.d[iH] === 1 && s.mssDir < 1 && bar.close.gt(yIH)) {
      s.mssDir = 1
      this.recordMss(sess, 1, i, bar.time)
    } else if (yIL !== null && state.aZZ.d[iL] === -1 && s.mssDir > -1 && bar.close.lt(yIL)) {
      s.mssDir = -1
      this.recordMss(sess, -1, i, bar.time)
    }

    // if end：会话结束 → 从摆动点生成目标线
    if (end) {
      for (const sw of s.swingH) {
        const y = sw.p
        if (y.gt(cfg.stricty ? state.min : state.hilo0)) {
          const tl: TargetLine = {
            session: sess,
            kind: 'res',
            level: y,
            swingBar: sw.b,
            endBar: i,
            brokenBar: null,
            brokenTime: null,
          }
          s.targets.push(tl)
          state.highs.unshift({ y, active: true, target: tl })
        }
      }
      for (const sw of s.swingL) {
        const y = sw.p
        if (y.lt(cfg.stricty ? state.max : state.hilo1)) {
          const tl: TargetLine = {
            session: sess,
            kind: 'sup',
            level: y,
            swingBar: sw.b,
            endBar: i,
            brokenBar: null,
            brokenTime: null,
          }
          s.targets.push(tl)
          state.lows.unshift({ y, active: true, target: tl })
        }
      }
      s.swingH = []
      s.swingL = []
      s.mnPiv = new BigNumber(10e6)
      s.mxPiv = new BigNumber(0)
    }

    // Pine: aTrend.set(0, MSS_dir)
    state.trend = s.mssDir
  }

  // ZigZag in_out：unshift + pop 环形缓冲
  private zzInOut(d: number, _y1: BigNumber | null, x2: number, y2: BigNumber): void {
    const zz = this.state.aZZ
    zz.d.unshift(d)
    zz.x.unshift(x2)
    zz.y.unshift(y2)
    zz.d.pop()
    zz.x.pop()
    zz.y.pop()
    // 记录 ZigZag 节点（数据模式下等价于 showZZ 画线）
    if (x2 >= 0) {
      this.out.zigzag.push({ dir: d as 1 | -1, bar: x2, time: this.times[x2], price: y2 })
    }
  }

  // 记录 MSS 事件
  private recordMss(sess: SessionKey, direction: 1 | -1, i: number, time: number): void {
    this.out.mss.push({ direction, bar: i, time, session: sess })
  }

  // if strSB：锁定上一会话创建的 FVG（current → false）
  private lockFvgs(i: number): void {
    for (const f of this.state.bFVG_bull) {
      if (i > f.box.right - 1 && f.current) f.current = false
    }
    for (const f of this.state.bFVG_bear) {
      if (i > f.box.right - 1 && f.current) f.current = false
    }
  }

  // if is_in_SB：创建 FVG
  private createFvgs(i: number, bar: Kline): void {
    const cfg = this.cfg
    const state = this.state
    const high2 = i >= 2 ? this.highSeries[i - 2] : null
    const low2 = i >= 2 ? this.lowSeries[i - 2] : null
    const trend = state.trend

    if (cfg.iTrend) {
      // switch trend：1 → 仅 bull；否则（0/-1）→ 仅 bear
      if (trend === 1) {
        if (high2 !== null && bar.low.gt(high2)) {
          this.pushFvg('bull', { left: i - 2, top: bar.low, right: i, bottom: high2 }, i, bar.time)
        }
      } else {
        if (low2 !== null && bar.high.lt(low2)) {
          this.pushFvg('bear', { left: i - 2, top: low2, right: i, bottom: bar.high }, i, bar.time)
        }
      }
    } else {
      // All FVG 模式：box 左右均为当前 bar
      if (high2 !== null && bar.low.gt(high2)) {
        this.pushFvg('bull', { left: i, top: bar.low, right: i, bottom: high2 }, i, bar.time)
      }
      if (low2 !== null && bar.high.lt(low2)) {
        this.pushFvg('bear', { left: i, top: low2, right: i, bottom: bar.high }, i, bar.time)
      }
    }
  }

  // 创建 FVG 并登记输出记录
  private pushFvg(type: 'bull' | 'bear', box: Box, i: number, time: number): void {
    const state = this.state
    const f: FVG = {
      box,
      active: false,
      current: true,
      id: state.nextFvgId++,
    }
    if (type === 'bull') state.bFVG_bull.unshift(f)
    else state.bFVG_bear.unshift(f)
    const rec: FvgRecord = {
      id: f.id,
      type,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      current: true,
      active: false,
      events: [{ event: 'created', bar: i, time }],
    }
    this.fvgMap.set(f.id, rec)
  }

  // 记录 FVG 生命周期事件
  private recordFvgEvent(f: FVG, event: FvgEventType, i: number): void {
    const rec = this.fvgMap.get(f.id)
    if (rec) rec.events.push({ event, bar: i, time: this.times[i] })
  }

  // bull FVG 状态机
  private processBullFvgs(i: number, bar: Kline, flags: SessionFlags): void {
    const cfg = this.cfg
    const state = this.state
    for (const f of state.bFVG_bull) {
      const bLeft = f.box.left
      const bTop = f.box.top
      const bBot = f.box.bottom
      if (i - bLeft < 1000 && f.current) {
        if (flags.isInSB) {
          if (bar.close.lt(bBot)) {
            if (cfg.superstrict) {
              f.current = false
              f.box.right = bLeft
              this.recordFvgEvent(f, 'invalidated', i)
            }
            if (cfg.superstrict || cfg.strict) f.active = false
          } else {
            if (cfg.extend && f.active) f.box.right = i
          }
          // 触发回踩 → 激活
          if (!f.active) {
            if (bar.low.lt(bTop) && bar.close.gt(bBot)) {
              f.active = true
              this.recordFvgEvent(f, 'activated', i)
              if (cfg.extend) f.box.right = i
            }
          }
        }
        // 会话最后时刻（endSB = 会话结束后第一根 bar）
        if (flags.endSB) {
          const wasActive = f.active
          if (f.active) {
            if (cfg.strict && bar.close.lt(bBot)) f.active = false
            if (cfg.superstrict && bar.close.lt(bTop)) f.active = false
            // strict/superstrict 收盘过滤失败 → 收口隐藏（对应 Pine 透明+set_right）
            if (wasActive && !f.active) this.recordFvgEvent(f, 'closed', i)
          }
          if (!f.active) {
            // 未激活/被关闭 → 收口隐藏
            f.box.right = bLeft
            if (wasActive === false) this.recordFvgEvent(f, 'expired', i)
          }
          if (f.active) {
            state.min = BigNumber.minimum(state.min, bBot.plus(cfg.minimumTradeFramework))
            if (cfg.extend) f.box.right = i
          }
        }
        // endSB[1]：会话结束后第二根 bar，仅置 active=false（不隐藏）
        if (flags.endSB1) {
          if (f.active) {
            f.active = false
            this.recordFvgEvent(f, 'deactivated', i)
          }
        }
      }
    }
  }

  // bear FVG 状态机（与 bull 对称，方向反转）
  private processBearFvgs(i: number, bar: Kline, flags: SessionFlags): void {
    const cfg = this.cfg
    const state = this.state
    for (const f of state.bFVG_bear) {
      const bLeft = f.box.left
      const bTop = f.box.top
      const bBot = f.box.bottom
      if (i - bLeft < 1000 && f.current) {
        if (flags.isInSB) {
          if (bar.close.gt(bTop)) {
            if (cfg.superstrict) {
              f.current = false
              f.box.right = bLeft
              this.recordFvgEvent(f, 'invalidated', i)
            }
            if (cfg.superstrict || cfg.strict) f.active = false
          } else {
            if (cfg.extend && f.active) f.box.right = i
          }
          // 触发回踩 → 激活
          if (!f.active) {
            if (bar.high.gt(bBot) && bar.close.lt(bTop)) {
              f.active = true
              this.recordFvgEvent(f, 'activated', i)
              if (cfg.extend) f.box.right = i
            }
          }
        }
        if (flags.endSB) {
          const wasActive = f.active
          if (f.active) {
            if (cfg.strict && bar.close.gt(bTop)) f.active = false
            if (cfg.superstrict && bar.close.gt(bBot)) f.active = false
            // strict/superstrict 收盘过滤失败 → 收口隐藏
            if (wasActive && !f.active) this.recordFvgEvent(f, 'closed', i)
          }
          if (!f.active) {
            f.box.right = bLeft
            if (wasActive === false) this.recordFvgEvent(f, 'expired', i)
          }
          if (f.active) {
            state.max = BigNumber.maximum(state.max, bTop.minus(cfg.minimumTradeFramework))
            if (cfg.extend) f.box.right = i
          }
        }
        // endSB[1]：仅置 active=false（不隐藏）
        if (flags.endSB1) {
          if (f.active) {
            f.active = false
            this.recordFvgEvent(f, 'deactivated', i)
          }
        }
      }
    }
  }

  // 会话起止记录（输出用）
  private trackSessions(flags: SessionFlags, i: number, time: number): void {
    this.trackOne('GN', flags.strSB, flags.endSB, i, time)
    this.trackOne('LN', flags.strLN, flags.endLN, i, time)
    this.trackOne('AM', flags.strAM, flags.endAM, i, time)
    this.trackOne('PM', flags.strPM, flags.endPM, i, time)
  }

  private trackOne(
    sess: SessionKey,
    start: boolean,
    end: boolean,
    i: number,
    time: number,
  ): void {
    if (start) this.sessionsOpen[sess] = { startBar: i, startTime: time }
    if (end && this.sessionsOpen[sess]) {
      const open = this.sessionsOpen[sess]!
      const endBar = i - 1
      this.out.sessions.push({
        session: sess,
        startBar: open.startBar,
        startTime: open.startTime,
        endBar,
        endTime: endBar >= 0 ? this.times[endBar] : time,
      })
      this.sessionsOpen[sess] = undefined
    }
  }

  // 收尾：汇总 FVG 最终状态与目标线
  private finalizeOutput(): void {
    const state = this.state
    const records: FvgRecord[] = []
    for (const f of [...state.bFVG_bull, ...state.bFVG_bear]) {
      const rec = this.fvgMap.get(f.id)
      const type = state.bFVG_bull.includes(f) ? 'bull' : 'bear'
      records.push({
        id: f.id,
        type,
        left: f.box.left,
        right: f.box.right,
        top: f.box.top,
        bottom: f.box.bottom,
        current: f.current,
        active: f.active,
        events: rec?.events ?? [],
      })
    }
    records.sort((a, b) => a.id - b.id)
    this.out.fvgs = records

    const targets: TargetLine[] = []
    for (const key of ['GN', 'LN', 'AM', 'PM'] as SessionKey[]) {
      targets.push(...state.a[key].targets)
    }
    this.out.targets = targets
  }
}