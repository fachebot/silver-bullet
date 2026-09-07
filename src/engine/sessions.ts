// Silver Bullet 会话判定：对应 Pine 的 timeSess / is_in_SB / strSB / endSB 等
//   SB_LN_per = "America/New_York".timeSess("0300-0400")
//   SB_AM_per = "America/New_York".timeSess("1000-1100")
//   SB_PM_per = "America/New_York".timeSess("1400-1500")
// 按 bar 开盘时间（UTC 毫秒）转换到 America/New_York 本地时刻，判断是否落在会话区间 [开始, 结束)

import { DateTime } from 'luxon'

export const SB_SESSIONS = {
  LN: { start: '03:00', end: '04:00' },
  AM: { start: '10:00', end: '11:00' },
  PM: { start: '14:00', end: '15:00' },
} as const

// 单 bar 的会话标志（含上一 bar 派生的 start/end 沿）
export interface SessionFlags {
  isInSB: boolean
  ln: boolean
  am: boolean
  pm: boolean
  strSB: boolean
  endSB: boolean
  strLN: boolean
  endLN: boolean
  strAM: boolean
  endAM: boolean
  strPM: boolean
  endPM: boolean
  // 上一 bar 的 endSB（对应 Pine 的 endSB[1]）
  endSB1: boolean
}

// 判断 utcMs 是否落在 "HH:MM"~"HH:MM"（America/New_York）区间内（左闭右开）
export function inSession(utcMs: number, start: string, end: string): boolean {
  const dt = DateTime.fromMillis(utcMs, { zone: 'America/New_York' })
  const minutes = dt.hour * 60 + dt.minute
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const startM = sh * 60 + sm
  const endM = eh * 60 + em
  return minutes >= startM && minutes < endM
}

// 空会话标志（首根 bar 的"上一根"）
export function emptySessionFlags(): SessionFlags {
  return {
    isInSB: false,
    ln: false,
    am: false,
    pm: false,
    strSB: false,
    endSB: false,
    strLN: false,
    endLN: false,
    strAM: false,
    endAM: false,
    strPM: false,
    endPM: false,
    endSB1: false,
  }
}

// 计算当前 bar 的会话标志（需传入上一 bar 的标志）
export function computeSessions(prev: SessionFlags, utcMs: number): SessionFlags {
  const ln = inSession(utcMs, SB_SESSIONS.LN.start, SB_SESSIONS.LN.end)
  const am = inSession(utcMs, SB_SESSIONS.AM.start, SB_SESSIONS.AM.end)
  const pm = inSession(utcMs, SB_SESSIONS.PM.start, SB_SESSIONS.PM.end)
  const isInSB = ln || am || pm

  return {
    isInSB,
    ln,
    am,
    pm,
    // 进入/离开会话的沿检测（Pine: X and not X[1]）
    strSB: isInSB && !prev.isInSB,
    endSB: !isInSB && prev.isInSB,
    strLN: ln && !prev.ln,
    endLN: !ln && prev.ln,
    strAM: am && !prev.am,
    endAM: !am && prev.am,
    strPM: pm && !prev.pm,
    endPM: !pm && prev.pm,
    endSB1: prev.endSB,
  }
}