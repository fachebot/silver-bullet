// 市场开闭状态：优先联网 FinCal API（fincalapi.com），失败降级本地规则
// 判定时刻 = 实际触发时刻（now），半天日若已过收盘点则视为已收市

import { DateTime } from 'luxon'

import { getLogger } from '../log/logger.js'
import { getMarketDay, type MarketMic } from './holidays.js'
import type { HttpClient } from '../data/httpClient.js'

// 市场阶段（供消息格式化）
export type MarketPhase = 'holiday' | 'before-open' | 'open' | 'open-early' | 'closed' | 'closed-early'

export interface MarketStatus {
  phase: MarketPhase
  openTime: string | null // "HH:mm" 市场本地时区，休市为 null
  closeTime: string | null
  source: 'api' | 'local'
}

export interface MarketCalendarConfig {
  statusApiBase: string
  apiKey: string // FinCal API key（fincal_live_...）
  cacheSeconds: number
  useLocalFallback: boolean
}

// FinCal 日历名（XNYS→NYSE、XLON→LSE）与市场标准交易时段（市场本地时区）
const FINCAL_CAL: Record<MarketMic, { calendar: string; tz: string; open: string; close: string }> = {
  XNYS: { calendar: 'NYSE', tz: 'America/New_York', open: '09:30', close: '16:00' },
  XLON: { calendar: 'LSE', tz: 'Europe/London', open: '08:00', close: '16:30' },
}

interface FinCalDayStatus {
  date?: string
  calendar?: string
  status?: string // open / early_close / full_close
  is_holiday?: boolean
  is_early_close?: boolean
  is_weekend?: boolean
  close_time?: string | null // 半天日收盘（市场本地 HH:mm），否则 null
}

// 本地规则判定
function localStatus(mic: MarketMic, now: DateTime): MarketStatus {
  const day = getMarketDay(mic, now)
  if (day.isHoliday) {
    return { phase: 'holiday', openTime: null, closeTime: null, source: 'local' }
  }
  const openT = day.openTime.toFormat('HH:mm')
  const closeT = day.closeTime.toFormat('HH:mm')
  const phase: MarketPhase = now < day.openTime
    ? 'before-open'
    : now < day.closeTime
      ? day.isEarlyClose ? 'open-early' : 'open'
      : day.isEarlyClose ? 'closed-early' : 'closed'
  return { phase, openTime: openT, closeTime: closeT, source: 'local' }
}

// 用 market 本地时区比较 now 与 open/close（"HH:mm"），返回相位
function phaseFromTimes(now: DateTime, tz: string, open: string, close: string, early: boolean): MarketPhase {
  const hm = now.setZone(tz).toFormat('HH:mm')
  if (hm < open) return 'before-open'
  if (hm < close) return early ? 'open-early' : 'open'
  return early ? 'closed-early' : 'closed'
}

// 联网 API 判定（FinCal /v1/day_status）；失败/缺字段抛错交由调用方降级
async function apiStatus(mic: MarketMic, now: DateTime, http: HttpClient, base: string, apiKey: string): Promise<MarketStatus> {
  if (!apiKey) throw new Error('未配置 market.apiKey')
  const { calendar, tz, open, close } = FINCAL_CAL[mic]
  const date = now.setZone(tz).toFormat('yyyy-MM-dd')
  const url = `${base}/v1/day_status?date=${date}&calendar=${calendar}`
  const raw = (await http.getJson(url, { Authorization: `Bearer ${apiKey}` })) as FinCalDayStatus

  if (raw.is_holiday || raw.is_weekend) {
    return { phase: 'holiday', openTime: null, closeTime: null, source: 'api' }
  }
  const early = raw.is_early_close ?? false
  const closeTime = early ? (raw.close_time ?? close) : close
  const phase = phaseFromTimes(now, tz, open, closeTime, early)
  return { phase, openTime: open, closeTime, source: 'api' }
}

// 统一入口：API 优先，失败降级本地；同市场按 cacheSeconds 缓存
export function createMarketStatusResolver(cfg: MarketCalendarConfig, http: HttpClient): (mic: MarketMic, now?: DateTime) => Promise<MarketStatus> {
  const cache = new Map<MarketMic, { status: MarketStatus; expiresAt: number }>()
  const base = cfg.statusApiBase.replace(/\/+$/, '')

  return async (mic, now = DateTime.now().setZone('America/New_York')): Promise<MarketStatus> => {
    const cached = cache.get(mic)
    if (cached && Date.now() < cached.expiresAt) return cached.status

    let status: MarketStatus
    try {
      status = await apiStatus(mic, now, http, base, cfg.apiKey)
    } catch (err) {
      if (!cfg.useLocalFallback) throw err
      getLogger().warn(`[市场] ${mic} API 查询失败，降级本地规则: ${(err as Error).message}`)
      status = localStatus(mic, now)
    }
    cache.set(mic, { status, expiresAt: Date.now() + cfg.cacheSeconds * 1000 })
    return status
  }
}

export { localStatus }