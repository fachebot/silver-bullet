// 通用 K 线本地缓存：缓存键含交易所名，避免不同交易所同 symbol 互相串数据

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import BigNumber from 'bignumber.js'

import type { Kline, CacheFile } from './types.js'
import type { KlineRequest } from './exchange.js'

const cacheDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache')

// 缓存键：exchange_symbol_interval_start_end
function cacheKey(
  exchange: string,
  req: KlineRequest,
  startTime: number,
  endTime: number,
): string {
  return `${exchange}_${req.symbol}_${req.interval}_${startTime}_${endTime}.json`
}

// 从缓存加载（若存在且未要求刷新）
export function loadCachedKlines(
  exchange: string,
  req: KlineRequest,
  startTime: number,
  endTime: number,
): Kline[] | null {
  if (req.refresh) return null
  const path = join(cacheDir, cacheKey(exchange, req, startTime, endTime))
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as CacheFile
    // meta 全量校验：除 exchange/symbol/interval 外，还须与请求的时间窗一致（防手工改动/时间窗不匹配时静默返回错误范围）
    const meta = data.meta
    if (
      meta.exchange !== exchange ||
      meta.symbol !== req.symbol ||
      meta.interval !== req.interval ||
      meta.startTime !== startTime ||
      meta.endTime !== endTime
    ) {
      return null
    }
    const bars = data.bars.map((b) => ({
      time: b[0],
      open: new BigNumber(b[1]),
      high: new BigNumber(b[2]),
      low: new BigNumber(b[3]),
      close: new BigNumber(b[4]),
      volume: new BigNumber(b[5]),
    }))
    // 数据须升序（乱序/损坏视为脏缓存，走网络重拉）
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].time <= bars[i - 1].time) return null
    }
    return bars
  } catch {
    return null
  }
}

// 写入缓存
export function saveCachedKlines(
  exchange: string,
  req: KlineRequest,
  startTime: number,
  endTime: number,
  bars: Kline[],
): void {
  mkdirSync(cacheDir, { recursive: true })
  const data: CacheFile = {
    meta: {
      exchange,
      symbol: req.symbol,
      interval: req.interval,
      startTime,
      endTime,
      fetchedAt: new Date().toISOString(),
    },
    bars: bars.map((b) => [
      b.time,
      b.open.toString(),
      b.high.toString(),
      b.low.toString(),
      b.close.toString(),
      b.volume.toString(),
    ]),
  }
  writeFileSync(join(cacheDir, cacheKey(exchange, req, startTime, endTime)), JSON.stringify(data), 'utf-8')
}