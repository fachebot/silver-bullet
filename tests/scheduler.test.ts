// 测试：会话边界整点调度器 + 消息格式化

import { describe, it, expect, afterEach } from 'vitest'
import { DateTime } from 'luxon'

import { nextBoundary, boundariesBetween, SessionScheduler } from '../src/monitor/scheduler.js'
import { formatSessionAlert } from '../src/monitor/format.js'

// 构造 America/New_York 某时刻的 epoch ms
function nyMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: 'America/New_York' }).toMillis()
}

describe('nextBoundary', () => {
  it('02:30 NY → 最近边界为 LN start 03:00', () => {
    const now = nyMs(2024, 6, 1, 2, 30)
    const b = nextBoundary(now)
    expect(b!.session).toBe('LN')
    expect(b!.edge).toBe('start')
    expect(b!.timeMs).toBe(nyMs(2024, 6, 1, 3, 0))
  })

  it('03:30 NY → 最近边界为 LN end 04:00', () => {
    const now = nyMs(2024, 6, 1, 3, 30)
    const b = nextBoundary(now)!
    expect(b.session).toBe('LN')
    expect(b.edge).toBe('end')
  })

  it('04:30 NY → 最近边界为 AM start 10:00', () => {
    const now = nyMs(2024, 6, 1, 4, 30)
    const b = nextBoundary(now)!
    expect(b.session).toBe('AM')
    expect(b.edge).toBe('start')
    expect(b.timeMs).toBe(nyMs(2024, 6, 1, 10, 0))
  })

  it('23:59 NY → 跨天到次日 LN start 03:00', () => {
    const now = nyMs(2024, 6, 1, 23, 59)
    const b = nextBoundary(now)!
    expect(b.session).toBe('LN')
    expect(b.timeMs).toBe(nyMs(2024, 6, 2, 3, 0))
  })

  it('DST 期间仍正确（EDT/EST 由 Luxon 处理）', () => {
    // 2024-01-15 为 EST（UTC-5）
    const now = nyMs(2024, 1, 15, 2, 30)
    const b = nextBoundary(now)!
    expect(b.session).toBe('LN')
    expect(b.timeMs).toBe(nyMs(2024, 1, 15, 3, 0))
    // 2024-07-15 为 EDT（UTC-4）
    const now2 = nyMs(2024, 7, 15, 10, 30)
    const b2 = nextBoundary(now2)!
    expect(b2.session).toBe('AM')
    expect(b2.edge).toBe('end')
  })
})

describe('boundariesBetween', () => {
  it('(from, to] 内返回按时间升序的边界', () => {
    // 2024-07-01 03:30 NY → 10:00 NY：应得 LN end(04:00) + AM start(10:00)
    const from = nyMs(2024, 6, 1, 3, 30)
    const to = nyMs(2024, 6, 1, 10, 30)
    const bs = boundariesBetween(from, to)
    expect(bs.map((b) => `${b.session}:${b.edge}`)).toEqual(['LN:end', 'AM:start'])
  })

  it('from 恰为边界时刻时排除 from、包含 to', () => {
    const from = nyMs(2024, 6, 1, 4, 0) // LN end
    const to = nyMs(2024, 6, 1, 10, 0) // AM start
    const bs = boundariesBetween(from, to)
    expect(bs.map((b) => `${b.session}:${b.edge}`)).toEqual(['AM:start'])
  })

  it('跨天（23:00 → 次日 11:00）仍枚举到次日边界', () => {
    const from = nyMs(2024, 6, 1, 23, 0)
    const to = nyMs(2024, 6, 2, 11, 0)
    const bs = boundariesBetween(from, to)
    // 当日已过 15:00 无更多边界；次日应有 LN start/end + AM start/end（to=11:00 含 AM end）
    expect(bs.map((b) => `${b.session}:${b.edge}`)).toEqual(['LN:start', 'LN:end', 'AM:start', 'AM:end'])
  })

  it('to ≤ from → 空', () => {
    expect(boundariesBetween(1000, 1000)).toEqual([])
  })
})

describe('SessionScheduler', () => {
  const fired: string[] = []
  let sched: SessionScheduler | null = null

  afterEach(() => {
    sched?.stop()
    fired.length = 0
  })

  it('启动时补发容差窗口内错过的边界（全局一次）', () => {
    // 模拟 03:00:30 启动 → 补发 LN start 03:00
    const start = nyMs(2024, 6, 1, 3, 0) + 30_000
    sched = new SessionScheduler(() => start)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    expect(fired).toContain('LN:start')
  })

  it('启动超出容差窗口（进程出生前的旧边界）不补发', () => {
    // 04:30 启动，早于 60s 容差，不补发 LN end 04:00
    const start = nyMs(2024, 6, 1, 4, 30)
    sched = new SessionScheduler(() => start)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    expect(fired).toHaveLength(0)
    expect(fired).not.toContain('LN:end')
  })

  it('同一边界只触发一次（去重）', () => {
    const start = nyMs(2024, 6, 1, 3, 0) + 30_000
    sched = new SessionScheduler(() => start)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    sched.start((b) => fired.push(`${b.session}:${b.edge}`)) // 重复 start 不应重复触发同一边界
    expect(fired.filter((x) => x === 'LN:start')).toHaveLength(1)
  })

  it('休眠错过 03:00/04:00 → timer 漂移恢复后按序补发中间错过的边界', async () => {
    const fired: string[] = []
    // 确定性假时钟：
    //   前 3 次查询（start 的 now、scheduleNext 的 nextBoundary/delay）→ 02:59:59.900，
    //   使首个 timer 指向 03:00、delay≈100ms（真实 setTimeout 很快到期）；
    //   第 4 次起（timer 回调内 fire→cleanupFired、catchUpMissed 的 now）→ 跳到 10:30（模拟刚休眠苏醒）。
    const pre = nyMs(2024, 6, 1, 2, 59) + 59_000 + 900
    const woke = nyMs(2024, 6, 1, 10, 30)
    let queries = 0
    const clock = (): number => {
      queries++
      return queries <= 3 ? pre : woke
    }
    const sched = new SessionScheduler(clock)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    // 等首个 timer（~150ms 真实时间）到期：fire 03:00 + catchUpMissed 补发 04:00/10:00
    await new Promise((r) => setTimeout(r, 300))
    sched.stop()

    expect(fired).toEqual(['LN:start', 'LN:end', 'AM:start'])
  })
})

describe('formatSessionAlert', () => {
  it('开始与结束消息含会话与北京时间', () => {
    const ms = nyMs(2024, 6, 1, 3, 0)
    const s = formatSessionAlert('LN', 'start', ms)
    expect(s).toContain('LN 会话开始')
    expect(s).toContain('LN（03-04 NY）')
    expect(s).toContain('时间：')
    const e = formatSessionAlert('LN', 'end', ms + 3600_000)
    expect(e).toContain('LN 会话结束')
  })
})