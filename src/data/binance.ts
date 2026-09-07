// Binance USD-M 期货（fapi）数据源：实现 DataSource 接口
// 参考文档：https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api

import BigNumber from 'bignumber.js'
import WebSocket from 'ws'
import { ProxyAgent } from 'proxy-agent'

import type { DataSource, KlineRequest, ProxyConfig } from './exchange.js'
import type { Kline } from './types.js'
import { createHttpClient, buildProxyUrl, type HttpClient } from './httpClient.js'
import { loadCachedKlines, saveCachedKlines } from './cache.js'
import { getLogger } from '../log/logger.js'

export const DEFAULT_BASE_URL = 'https://fapi.binance.com'
export const DEFAULT_WS_URL = 'wss://fstream.binance.com'

// Binance 支持的周期 → 毫秒
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
}

const MAX_LIMIT = 1500

// 单次分页拉取的最大 bar 数（Binance 上限 1500）
export interface BinanceSourceOptions {
  baseUrl?: string | null
  proxy?: ProxyConfig | null
}

// 解析原始 K 线行：[开盘时间, O, H, L, C, V, 收盘时间, ...]
function parseKline(raw: unknown[]): Kline {
  return {
    time: Number(raw[0]),
    open: new BigNumber(String(raw[1])),
    high: new BigNumber(String(raw[2])),
    low: new BigNumber(String(raw[3])),
    close: new BigNumber(String(raw[4])),
    volume: new BigNumber(String(raw[5])),
  }
}

export class BinanceSource implements DataSource {
  readonly name = 'binance'
  private readonly baseUrl: string
  private readonly http: HttpClient
  private readonly wsAgent: InstanceType<typeof ProxyAgent> | undefined

  constructor(opts: BinanceSourceOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.http = createHttpClient(opts.proxy)
    // WebSocket 代理（与 REST 一致：配置代理时走代理）
    if (opts.proxy?.url) {
      this.wsAgent = new ProxyAgent({ getProxyForUrl: () => buildProxyUrl(opts.proxy!) })
    }
  }

  // 周期 → 毫秒（非法周期抛错）
  intervalToMs(interval: string): number {
    const ms = INTERVAL_MS[interval]
    if (ms === undefined) {
      throw new Error(`不支持的周期: ${interval}（可选: ${Object.keys(INTERVAL_MS).join(', ')}）`)
    }
    return ms
  }

  // 查询 symbol 的价格精度（PRICE_FILTER.tickSize）→ mintick
  async fetchTickSize(symbol: string): Promise<BigNumber> {
    const url = `${this.baseUrl}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(symbol)}`
    const data = (await this.http.getJson(url)) as {
      symbols?: Array<{ symbol: string; filters?: Array<{ filterType: string; tickSize?: string }> }>
    }
    const sym = data.symbols?.find((s) => s.symbol === symbol)
    if (!sym) throw new Error(`exchangeInfo 中找不到 symbol: ${symbol}`)
    const priceFilter = sym.filters?.find((f) => f.filterType === 'PRICE_FILTER')
    if (!priceFilter?.tickSize) throw new Error(`symbol ${symbol} 缺少 PRICE_FILTER/tickSize`)
    return new BigNumber(priceFilter.tickSize)
  }

