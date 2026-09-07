// 实时监控核心：多币种 WS 订阅 → 引擎增量 feedBar → killzone 收盘 FVG → Lark 加急通知

import type { Config } from '../config/types.js'
import { deriveConfig } from '../config/load.js'
import type { DataSource } from '../data/exchange.js'
import type { Kline } from '../data/types.js'
import { createHttpClient } from '../data/httpClient.js'
import { Engine } from '../engine/engine.js'
import { getLogger } from '../log/logger.js'
import { gradeFvg } from './grade.js'
import { formatFvgAlert, formatSessionAlert } from './format.js'
import { SessionScheduler } from './scheduler.js'
import type { LarkClient } from './lark.js'
import { createMarketStatusResolver, type MarketStatus } from '../market/marketCalendar.js'
import type { MarketMic } from '../market/holidays.js'
import type { DateTime } from 'luxon'

// 会话 → 市场映射（LN=伦敦早盘、AM=纽约早盘、PM=纽约午盘）
const MARKET_BY_SESSION: Record<'LN' | 'AM' | 'PM', { mic: MarketMic; name: string }> = {
  LN: { mic: 'XLON', name: '伦敦盘' },
  AM: { mic: 'XNYS', name: '纽约早盘' },
  PM: { mic: 'XNYS', name: '纽约午盘' },
}

export interface MonitorContext {
  config: Config
  engines: Map<string, Engine>
  lastProcessed: Map<string, number>
  marketStatus?: (mic: MarketMic, now?: DateTime) => Promise<MarketStatus>
}

// 解析某会话对应市场的开闭状态（失败返回 null，不阻断告警）
async function resolveMarketStatus(
  ctx: MonitorContext,
  session: 'LN' | 'AM' | 'PM',
): Promise<{ mic: MarketMic; name: string; status?: MarketStatus }> {
  const m = MARKET_BY_SESSION[session]
  if (!ctx.marketStatus) return { mic: m.mic, name: m.name }
  try {
    return { mic: m.mic, name: m.name, status: await ctx.marketStatus(m.mic) }
  } catch (err) {
    getLogger().warn(`[市场] ${m.mic} 状态查询失败: ${(err as Error).message}`)
    return { mic: m.mic, name: m.name }
  }
}

// 处理一根新收盘 bar（去重 → feedBar → 检测 killzone FVG → 生成并发送告警）
// 返回生成的告警文本（便于测试）
export async function handleClosedBar(
  ctx: MonitorContext,
  symbol: string,
  bar: Kline,
  lark: LarkClient,
): Promise<string[]> {
  const logger = getLogger()
  const last = ctx.lastProcessed.get(symbol) ?? 0
  if (bar.time <= last) return [] // 重复/历史 bar
  ctx.lastProcessed.set(symbol, bar.time)

  const engine = ctx.engines.get(symbol)
  if (!engine) return []

  const res = engine.feedBar(bar)
  const alerts: string[] = []
  if (res.inSb && res.createdFvgs.length > 0 && res.session) {
    const market = await resolveMarketStatus(ctx, res.session)
    for (const fvg of res.createdFvgs) {
      const grade = gradeFvg(res.trend, fvg.type, res.close, fvg.top, fvg.bottom)
      const msg = formatFvgAlert({
        symbol,
        session: res.session,
        time: res.time,
        close: res.close,
        fvg,
        grade,
        marketName: market.name,
        marketStatus: market.status,
      })
      alerts.push(msg)
      logger.info(`[监控] ${symbol} ${res.session} FVG 触发（${grade.stars}星 ${grade.label}）`)
      await lark.notify(msg)
    }
  }
  return alerts
}

// 断线补数：WS 重连后，用 REST 拉取 (lastProcessed, now] 内已收盘 bar 逐个处理（去重安全）
// 返回补数触发的告警数
export async function catchUpAfterReconnect(
  ctx: MonitorContext,
  source: DataSource,
  symbol: string,
  interval: string,
  lark: LarkClient,
  now: () => number = () => Date.now(),
): Promise<number> {
  const logger = getLogger()
  const intervalMs = source.intervalToMs(interval)
  const last = ctx.lastProcessed.get(symbol) ?? 0
  // 无基准（预热异常/从未处理过 bar）时不拉全史，等 WS/轮询自然推进首根 bar 建立基准
  if (last <= 0) {
    logger.warn(`[监控] ${symbol} lastProcessed 为空，跳过断线补数（等待实时数据建立基准）`)
    return 0
  }
  const nowFloor = Math.floor(now() / intervalMs) * intervalMs
  if (nowFloor <= last) return 0
  const bars = await source.fetchKlines({
    symbol,
    interval,
    startTime: last + intervalMs,
    endTime: nowFloor,
    refresh: true, // 绕过缓存，确保实时
  })
  let alerts = 0
  for (const bar of bars) {
    alerts += (await handleClosedBar(ctx, symbol, bar, lark)).length
  }
  if (bars.length > 0) {
    logger.info(`[监控] ${symbol} 断线补数 ${bars.length} 根（含 ${alerts} 条告警）`)
  }
  return alerts
}

