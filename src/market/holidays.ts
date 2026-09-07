// 美股（XNYS）与伦敦（XLON）交易日历：open/close 时间 + 法定假日（周末顺延）+ 半天日
// 纯规则计算（无硬编码年份表），跨年稳定；时间均为各市场本地时区

import { DateTime } from 'luxon'

export type MarketMic = 'XNYS' | 'XLON'

export interface MarketDay {
  isHoliday: boolean // 休市（周末或法定假日）
  isEarlyClose: boolean // 半天日
  openTime: DateTime // 开盘（本地时区）
  closeTime: DateTime // 收盘（本地时区；半天日为早收盘）
}

const NY_TZ = 'America/New_York'
const LON_TZ = 'Europe/London'

// 返回某年某月的第 n 个星期几（weekday 1=周一..7=周日）
function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  const first = DateTime.fromObject({ year, month, day: 1, hour: 0 }, { zone: NY_TZ })
  let day = first.plus({ days: ((weekday - first.weekday + 7) % 7) })
  day = day.plus({ weeks: n - 1 })
  return day
}

// 耶稣受难日（西方复活节前的星期五）—— 用高斯算法求复活节
function goodFriday(year: number): DateTime {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  // 复活节星期日
  const easter = DateTime.fromObject({ year, month, day }, { zone: NY_TZ })
  return easter.minus({ days: 2 }) // 耶稣受难日 = 复活节前两天
}

// 观测日：若节日落在周末则顺延（美股规则：周六→周五、周日→周一）
function observedNY(d: DateTime): DateTime {
  const wd = d.weekday
  if (wd === 6) return d.minus({ days: 1 }) // 周六 → 周五
  if (wd === 7) return d.plus({ days: 1 }) // 周日 → 周一
  return d
}

// 美股全部假期（返回本地时区的 DateTime 集合，含顺延）
function nyHolidays(year: number): Set<string> {
  const s = new Set<string>()
  const add = (d: DateTime) => s.add(observedNY(d).toISODate() ?? '')
  add(DateTime.fromObject({ year, month: 1, day: 1 }, { zone: NY_TZ })) // 新年
  add(nthWeekday(year, 1, 1, 3)) // MLK 1月第3个周一
  add(nthWeekday(year, 2, 1, 3)) // 总统日 2月第3个周一
  add(goodFriday(year)) // 耶稣受难日
  add(memorialDay(year)) // 阵亡将士纪念日 5月最后周一
  add(DateTime.fromObject({ year, month: 6, day: 19 }, { zone: NY_TZ })) // 六月节
  add(DateTime.fromObject({ year, month: 7, day: 4 }, { zone: NY_TZ })) // 独立日
  add(nthWeekday(year, 9, 1, 1)) // 劳动节 9月第1个周一
  add(nthWeekday(year, 11, 4, 4)) // 感恩节 11月第4个周四
  add(DateTime.fromObject({ year, month: 12, day: 25 }, { zone: NY_TZ })) // 圣诞节
  return s
}

// 某月最后一个指定星期几（weekday 1=周一..7=周日）
function lastWeekdayOfMonth(year: number, month: number, weekday: number): DateTime {
  const end = DateTime.fromObject({ year, month, day: 31 }, { zone: NY_TZ }).endOf('month')
  let d = end
  while (d.weekday !== weekday) d = d.minus({ days: 1 })
  return d
}

// 阵亡将士纪念日：5月最后一个周一
function memorialDay(year: number): DateTime {
  return lastWeekdayOfMonth(year, 5, 1)
}

// 美股半天日（早收盘 13:00）
function nyEarlyClose(d: DateTime): boolean {
  const date = d.toISODate() ?? ''
  // 感恩节次日（11月第4个周五）
  const thx = nthWeekday(d.year, 11, 4, 4)
  if (observedNY(thx.plus({ days: 1 })).toISODate() === date) return true
  // 独立日前一日（7月3日，若顺延则顺延后的前一日）
  const jul4 = observedNY(DateTime.fromObject({ year: d.year, month: 7, day: 4 }, { zone: NY_TZ }))
  if (jul4.minus({ days: 1 }).toISODate() === date && !nyHolidays(d.year).has(date)) return true
  // 圣诞节前一日（12月24日）
  if (d.month === 12 && d.day === 24) return true
  return false
}

