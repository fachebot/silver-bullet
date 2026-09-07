// 单元测试：Silver Bullet 会话判定（America/New_York，含 DST）
// EDT = UTC-4（夏令时），EST = UTC-5（冬令时）
//   LN: 03:00-04:00 NY, AM: 10:00-11:00 NY, PM: 14:00-15:00 NY

import { describe, it, expect } from 'vitest'
import { inSession, computeSessions, emptySessionFlags } from '../src/engine/sessions.js'

// 2024-07-01 为 EDT（UTC-4）
const jul = (h: number, m = 0) => Date.UTC(2024, 6, 1, h, m)
// 2024-01-01 为 EST（UTC-5）
const jan = (h: number, m = 0) => Date.UTC(2024, 0, 1, h, m)

describe('inSession（LN 03:00-04:00）', () => {
  it('夏令时：07:00 UTC = 03:00 NY，属于 LN 会话', () => {
    expect(inSession(jul(7), '03:00', '04:00')).toBe(true)
  })
  it('夏令时：06:55 UTC = 02:55 NY，不属于 LN 会话', () => {
    expect(inSession(jul(6, 55), '03:00', '04:00')).toBe(false)
  })
  it('夏令时：08:00 UTC = 04:00 NY，边界右侧不属于（左闭右开）', () => {
    expect(inSession(jul(8), '03:00', '04:00')).toBe(false)
  })
  it('冬令时：08:00 UTC = 03:00 NY，属于 LN 会话', () => {
    expect(inSession(jan(8), '03:00', '04:00')).toBe(true)
  })
  it('冬令时：07:00 UTC = 02:00 NY，不属于', () => {
    expect(inSession(jan(7), '03:00', '04:00')).toBe(false)
  })
  it('AM 会话：14:00 UTC（夏令时）= 10:00 NY', () => {
    expect(inSession(jul(14), '10:00', '11:00')).toBe(true)
  })
  it('PM 会话：18:00 UTC（夏令时）= 14:00 NY', () => {
    expect(inSession(jul(18), '14:00', '15:00')).toBe(true)
  })
})

describe('computeSessions（沿检测）', () => {
  it('会话开始：strSB 在进入会话的 bar 触发', () => {
    const prev = emptySessionFlags()
    const flags = computeSessions(prev, jul(7)) // 07:00 UTC 进入 LN
    expect(flags.isInSB).toBe(true)
    expect(flags.strSB).toBe(true)
    expect(flags.strLN).toBe(true)
  })

  it('会话结束：endSB 在会话结束后第一根 bar 触发', () => {
    const prev = computeSessions(emptySessionFlags(), jul(7))
    expect(prev.endSB).toBe(false)
    const flags = computeSessions(prev, jul(8)) // 08:00 UTC 离开 LN
    expect(flags.isInSB).toBe(false)
    expect(flags.endSB).toBe(true)
    expect(flags.endLN).toBe(true)
  })

  it('endSB1：会话结束后第二根 bar 可读取上一根的 endSB', () => {
    const inSB = computeSessions(emptySessionFlags(), jul(7))
    const after = computeSessions(inSB, jul(8))
    expect(after.endSB1).toBe(false)
    const after2 = computeSessions(after, jul(8, 5))
    expect(after2.endSB1).toBe(true)
  })
})