  // 拉取历史 K 线（自动分页 + 本地缓存）。未指定 endTime 时以当前时间为准。
  async fetchKlines(req: KlineRequest): Promise<Kline[]> {
    const intervalMs = this.intervalToMs(req.interval)
    // 默认 endTime 向下取整到周期边界，保证缓存键稳定（K 线本身按周期对齐）
    const endTime = req.endTime ?? Math.floor(Date.now() / intervalMs) * intervalMs

    // 未指定 startTime 时，默认取最近 30 天（足够覆盖多轮 Silver Bullet 会话）
    const startTime = req.startTime ?? endTime - 30 * 24 * 60 * 60 * 1000

    const cached = loadCachedKlines(this.name, req, startTime, endTime)
    if (cached !== null) {
      getLogger().info(`[数据] 命中本地缓存: ${req.symbol} ${req.interval}`)
      return cached
    }

    const bars: Kline[] = []
    let cursor = startTime
    let guard = 0
    while (cursor < endTime) {
      if (++guard > 2000) throw new Error('分页次数超限，请检查时间范围')
      const url =
        `${this.baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(req.symbol)}` +
        `&interval=${req.interval}&limit=${MAX_LIMIT}&startTime=${cursor}&endTime=${endTime}`
      const raw = (await this.http.getJson(url)) as unknown[][]
      if (!Array.isArray(raw) || raw.length === 0) break
      const parsed = raw.map(parseKline)
      bars.push(...parsed)
      const lastTime = parsed[parsed.length - 1].time
      const next = lastTime + intervalMs
      if (next <= cursor) break // 避免死循环
      cursor = next
    }

    // 去重 + 按时间升序
    const seen = new Set<number>()
    const unique = bars
      .filter((b) => {
        if (seen.has(b.time)) return false
        seen.add(b.time)
        return true
      })
      .sort((a, b) => a.time - b.time)

    saveCachedKlines(this.name, req, startTime, endTime, unique)
    getLogger().info(`[数据] 拉取完成: ${req.symbol} ${req.interval} 共 ${unique.length} 根 K 线`)
    return unique
  }

  // 拉取最近 N 根 K 线（含进行中的 bar，不走缓存；实时轮询兜底用）
  async fetchRecentKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    this.intervalToMs(interval)
    const url =
      `${this.baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${interval}&limit=${Math.min(limit, 1500)}`
    const raw = (await this.http.getJson(url)) as unknown[][]
    if (!Array.isArray(raw)) return []
    return raw.map(parseKline)
  }

  // 订阅多个 symbol 的已收盘 K 线（合并流 /market/stream，单连接）
  // 断线自动重连（指数退避，1s→60s 封顶）；重连成功后调用 onReconnect（用于补数）
  // error 也会触发重连（不再依赖 close）；取消后不再重连
  subscribeClosedKlines(
    symbols: string[],
    interval: string,
    onBar: (symbol: string, bar: Kline) => void,
    onReconnect?: () => void,
  ): () => void {
    this.intervalToMs(interval)
    const list = symbols
      .filter((s) => s.trim() !== '')
      .map((s) => `${s.toLowerCase()}@kline_${interval}`)
    if (list.length === 0) return () => {}
    // 注意：2026-04-23 起旧 /stream、/ws 路径退役，市场流需用 /market 前缀
    const url = `${DEFAULT_WS_URL}/market/stream?streams=${list.join('/')}`
    const options = this.wsAgent ? { agent: this.wsAgent } : undefined

    let ws: WebSocket | null = null
    let stopped = false
    let reconnectDelay = 1000
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let isFirstConnect = true
    // 推送计数（心跳汇总用）
    let totalMsg = 0
    let lastMsgTime = 0
    const msgCount = new Map<string, number>()

    // 每 30s 输出推送心跳，确认数据持续推送
    const heartbeat = setInterval(() => {
      if (stopped) return
      if (totalMsg === 0) {
        getLogger().warn('[WS] 近 30s 无推送（可能被网络阻断或未订阅成功）')
      } else {
        const parts = [...msgCount.entries()].map(([s, n]) => `${s}:${n}`).join(' ')
        getLogger().info(`[WS] 推送正常：30s 内 ${totalMsg} 条（${parts}）`)
      }
      totalMsg = 0
      msgCount.clear()
    }, 30_000)

    const scheduleReconnect = (): void => {
      if (stopped || reconnectTimer !== null) return // 已有重连计划则跳过
      getLogger().warn(`[WS] 连接断开，${reconnectDelay}ms 后重连`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
    }

    const connect = (): void => {
      if (stopped) return
      ws = new WebSocket(url, options)
      ws.on('open', () => {
        reconnectDelay = 1000
        reconnectTimer = null
        getLogger().info(`[WS] 已连接（${symbols.join(', ')}）`)
        // 重连成功后触发补数（首次连接不补）
        if (!isFirstConnect) {
          getLogger().info('[WS] 重连成功，触发补数')
          try {
            onReconnect?.()
          } catch (err) {
            getLogger().error(`[WS] 补数回调异常: ${(err as Error).message}`)
          }
        }
        isFirstConnect = false
      })
      ws.on('message', (data) => {
        try {
          const text = data.toString()
          const upd = parseKlineUpdate(text)
          if (upd) {
            msgCount.set(upd.symbol, (msgCount.get(upd.symbol) ?? 0) + 1)
            totalMsg++
            lastMsgTime = Date.now()
            if (upd.closed) {
              getLogger().info(`[WS] 收盘 ${upd.symbol} ${new Date(upd.time).toISOString()} close=${upd.close.toString()}`)
              onBar(upd.symbol, upd.bar)
            } else {
              getLogger().debug(`[WS] 推送 ${upd.symbol} ${new Date(upd.time).toISOString()} close=${upd.close.toString()}（进行中）`)
            }
          } else {
            getLogger().debug(`[WS] 其它消息: ${text.slice(0, 120)}`)
          }
        } catch (err) {
          getLogger().error(`[WS] 消息解析失败: ${(err as Error).message}`)
        }
      })
      ws.on('close', () => {
        if (stopped) return
        scheduleReconnect()
      })
      ws.on('error', (err) => {
        getLogger().error(`[WS] 错误: ${err.message}`)
        if (stopped) return
        // error 通常伴随 close；这里主动 terminate + 安排重连，避免仅依赖 close
        try {
          ws?.terminate()
        } catch {
          // 忽略
        }
        scheduleReconnect()
      })
    }
    connect()

    return () => {
      stopped = true
      clearInterval(heartbeat)
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      try {
        ws?.close()
      } catch {
        // 忽略
      }
    }
  }
}

