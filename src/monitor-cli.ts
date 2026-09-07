// 实时监控 CLI：`npm run monitor`
// 监控 monitor.symbols 的 5m 收盘，killzone 内新 FVG 产生时 Lark 应用内加急通知

import { loadConfigFile } from './config/load.js'
import { createDataSource } from './data/index.js'
import { createHttpClient } from './data/httpClient.js'
import type { ProxyConfig } from './data/exchange.js'
import { initLogger, getLogger } from './log/logger.js'
import { LarkClient } from './monitor/lark.js'
import { runMonitor } from './monitor/monitor.js'

async function main(): Promise<void> {
  const config = loadConfigFile()
  const logger = initLogger(config.logging)

  // 校验监控配置
  if (config.monitor.symbols.length === 0) throw new Error('monitor.symbols 为空')
  if (!config.monitor.lark.appId || !config.monitor.lark.appSecret) {
    throw new Error('monitor.lark.appId / appSecret 未配置')
  }
  if (config.monitor.lark.urgentOpenIds.length === 0) {
    throw new Error('monitor.lark.urgentOpenIds 为空')
  }

  const source = createDataSource(config.data)
  const proxy: ProxyConfig | null = config.data.proxyUrl
    ? { url: config.data.proxyUrl, username: config.data.proxyUsername, password: config.data.proxyPassword }
    : null
  const lark = new LarkClient(config.monitor.lark, createHttpClient(proxy))

  logger.info(`[监控] 币种 ${config.monitor.symbols.join(', ')} · 周期 ${config.data.interval} · 预热 ${config.monitor.warmupDays} 天`)
  await runMonitor(config, source, lark)
}

main().catch((err) => {
  getLogger().error(`[错误] ${(err as Error).message}`)
  process.exit(1)
})