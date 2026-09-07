// 会话边界整点调度器：LN/AM/PM 的开始/结束在 NY 整点精确触发（America/New_York，Luxon 处理 DST）
// 全局单一实例（与币种无关）；每个边界只触发一次；启动时补发最近 60s 内错过的边界

import { DateTime } from 'luxon'
import { getLogger } from '../log/logger.js'

export type SessionKey = 'LN' | 'AM' | 'PM'
export type SessionEdge = 'start' | 'end'

export interface Boundary {
  session: SessionKey
  edge: SessionEdge
  timeMs: number // 边界时刻（epoch ms）
}

// 会话边界（America/New_York 本地时刻的整点）
export const BOUNDARIES: Array<{ session: SessionKey; edge: SessionEdge; hour: number }> = [
  { session: 'LN', edge: 'start', hour: 3 },
  { session: 'LN', edge: 'end', hour: 4 },
  { session: 'AM', edge: 'start', hour: 10 },
  { session: 'AM', edge: 'end', hour: 11 },
  { session: 'PM', edge: 'start', hour: 14 },
  { session: 'PM', edge: 'end', hour: 15 },
]

// 计算严格晚于 now 的最近一个边界
export function nextBoundary(now: number = Date.now()): Boundary | null {
  const nowNY = DateTime.fromMillis(now, { zone: 'America/New_York' })
  let best: Boundary | null = null
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const day = nowNY.plus({ days: dayOffset }).startOf('day')
    for (const b of BOUNDARIES) {
      const ms = day.set({ hour: b.hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
      if (ms > now && (!best || ms < best.timeMs)) {
        best = { session: b.session, edge: b.edge, timeMs: ms }
      }
    }
  }
  return best
}

export class SessionScheduler {
  private timer: NodeJS.Timeout | null = null
  private fired = new Set<number>() // 已触发的边界 epoch ms（去重）
  private onBoundary: ((b: Boundary) => void) | null = null
  private stopped = false

  constructor(private now: () => number = () => Date.now()) {}

  // 启动：补发最近 60s 内错过的边界，随后逐边界 setTimeout 精确触发
  start(onBoundary: (b: Boundary) => void): void {
    this.onBoundary = onBoundary
    this.stopped = false
    const now = this.now()
    // 补发：进程可能在整点后刚启动（如 03:00:30）
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const day = DateTime.fromMillis(now, { zone: 'America/New_York' }).plus({ days: dayOffset }).startOf('day')
      for (const b of BOUNDARIES) {
        const ms = day.set({ hour: b.hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
        if (ms <= now && now - ms <= 60_000 && !this.fired.has(ms)) {
          this.fired.add(ms)
          getLogger().info(`[会话] 补发错过的边界 ${b.session} ${b.edge}`)
          this.dispatch({ session: b.session, edge: b.edge, timeMs: ms })
        }
      }
    }
    this.scheduleNext()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    const next = nextBoundary(this.now())
    if (!next) return
    const delay = Math.max(next.timeMs - this.now(), 0)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      if (!this.fired.has(next.timeMs)) {
        this.fired.add(next.timeMs)
        getLogger().info(`[会话] ${next.session} ${next.edge} 触发`)
        this.dispatch(next)
      }
      this.scheduleNext()
    }, delay + 50)
  }

  private dispatch(b: Boundary): void {
    // 清理超过 25h 的去重记录，避免无限增长
    const cutoff = this.now() - 25 * 3600_000
    for (const ms of this.fired) {
      if (ms < cutoff) this.fired.delete(ms)
    }
    try {
      this.onBoundary?.(b)
    } catch (err) {
      getLogger().error(`[会话] 回调异常: ${(err as Error).message}`)
    }
  }
}