// 美股当日 open/close
export function getNyMarketDay(now: DateTime): MarketDay {
  const year = now.year
  const holidays = nyHolidays(year)
  const date = now.toISODate() ?? ''
  const isWeekend = now.weekday === 6 || now.weekday === 7
  const isHoliday = holidays.has(date)

  if (isWeekend || isHoliday) {
    return { isHoliday: true, isEarlyClose: false, openTime: now, closeTime: now }
  }
  const early = nyEarlyClose(now)
  return {
    isHoliday: false,
    isEarlyClose: early,
    openTime: DateTime.fromObject({ year, month: now.month, day: now.day, hour: 9, minute: 30 }, { zone: NY_TZ }),
    closeTime: DateTime.fromObject({ year, month: now.month, day: now.day, hour: early ? 13 : 16, minute: 0 }, { zone: NY_TZ }),
  }
}

// ---- 伦敦 ----
// 英国银行假日（英格兰/威尔士主日历，含 Easter 簇）
function isLondonHoliday(d: DateTime): boolean {
  const date = d.toISODate()
  const y = d.year
  // 通用：周末
  if (d.weekday === 6 || d.weekday === 7) return true
  // 元旦（若在周末则顺延至下一个工作日）
  const ny1 = DateTime.fromObject({ year: y, month: 1, day: 1 }, { zone: LON_TZ })
  const nyObs = ny1.weekday === 6 ? ny1.plus({ days: 2 }) : ny1.weekday === 7 ? ny1.plus({ days: 1 }) : ny1
  if (nyObs.toISODate() === date) return true
  // 耶稣受难日 + 复活节周一
  const gf = goodFriday(y).setZone(LON_TZ)
  if (gf.toISODate() === date) return true
  if (gf.plus({ days: 3 }).toISODate() === date) return true
  // 五月初银行假日（5月第1个周一）
  const firstMon = firstWeekdayOfMonthLon(y, 5, 1)
  if (firstMon.toISODate() === date) return true
  // 春季银行假日（5月最后周一）
  if (lastWeekdayOfMonthLon(y, 5, 1).toISODate() === date) return true
  // 夏季银行假日（8月最后周一）
  if (lastWeekdayOfMonthLon(y, 8, 1).toISODate() === date) return true
  // 圣诞节（12月25日）+ 节礼日（12月26日），若在周末则顺延
  for (const day of [25, 26]) {
    const x = DateTime.fromObject({ year: y, month: 12, day }, { zone: LON_TZ })
    let obs = x
    if (obs.weekday === 6) obs = obs.plus({ days: 2 })
    else if (obs.weekday === 7) obs = obs.plus({ days: 1 })
    if (obs.toISODate() === date) return true
  }
  return false
}

// 伦敦：某月第 1 个指定星期几
function firstWeekdayOfMonthLon(year: number, month: number, weekday: number): DateTime {
  const first = DateTime.fromObject({ year, month, day: 1, hour: 0 }, { zone: LON_TZ })
  return first.plus({ days: ((weekday - first.weekday + 7) % 7) })
}

// 伦敦：某月最后一个指定星期几
function lastWeekdayOfMonthLon(year: number, month: number, weekday: number): DateTime {
  const end = DateTime.fromObject({ year, month, day: 31 }, { zone: LON_TZ }).endOf('month')
  let d = end
  while (d.weekday !== weekday) d = d.minus({ days: 1 })
  return d
}

// 伦敦半天日（早收盘 12:30）
function isLondonEarlyClose(d: DateTime): boolean {
  // 平安夜 12-24、除夕 12-31（若为周末则提前到前一工作日）
  const date = d.toISODate()
  for (const day of [24, 31]) {
    const x = DateTime.fromObject({ year: d.year, month: 12, day }, { zone: LON_TZ })
    let obs = x
    if (obs.weekday === 6) obs = obs.minus({ days: 1 })
    else if (obs.weekday === 7) obs = obs.plus({ days: 1 })
    if (obs.toISODate() === date) return true
  }
  return false
}

// 伦敦当日 open/close
export function getLondonMarketDay(now: DateTime): MarketDay {
  if (isLondonHoliday(now)) {
    return { isHoliday: true, isEarlyClose: false, openTime: now, closeTime: now }
  }
  const early = isLondonEarlyClose(now)
  return {
    isHoliday: false,
    isEarlyClose: early,
    openTime: DateTime.fromObject({ year: now.year, month: now.month, day: now.day, hour: 8, minute: 0 }, { zone: LON_TZ }),
    closeTime: DateTime.fromObject({ year: now.year, month: now.month, day: now.day, hour: early ? 12 : 16, minute: 30 }, { zone: LON_TZ }),
  }
}

// 统一入口：按市场返回当日 open/close（null 处理由调用方）
export function getMarketDay(mic: MarketMic, now: DateTime): MarketDay {
  return mic === 'XNYS' ? getNyMarketDay(now) : getLondonMarketDay(now)
}