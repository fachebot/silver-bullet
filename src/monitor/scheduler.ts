// 会话边界整点调度器：LN/AM/PM 的开始/结束在 NY 整点精确触发（America/New_York，Luxon 处理 DST）
// 全局单一实例（与币种无关）；每个边界只触发一次；启动时补发最近错过的边界（进程出生前的旧边界不轰炸）；
// 运行中若系统休眠错过边界，恢复后兜底扫描补发中间错过的边界

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

// 启动时允许补发的容差窗口：进程恰好在边界后一小段时间内启动（如 03:00:30）会补发该边界；
// 早于（进程出生时刻 - 容差）就错过的边界视为"出生前就错过"，不补发
export const CATCHUP_GRACE_MS = 60_000

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

// 枚举 (from, to] 之间的所有边界时刻（from 排除、to 包含），按时间升序
export function boundariesBetween(from: number, to: number): Boundary[] {
  if (to <= from) return []
  const out: Boundary[] = []
  const fromNY = DateTime.fromMillis(from, { zone: 'America/New_York' })
  // 覆盖 from/to 所在的当天及次日，避免跨天边界遗漏
  const day0 = fromNY.startOf('day')
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const day = day0.plus({ days: dayOffset })
    if (day.toMillis() > to) break
    for (const b of BOUNDARIES) {
      const ms = day.set({ hour: b.hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
      if (ms > from && ms <= to) {
        out.push({ session: b.session, edge: b.edge, timeMs: ms })
      }
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs)
}

export class SessionScheduler {
  private timer: NodeJS.Timeout | null = null
  private fired = new Set<number>() // 已触发的边界 epoch ms（去重）
  private onBoundary: ((b: Boundary) => void) | null = null
  private stopped = false

  constructor(private now: () => number = () => Date.now()) {}

  // 启动：补发进程出生后错过的边界（容差 CATCHUP_GRACE_MS 内），随后逐边界 setTimeout 精确触发
  start(onBoundary: (b: Boundary) => void): void {
    this.onBoundary = onBoundary
    this.stopped = false
    const now = this.now()
    // 进程在整点后刚启动（如 03:00:30）→ 补发出生时刻之前最近 CATCHUP_GRACE_MS 内错过的边界
    // （fired 跨 start 保留，重复 start 不重复触发同一边界）
    const graceFrom = now - CATCHUP_GRACE_MS
    for (const b of boundariesBetween(graceFrom, now)) {
      getLogger().info(`[会话] 补发错过的边界 ${b.session} ${b.edge}`)
      this.fire(b)
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
      this.fire(next)
      // 兜底：触发点晚于目标（系统休眠/进程暂停导致 timer 漂移）时，补发中间错过的边界
      this.catchUpMissed(next.timeMs)
      this.scheduleNext()
    }, delay + 50)
  }

  // 触发一个边界（fired 去重 + 清理过期记录）
  private fire(b: Boundary): void {
    this.cleanupFired()
    if (this.fired.has(b.timeMs)) return
    this.fired.add(b.timeMs)
    getLogger().info(`[会话] ${b.session} ${b.edge} 触发`)
    this.dispatch(b)
  }

  // 兜底补发：目标边界之后、现在之前本应触发但被错过（休眠）的边界
  private catchUpMissed(targetMs: number): void {
    const now = this.now()
    if (now <= targetMs) return
    for (const b of boundariesBetween(targetMs, now)) {
      if (!this.fired.has(b.timeMs)) {
        getLogger().info(`[会话] 补发休眠期间错过的边界 ${b.session} ${b.edge}`)
        this.fire(b)
      }
    }
  }

  private cleanupFired(): void {
    // 清理超过 25h 的去重记录，避免无限增长
    const cutoff = this.now() - 25 * 3600_000
    for (const ms of this.fired) {
      if (ms < cutoff) this.fired.delete(ms)
    }
  }

  private dispatch(b: Boundary): void {
    try {
      this.onBoundary?.(b)
    } catch (err) {
      getLogger().error(`[会话] 回调异常: ${(err as Error).message}`)
    }
  }
}