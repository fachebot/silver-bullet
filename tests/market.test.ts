// 测试：交易日历规则 + 市场开闭状态（API 优先、失败降级本地）+ 通知消息市场行

import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'

import { getMarketDay } from '../src/market/holidays.js'
import { localStatus, createMarketStatusResolver } from '../src/market/marketCalendar.js'
import { formatMarketLine } from '../src/monitor/format.js'
import type { HttpClient } from '../src/data/httpClient.js'

function ny(year: number, month: number, day: number, hour: number, minute = 0): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: 'America/New_York' })
}

function lon(year: number, month: number, day: number, hour: number, minute = 0): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: 'Europe/London' })
}

describe('getMarketDay 美股 XNYS', () => {
  it('普通工作日 09:30-16:00', () => {
    const d = getMarketDay('XNYS', ny(2024, 6, 3, 10))
    expect(d.isHoliday).toBe(false)
    expect(d.isEarlyClose).toBe(false)
    expect(d.openTime.toFormat('HH:mm')).toBe('09:30')
    expect(d.closeTime.toFormat('HH:mm')).toBe('16:00')
  })

  it('周末休市', () => {
    expect(getMarketDay('XNYS', ny(2024, 6, 8, 10)).isHoliday).toBe(true) // 周六
    expect(getMarketDay('XNYS', ny(2024, 6, 9, 10)).isHoliday).toBe(true) // 周日
  })

  it('新年（1/1 周一）休市', () => {
    expect(getMarketDay('XNYS', ny(2024, 1, 1, 10)).isHoliday).toBe(true)
  })

  it('感恩节（2024-11-28）休市，次日半天 13:00', () => {
    expect(getMarketDay('XNYS', ny(2024, 11, 28, 10)).isHoliday).toBe(true)
    const d = getMarketDay('XNYS', ny(2024, 11, 29, 10))
    expect(d.isHoliday).toBe(false)
    expect(d.isEarlyClose).toBe(true)
    expect(d.closeTime.toFormat('HH:mm')).toBe('13:00')
  })

  it('周末落到周日的节日顺延到下周一休市（独立日 7/4 周四为正常交易日）', () => {
    // 2026-07-04 是周六 → 顺延 7/3 周五休市（独立日观察日）
    expect(getMarketDay('XNYS', ny(2026, 7, 3, 10)).isHoliday).toBe(true)
    // 2026-07-04 周六本身是周末
    expect(getMarketDay('XNYS', ny(2026, 7, 4, 10)).isHoliday).toBe(true)
  })
})

describe('getMarketDay 伦敦 XLON', () => {
  it('普通工作日 08:00-16:30', () => {
    const d = getMarketDay('XLON', lon(2024, 6, 3, 10))
    expect(d.isHoliday).toBe(false)
    expect(d.closeTime.toFormat('HH:mm')).toBe('16:30')
  })

  it('周末休市', () => {
    expect(getMarketDay('XLON', lon(2024, 6, 8, 10)).isHoliday).toBe(true)
  })

  it('耶稣受难日（2024-03-29）休市', () => {
    expect(getMarketDay('XLON', lon(2024, 3, 29, 10)).isHoliday).toBe(true)
  })

  it('复活节周一（2024-04-01）休市', () => {
    expect(getMarketDay('XLON', lon(2024, 4, 1, 10)).isHoliday).toBe(true)
  })

  it('春季银行假日（2024-05-27 最后周一）休市', () => {
    expect(getMarketDay('XLON', lon(2024, 5, 27, 10)).isHoliday).toBe(true)
  })

  it('夏季银行假日（2024-08-26 最后周一）休市', () => {
    expect(getMarketDay('XLON', lon(2024, 8, 26, 10)).isHoliday).toBe(true)
  })

  it('圣诞节（12-25）与节礼日（12-26）休市；12-24 平安夜半天 12:30', () => {
    expect(getMarketDay('XLON', lon(2024, 12, 25, 10)).isHoliday).toBe(true)
    expect(getMarketDay('XLON', lon(2024, 12, 26, 10)).isHoliday).toBe(true)
    const d = getMarketDay('XLON', lon(2024, 12, 24, 10))
    expect(d.isHoliday).toBe(false)
    expect(d.isEarlyClose).toBe(true)
    expect(d.closeTime.toFormat('HH:mm')).toBe('12:30')
  })
})

describe('localStatus 判定时刻', () => {
  it('盘中 → open；半天日午后已收市', () => {
    const s = localStatus('XNYS', ny(2024, 11, 29, 11, 0)) // 感恩节次日半天 13:00，11:00 未到收盘
    expect(s.phase).toBe('open-early')
    const s2 = localStatus('XNYS', ny(2024, 11, 29, 14, 0)) // 14:00 已过 13:00 收盘
    expect(s2.phase).toBe('closed-early')
  })

  it('休市日 → holiday', () => {
    expect(localStatus('XNYS', ny(2024, 6, 8, 10)).phase).toBe('holiday') // 周六
  })

  it('普通日收盘后 → closed', () => {
    expect(localStatus('XNYS', ny(2024, 6, 3, 17, 0)).phase).toBe('closed')
  })

  it('盘前 → before-open', () => {
    expect(localStatus('XNYS', ny(2024, 6, 3, 8, 0)).phase).toBe('before-open')
  })
})