// 宽松解析 WS kline 消息（含进行中）：支持单流 { k } 与合并流 { stream, data: { s, k } }
export interface KlineUpdate {
  symbol: string
  time: number
  close: BigNumber
  closed: boolean
  bar: Kline
}

export function parseKlineUpdate(raw: string): KlineUpdate | null {
  const msg = JSON.parse(raw) as {
    stream?: string
    data?: { s?: string; k?: KlinePayload }
    k?: KlinePayload
  }
  const symbol = msg.data?.s ?? symbolFromStream(msg.stream)
  const k = msg.data?.k ?? msg.k
  if (!k || k.t === undefined || k.o === undefined || k.h === undefined || k.l === undefined || k.c === undefined) {
    return null // 不完整的 kline 消息
  }
  const bar: Kline = {
    time: k.t ?? 0,
    open: new BigNumber(String(k.o)),
    high: new BigNumber(String(k.h)),
    low: new BigNumber(String(k.l)),
    close: new BigNumber(String(k.c)),
    volume: new BigNumber(String(k.v)),
  }
  return { symbol: symbol ?? '', time: bar.time, close: bar.close, closed: k.x === true, bar }
}

// 解析 WS kline 消息：仅收盘（k.x === true）返回 { symbol, bar }
export function parseKlineMessage(raw: string): { symbol: string; bar: Kline } | null {
  const upd = parseKlineUpdate(raw)
  if (!upd || !upd.closed) return null
  return { symbol: upd.symbol, bar: upd.bar }
}

interface KlinePayload {
  t?: number
  o?: string
  h?: string
  l?: string
  c?: string
  v?: string
  x?: boolean
}

// 从合并流 stream 名提取 symbol（btcusdt@kline_5m → btcusdt）
function symbolFromStream(stream?: string): string | undefined {
  if (!stream) return undefined
  const at = stream.indexOf('@')
  return at === -1 ? undefined : stream.slice(0, at)
}