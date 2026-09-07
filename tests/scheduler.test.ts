// 测试：会话边界整点调度器 + 消息格式化

import { describe, it, expect, afterEach } from 'vitest'
import { DateTime } from 'luxon'

import { nextBoundary, SessionScheduler } from '../src/monitor/scheduler.js'
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

describe('SessionScheduler', () => {
  const fired: string[] = []
  let sched: SessionScheduler | null = null

  afterEach(() => {
    sched?.stop()
    fired.length = 0
  })

  it('启动时补发最近 60s 内错过的边界（全局一次）', () => {
    // 模拟 03:00:30 启动 → 补发 LN start 03:00
    const start = nyMs(2024, 6, 1, 3, 0) + 30_000
    sched = new SessionScheduler(() => start)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    expect(fired).toContain('LN:start')
  })

  it('同一边界只触发一次（去重）', () => {
    const start = nyMs(2024, 6, 1, 3, 0) + 30_000
    sched = new SessionScheduler(() => start)
    sched.start((b) => fired.push(`${b.session}:${b.edge}`))
    sched.start((b) => fired.push(`${b.session}:${b.edge}`)) // 重复 start 不应重复触发同一边界
    expect(fired.filter((x) => x === 'LN:start')).toHaveLength(1)
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