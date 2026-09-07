// 配置加载：读取 config.json → 深合并默认值 → zod 校验 → 派生布尔值 → 生成运行期配置

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import BigNumber from 'bignumber.js'

import { defaultConfig } from './default.js'
import { configSchema } from './schema.js'
import type { Config, DerivedConfig } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 项目根目录（src/config 向上两级）
const projectRoot = join(__dirname, '..', '..')

// 深合并：用户配置覆盖默认配置（仅合并存在的字段，且不处理数组）
function deepMerge<T>(base: unknown, override: unknown): T {
  if (override === undefined || override === null) return base as T
  if (Array.isArray(base) || Array.isArray(override)) {
    return override as T
  }
  if (
    typeof base === 'object' &&
    base !== null &&
    typeof override === 'object' &&
    override !== null
  ) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const key of Object.keys(override as Record<string, unknown>)) {
      const baseVal = (base as Record<string, unknown>)[key]
      const overrideVal = (override as Record<string, unknown>)[key]
      result[key] = deepMerge(baseVal, overrideVal)
    }
    return result as T
  }
  return override as T
}

// 从文件加载并校验配置
export function loadConfigFile(path?: string): Config {
  const configPath = path ?? join(projectRoot, 'config.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
  } catch (err) {
    throw new Error(`无法读取配置文件 ${configPath}: ${(err as Error).message}`)
  }
  // 用 zod 校验用户配置（先合并默认值，确保所有字段齐全）
  const merged = deepMerge<Config>(defaultConfig, raw ?? {})
  const parsed = configSchema.parse(merged)
  return parsed as Config
}

// 由用户配置 + 数据层结果（mintick）解析出运行期配置
// 派生逻辑与 Pine 一致：
//   superstrict = choice == 'Super-Strict'
//   iTrend      = choice != 'All FVG'
//   strict      = choice == 'Strict'
//   stricty     = superstrict or strict
//   prev        = opt == 'previous session (any)'
export function deriveConfig(config: Config, mintick: BigNumber): DerivedConfig {
  const { mode } = config.fvg
  const superstrict = mode === 'Super-Strict'
  const strict = mode === 'Strict'
  const stricty = superstrict || strict
  const iTrend = mode !== 'All FVG'
  const prev = config.targets.sessionOption === 'previous session (any)'

  // minimum_trade_framework（Pine 原文）：
  //   forex  -> mintick * 15 * 10
  //   index/futures -> mintick * 40
  //   其余  -> 0
  const { syminfoType } = config.data
  let minimumTradeFramework: BigNumber
  if (syminfoType === 'forex') {
    minimumTradeFramework = mintick.times(15).times(10)
  } else if (syminfoType === 'index' || syminfoType === 'futures') {
    minimumTradeFramework = mintick.times(40)
  } else {
    minimumTradeFramework = new BigNumber(0)
  }

  return {
    left: config.swings.left,
    mode,
    superstrict,
    iTrend,
    strict,
    stricty,
    extend: config.fvg.extend,
    prev,
    keep: config.targets.keepLines,
    syminfoType,
    minimumTradeFramework,
  }
}