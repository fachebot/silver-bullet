// CLI 入口：加载配置 → 解析数据（mintick）→ 拉取 K 线 → 运行引擎 → 输出 JSON
//
// 用法：
//   npm start               使用 config.json 全流程运行
//   npm run serve           启动 HTTP 渲染服务（可视化对照）

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { DateTime } from 'luxon'

import { loadConfigFile, deriveConfig } from './config/load.js'
import { createDataSource } from './data/index.js'
import { Engine } from './engine/engine.js'
import { serialize } from './output/serialize.js'
import { initLogger, getLogger } from './log/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const outputDir = join(projectRoot, 'output')

async function main(): Promise<void> {
  // 1. 加载配置
  const config = loadConfigFile()
  const logger = initLogger(config.logging)
  const { data } = config

  // 2. 创建数据源（含代理），解析 tickSize → mintick，生成运行期配置
  const source = createDataSource(data)
  const proxyMode = data.proxyUrl ? data.proxyUrl : 'direct'
  logger.info(`[配置] exchange=${source.name} symbol=${data.symbol} interval=${data.interval} mode=${config.fvg.mode} proxy=${proxyMode}`)
  const tickSize = await source.fetchTickSize(data.symbol)
  const cfg = deriveConfig(config, tickSize)
  logger.info(`[数据] tickSize=${tickSize.toString()} minimumTradeFramework=${cfg.minimumTradeFramework.toString()}`)

  // 3. 拉取 K 线（支持缓存）
  const bars = await source.fetchKlines({
    symbol: data.symbol,
    interval: data.interval,
    startTime: data.startTime ?? undefined,
    endTime: data.endTime ?? undefined,
    refresh: data.refresh,
  })

  if (bars.length < 10) {
    throw new Error('K 线数量过少，无法运行（需至少 10 根）')
  }

  // 4. 运行引擎
  const engine = new Engine(cfg, data.symbol, data.interval)
  const result = engine.run(bars)
  const serialized = serialize(result)

  // 5. 输出 JSON
  mkdirSync(outputDir, { recursive: true })
  const stamp = DateTime.now().toFormat('yyyyMMdd-HHmmss')
  const file = join(outputDir, `${data.symbol}_${data.interval}_${stamp}.json`)
  writeFileSync(file, JSON.stringify(serialized, null, 2), 'utf-8')

  // 6. 控制台摘要
  logger.info('\n===== 运行摘要 =====')
  logger.info(`bar 数      : ${result.meta.barCount}`)
  logger.info(`时间范围    : ${DateTime.fromMillis(result.meta.startTime, { zone: 'America/New_York' }).toISO()} ~ ${DateTime.fromMillis(result.meta.endTime, { zone: 'America/New_York' }).toISO()} (NY)`)
  logger.info(`会话数      : ${result.sessions.length}`)
  logger.info(`pivot 高/低 : ${result.pivots.filter((p) => p.kind === 'high').length} / ${result.pivots.filter((p) => p.kind === 'low').length}`)
  logger.info(`FVG 总数    : ${result.fvgs.length}（激活 ${result.fvgs.filter((f) => f.active).length}）`)
  logger.info(`目标线      : ${result.targets.length}（已突破 ${result.targets.filter((t) => t.brokenBar !== null).length}）`)
  logger.info(`突破信号    : targetHi=${result.signals.filter((s) => s.type === 'targetHi').length} targetLo=${result.signals.filter((s) => s.type === 'targetLo').length}`)
  logger.info(`MSS 事件    : ${result.mss.length}`)
  logger.info(`输出文件    : ${file}`)
}

main().catch((err) => {
  getLogger().error(`[错误] ${(err as Error).message}`)
  process.exit(1)
})