describe('createMarketStatusResolver', () => {
  const cfg = { statusApiBase: 'https://fincalapi.com', apiKey: 'fincal_live_test', cacheSeconds: 300, useLocalFallback: true }

  function fakeHttp(handler: (url: string) => unknown): HttpClient {
    return { getJson: (url) => Promise.resolve(handler(url)), postJson: () => Promise.resolve(null) }
  }

  it('API 正常日：取 API 结果（source=api）', async () => {
    const http = fakeHttp(() => ({ status: 'open', is_holiday: false, is_early_close: false, is_weekend: false, close_time: null }))
    const resolve = createMarketStatusResolver(cfg, http)
    const s = await resolve('XNYS', ny(2024, 6, 3, 12, 0))
    expect(s.source).toBe('api')
    expect(s.phase).toBe('open')
    expect(s.closeTime).toBe('16:00')
    expect(s.openTime).toBe('09:30')
  })

  it('API 半天日已收市 → closed-early（close_time 13:00）', async () => {
    const http = fakeHttp(() => ({ status: 'early_close', is_holiday: false, is_early_close: true, is_weekend: false, close_time: '13:00' }))
    const resolve = createMarketStatusResolver(cfg, http)
    const s = await resolve('XNYS', ny(2024, 11, 29, 14, 0))
    expect(s.source).toBe('api')
    expect(s.phase).toBe('closed-early')
    expect(s.closeTime).toBe('13:00')
  })

  it('API 半天日盘中 → open-early', async () => {
    const http = fakeHttp(() => ({ status: 'early_close', is_holiday: false, is_early_close: true, is_weekend: false, close_time: '13:00' }))
    const resolve = createMarketStatusResolver(cfg, http)
    const s = await resolve('XNYS', ny(2024, 11, 29, 11, 0))
    expect(s.phase).toBe('open-early')
  })

  it('API 返回 full_close → holiday', async () => {
    const http = fakeHttp(() => ({ status: 'full_close', is_holiday: true, is_early_close: false, is_weekend: false, close_time: null }))
    const resolve = createMarketStatusResolver(cfg, http)
    const s = await resolve('XNYS', ny(2024, 11, 28, 12, 0))
    expect(s.phase).toBe('holiday')
    expect(s.closeTime).toBeNull()
  })

  it('API 请求带 Bearer key 且 URL 含日期与日历', async () => {
    let captured = ''
    const http = fakeHttp((url) => {
      captured = url
      return { status: 'open', is_holiday: false, is_early_close: false, is_weekend: false, close_time: null }
    })
    const resolve = createMarketStatusResolver(cfg, http)
    await resolve('XLON', lon(2024, 6, 3, 12, 0))
    expect(captured).toContain('/v1/day_status')
    expect(captured).toContain('date=2024-06-03')
    expect(captured).toContain('calendar=LSE')
  })

  it('API 失败 → 降级本地（source=local）', async () => {
    const http = fakeHttp(() => {
      throw new Error('network down')
    })
    const resolve = createMarketStatusResolver(cfg, http)
    const s = await resolve('XNYS', ny(2024, 6, 3, 12, 0))
    expect(s.source).toBe('local')
    expect(s.phase).toBe('open')
  })

  it('未配置 apiKey → 降级本地', async () => {
    const http = fakeHttp(() => ({ status: 'open', is_holiday: false, is_early_close: false, is_weekend: false, close_time: null }))
    const resolve = createMarketStatusResolver({ ...cfg, apiKey: '' }, http)
    const s = await resolve('XNYS', ny(2024, 6, 3, 12, 0))
    expect(s.source).toBe('local')
  })

  it('缓存生效：同市场再次查询不重复调用 API', async () => {
    let calls = 0
    const http = fakeHttp(() => {
      calls++
      return { status: 'open', is_holiday: false, is_early_close: false, is_weekend: false, close_time: null }
    })
    const resolve = createMarketStatusResolver(cfg, http)
    await resolve('XNYS', ny(2024, 6, 3, 12, 0))
    await resolve('XNYS', ny(2024, 6, 3, 12, 30))
    expect(calls).toBe(1)
  })

  it('useLocalFallback=false 时 API 失败直接抛错', async () => {
    const http = fakeHttp(() => {
      throw new Error('boom')
    })
    const resolve = createMarketStatusResolver({ ...cfg, useLocalFallback: false }, http)
    await expect(resolve('XNYS', ny(2024, 6, 3, 12, 0))).rejects.toThrow('boom')
  })
})

describe('formatMarketLine', () => {
  it('各阶段文案', () => {
    expect(formatMarketLine('纽约早盘', { phase: 'open', openTime: '09:30', closeTime: '16:00', source: 'local' })).toBe('纽约早盘：当前已开盘')
    expect(formatMarketLine('纽约早盘', { phase: 'open-early', openTime: '09:30', closeTime: '13:00', source: 'api' })).toBe('纽约早盘：当前已开盘（今日半天 13:00 收市）')
    expect(formatMarketLine('纽约早盘', { phase: 'closed-early', openTime: '09:30', closeTime: '13:00', source: 'local' })).toBe('纽约早盘：已收市（今日半天 13:00）')
    expect(formatMarketLine('纽约早盘', { phase: 'closed', openTime: '09:30', closeTime: '16:00', source: 'local' })).toBe('纽约早盘：已收市（16:00）')
    expect(formatMarketLine('伦敦盘', { phase: 'before-open', openTime: '08:00', closeTime: '16:30', source: 'local' })).toBe('伦敦盘：尚未开盘（08:00 开盘）')
    expect(formatMarketLine('伦敦盘', { phase: 'holiday', openTime: null, closeTime: null, source: 'local' })).toBe('伦敦盘：今日未开盘（休市）')
  })
})