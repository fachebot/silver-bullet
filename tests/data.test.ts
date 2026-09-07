// 测试：数据源抽象层（httpClient 代理、工厂、缓存、配置 schema）

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'

import { buildProxyUrl } from '../src/data/httpClient.js'
import { createDataSource } from '../src/data/index.js'
import { BinanceSource } from '../src/data/binance.js'
import { loadCachedKlines, saveCachedKlines } from '../src/data/cache.js'
import { configSchema } from '../src/config/schema.js'
import { defaultConfig } from '../src/config/default.js'
import type { DataConfig } from '../src/config/types.js'
import type { Kline } from '../src/data/types.js'

function mkBar(time: number, price: number): Kline {
  const b = new BigNumber(price)
  return { time, open: b, high: b, low: b, close: b, volume: new BigNumber(0) }
}

function makeDataConfig(overrides: Partial<DataConfig> = {}): DataConfig {
  return {
    ...structuredClone(defaultConfig.data),
    ...overrides,
  }
}

describe('buildProxyUrl', () => {
  it('http 代理原样保留', () => {
    expect(buildProxyUrl({ url: 'http://127.0.0.1:7890' })).toBe('http://127.0.0.1:7890')
  })
  it('socks5 代理原样保留', () => {
    expect(buildProxyUrl({ url: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080')
  })
  it('独立认证拼入 URL', () => {
    expect(buildProxyUrl({ url: 'http://127.0.0.1:7890', username: 'u', password: 'p@ss' })).toBe(
      'http://u:p%40ss@127.0.0.1:7890',
    )
  })
  it('URL 已含认证则不重复注入', () => {
    expect(
      buildProxyUrl({ url: 'socks5://user:pass@127.0.0.1:1080', username: 'u2', password: 'p2' }),
    ).toBe('socks5://user:pass@127.0.0.1:1080')
  })
  it('不支持协议抛错', () => {
    expect(() => buildProxyUrl({ url: 'ftp://127.0.0.1' })).toThrow(/不支持的代理协议/)
  })
})

describe('BinanceSource', () => {
  const source = new BinanceSource()

  it('实现 DataSource 接口', () => {
    expect(source.name).toBe('binance')
    expect(typeof source.fetchKlines).toBe('function')
    expect(typeof source.fetchTickSize).toBe('function')
    expect(typeof source.intervalToMs).toBe('function')
  })

  it('intervalToMs 正确换算', () => {
    expect(source.intervalToMs('5m')).toBe(300_000)
    expect(source.intervalToMs('1h')).toBe(3_600_000)
  })

  it('非法周期抛错', () => {
    expect(() => source.intervalToMs('7m')).toThrow(/不支持的周期/)
  })
})

describe('createDataSource 工厂', () => {
  it('binance → BinanceSource', () => {
    const source = createDataSource(makeDataConfig({ exchange: 'binance' }))
    expect(source.name).toBe('binance')
    expect(source).toBeInstanceOf(BinanceSource)
  })

  it('未知交易所抛错', () => {
    expect(() => createDataSource(makeDataConfig({ exchange: 'okx' }))).toThrow(/不支持的交易所/)
  })

  it('无代理配置也能创建', () => {
    const source = createDataSource(makeDataConfig({ proxyUrl: null }))
    expect(source.name).toBe('binance')
  })
})

describe('缓存（键含交易所名，不同交易所不串数据）', () => {
  const start = Date.UTC(2024, 0, 1)
  const end = start + 3600_000
  const req = { symbol: 'BTCUSDT', interval: '5m' }

  it('保存后可读取，跨交易所不可见', () => {
    saveCachedKlines('binance', req, start, end, [mkBar(start, 100)])
    const fromBinance = loadCachedKlines('binance', req, start, end)
    expect(fromBinance).not.toBeNull()
    expect(fromBinance![0].time).toBe(start)

    // 其他交易所读不到 binance 的缓存
    expect(loadCachedKlines('okx', req, start, end)).toBeNull()
  })

  it('refresh=true 跳过缓存', () => {
    saveCachedKlines('binance', req, start, end, [mkBar(start, 100)])
    expect(loadCachedKlines('binance', { ...req, refresh: true }, start, end)).toBeNull()
  })
})

describe('config schema 新字段', () => {
  it('默认配置通过校验', () => {
    expect(() => configSchema.parse(defaultConfig)).not.toThrow()
  })

  it('非法 proxyUrl 抛错', () => {
    const bad = structuredClone(defaultConfig)
    bad.data.proxyUrl = 'not-a-url'
    expect(() => configSchema.parse(bad)).toThrow()
  })

  it('空 exchange 抛错', () => {
    const bad = structuredClone(defaultConfig)
    bad.data.exchange = ''
    expect(() => configSchema.parse(bad)).toThrow()
  })

  it('baseUrl/proxy 均可为空', () => {
    const ok = structuredClone(defaultConfig)
    ok.data.baseUrl = null
    ok.data.proxyUrl = null
    expect(() => configSchema.parse(ok)).not.toThrow()
  })
})