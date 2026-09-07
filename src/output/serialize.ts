// 输出序列化：把 EngineOutput 转成 JSON 可序列化的纯对象
// 所有 BigNumber 价格字段一律输出为精确十进制字符串，避免浮点/JSON 精度损失
// 每个数值时间戳附带 *Bjt 字段：格式化的北京时间（UTC+8，无夏令时），便于肉眼观察

import type BigNumber from 'bignumber.js'
import type { EngineOutput } from '../engine/output.js'

function num(v: BigNumber): string {
  return v.toString()
}

// 毫秒时间戳 → 北京时间字符串（yyyy-MM-dd HH:mm:ss）
// 北京时间为固定 UTC+8，直接偏移后取 UTC 墙钟即可，避免时区库开销
export function bjt(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// 纯对象（价格已转字符串，时间戳附带北京时间）
export interface SerializableOutput {
  meta: {
    symbol: string
    interval: string
    barCount: number
    startTime: number
    endTime: number
    startTimeBjt: string
    endTimeBjt: string
  }
  sessions: Array<{
    session: string
    startBar: number
    startTime: number
    endBar: number
    endTime: number
    startTimeBjt: string
    endTimeBjt: string
  }>
  pivots: Array<{ kind: string; bar: number; time: number; timeBjt: string; price: string }>
  zigzag: Array<{ dir: number; bar: number; time: number; timeBjt: string; price: string | null }>
  fvgs: Array<{
    id: number
    type: string
    left: number
    right: number
    top: string
    bottom: string
    current: boolean
    active: boolean
    events: Array<{ event: string; bar: number; time: number; timeBjt: string }>
  }>
  targets: Array<{
    session: string
    kind: string
    level: string
    swingBar: number
    endBar: number
    brokenBar: number | null
    brokenTime: number | null
    brokenTimeBjt: string | null
  }>
  mss: Array<{
    session: string
    direction: number
    bar: number
    time: number
    timeBjt: string
  }>
  trend: Array<{ bar: number; time: number; timeBjt: string; value: number }>
  signals: Array<{ type: string; bar: number; time: number; timeBjt: string }>
}

export function serialize(out: EngineOutput): SerializableOutput {
  return {
    meta: {
      ...out.meta,
      startTimeBjt: bjt(out.meta.startTime),
      endTimeBjt: bjt(out.meta.endTime),
    },
    sessions: out.sessions.map((s) => ({
      ...s,
      startTimeBjt: bjt(s.startTime),
      endTimeBjt: bjt(s.endTime),
    })),
    pivots: out.pivots.map((p) => ({ ...p, timeBjt: bjt(p.time), price: num(p.price) })),
    zigzag: out.zigzag.map((z) => ({
      ...z,
      timeBjt: bjt(z.time),
      price: z.price === null ? null : num(z.price),
    })),
    fvgs: out.fvgs.map((f) => ({
      id: f.id,
      type: f.type,
      left: f.left,
      right: f.right,
      top: num(f.top),
      bottom: num(f.bottom),
      current: f.current,
      active: f.active,
      events: f.events.map((e) => ({ ...e, timeBjt: bjt(e.time) })),
    })),
    targets: out.targets.map((t) => ({
      session: t.session,
      kind: t.kind,
      level: num(t.level),
      swingBar: t.swingBar,
      endBar: t.endBar,
      brokenBar: t.brokenBar,
      brokenTime: t.brokenTime,
      brokenTimeBjt: t.brokenTime === null ? null : bjt(t.brokenTime),
    })),
    mss: out.mss.map((m) => ({ ...m, timeBjt: bjt(m.time) })),
    trend: out.trend.map((t) => ({ ...t, timeBjt: bjt(t.time) })),
    signals: out.signals.map((s) => ({ ...s, timeBjt: bjt(s.time) })),
  }
}