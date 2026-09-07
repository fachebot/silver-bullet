// 数据源工厂：根据配置创建对应交易所的数据源
// 接入新交易所：实现 DataSource（exchange.ts）→ 在下方 switch 中注册

import type { DataConfig } from '../config/types.js'
import type { DataSource, ProxyConfig } from './exchange.js'
import { BinanceSource } from './binance.js'

// 重新导出公共类型，方便上层只从本模块引用
export type { DataSource, KlineRequest, ProxyConfig } from './exchange.js'
export type { Kline } from './types.js'

// 由配置创建数据源
export function createDataSource(config: DataConfig): DataSource {
  // 代理配置：仅当 proxyUrl 非空时启用
  const proxy: ProxyConfig | null = config.proxyUrl
    ? { url: config.proxyUrl, username: config.proxyUsername, password: config.proxyPassword }
    : null

  switch (config.exchange) {
    case 'binance':
      return new BinanceSource({ baseUrl: config.baseUrl, proxy })
    default:
      throw new Error(`不支持的交易所: ${config.exchange}`)
  }
}