// REST 轮询兜底：WS 不可用/无推送时，定期拉最近 K 线检测新收盘 bar
// 返回本轮触发的告警数
export async function pollForNewBars(
  ctx: MonitorContext,
  source: DataSource,
  symbol: string,
  interval: string,
  lark: LarkClient,
  now: () => number = () => Date.now(),
): Promise<number> {
  const intervalMs = source.intervalToMs(interval)
  const last = ctx.lastProcessed.get(symbol) ?? 0
  // 拉最近 50 根（5m≈4h 覆盖）：REST 抖动/短暂断流期间漏掉的 bar 会在下次成功轮询时自动补齐，
  // 弱化对"恰好每次轮询都拉到最新收盘 bar + 本地时钟对齐"的依赖。
  // 注：未收盘 bar 会被下方 time + intervalMs <= now() 过滤；交易所只在收盘后才返回已确定 K 线，风险低。
  const recent = await source.fetchRecentKlines(symbol, interval, 50)
  let alerts = 0
  for (const bar of recent) {
    // 仅处理已收盘（bar 结束时间 ≤ 当前）且比 last 新的 bar；handleClosedBar 内部再按 time>last 去重
    if (bar.time > last && bar.time + intervalMs <= now()) {
      alerts += (await handleClosedBar(ctx, symbol, bar, lark)).length
    }
  }
  return alerts
}

// 启动监控：预热各币种引擎 → 订阅 WS（可选）→ REST 轮询兜底
export async function runMonitor(
  config: Config,
  source: DataSource,
  lark: LarkClient,
): Promise<void> {
  const logger = getLogger()
  const interval = config.data.interval
  const intervalMs = source.intervalToMs(interval)
  const warmupMs = config.monitor.warmupDays * 24 * 60 * 60 * 1000

  const ctx: MonitorContext = {
    config,
    engines: new Map(),
    lastProcessed: new Map(),
  }
  // 市场开闭状态解析器（联网 API + 本地降级），供 FVG 告警与会话边界通知附加市场状态
  const proxy = config.data.proxyUrl
    ? { url: config.data.proxyUrl, username: config.data.proxyUsername, password: config.data.proxyPassword }
    : null
  ctx.marketStatus = createMarketStatusResolver(config.market, createHttpClient(proxy))
  const unsubs: Array<() => void> = []

  // 预热：每币种拉历史并 run（静默建状态；live 模式：不累积输出、按存活窗口剪枝 FVG）
  for (const symbol of config.monitor.symbols) {
    const tickSize = await source.fetchTickSize(symbol)
    const engine = new Engine(deriveConfig(config, tickSize), symbol, interval, { live: true })
    const end = Math.floor(Date.now() / intervalMs) * intervalMs
    const start = end - warmupMs
    const hist = await source.fetchKlines({ symbol, interval, startTime: start, endTime: end })
    engine.run(hist)
    const last = hist.length > 0 ? hist[hist.length - 1].time : 0
    ctx.engines.set(symbol, engine)
    ctx.lastProcessed.set(symbol, last)
    logger.info(`[监控] ${symbol} 预热完成：${hist.length} 根 bar`)
  }

  // 订阅 WS（可选，合并流单连接）
  if (config.monitor.useWebSocket) {
    const symbols = config.monitor.symbols
    const unsub = source.subscribeClosedKlines(
      symbols,
      interval,
      (symbol, bar) => {
        void handleClosedBar(ctx, symbol, bar, lark).catch((err) => {
          logger.error(`[监控] ${symbol} 处理失败: ${(err as Error).message}`)
        })
      },
      () => {
        for (const symbol of symbols) {
          void catchUpAfterReconnect(ctx, source, symbol, interval, lark).catch((err) => {
            logger.error(`[监控] ${symbol} 补数失败: ${(err as Error).message}`)
          })
        }
      },
    )
    unsubs.push(unsub)
  }

  // REST 轮询兜底（可选，pollSeconds=0 关闭；与 WS 共享 lastProcessed 去重，不会重复告警）
  const pollTimer =
    config.monitor.pollSeconds > 0
      ? setInterval(() => {
          for (const symbol of config.monitor.symbols) {
            void pollForNewBars(ctx, source, symbol, interval, lark).catch((err) => {
              logger.error(`[监控] ${symbol} 轮询失败: ${(err as Error).message}`)
            })
          }
        }, config.monitor.pollSeconds * 1000)
      : null
  if (pollTimer !== null) unsubs.push(() => clearInterval(pollTimer))

  logger.info(
    `[监控] 已启动：WS=${config.monitor.useWebSocket ? '开' : '关'} 轮询=${config.monitor.pollSeconds > 0 ? config.monitor.pollSeconds + 's' : '关'}，等待 killzone 收盘 FVG...`,
  )

  // 会话边界整点通知（全局一次，加急；附市场开闭状态）
  let scheduler: SessionScheduler | null = null
  if (config.monitor.notifySessionBoundary) {
    scheduler = new SessionScheduler()
    scheduler.start((b) => {
      void (async () => {
        const market = await resolveMarketStatus(ctx, b.session)
        const msg = formatSessionAlert(b.session, b.edge, b.timeMs, market.name, market.status)
        await lark.notify(msg)
      })().catch((err) => {
        logger.error(`[会话] 发送失败: ${(err as Error).message}`)
      })
    })
    unsubs.push(() => scheduler!.stop())
  }

  // 优雅退出
  const shutdown = (): void => {
    logger.info('\n[监控] 正在退出...')
    for (const unsub of unsubs) unsub()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}