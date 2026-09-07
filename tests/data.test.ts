// 测试：数据源抽象层（httpClient 代理、工厂、缓存、配置 schema）

import { describe, it, expect, beforeEach } from 'vitest'
import BigNumber from 'bignumber.js'

import { buildProxyUrl } from '../src/data/httpClient.js'
import { createDataSource } from '../src/data/index.js'
import { BinanceSource, coverageOk, DEFAULT_BASE_URL } from '../src/data/binance.js'
import { loadCachedKlines, saveCachedKlines } from '../src/data/cache.js'
import { configSchema } from '../src/config/schema.js'
import { defaultConfig } from '../src/config/default.js'
import type { DataConfig } from '../src/config/types.js'
import type { Kline } from '../src/data/types.js'
import type { HttpClient } from '../src/data/httpClient.js'

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

  it('meta 时间窗与请求不符 → 视为脏缓存返回 null', () => {
    // 用另一时间窗写入同 symbol/interval 的缓存（文件名含该窗口），再读请求窗口 → 应 miss（不串数据）
    const sym = 'ADACOIN'
    const otherStart = start + 7200_000
    saveCachedKlines('binance', { symbol: sym, interval: '5m' }, otherStart, otherStart + 3600_000, [
      mkBar(otherStart, 100),
    ])
    expect(loadCachedKlines('binance', { symbol: sym, interval: '5m' }, start, end)).toBeNull()
    expect(
      loadCachedKlines('binance', { symbol: sym, interval: '5m' }, otherStart, otherStart + 3600_000),
    ).not.toBeNull()
  })

  it('缓存 bar 乱序 → 返回 null（走网络重拉）', () => {
    const req2 = { symbol: 'LTCUSDT', interval: '5m' }
    saveCachedKlines('binance', req2, start, end, [mkBar(start, 100), mkBar(start + 300_000, 101), mkBar(start, 99)])
    expect(loadCachedKlines('binance', req2, start, end)).toBeNull()
  })
})

describe('coverageOk（分页覆盖窗口判定）', () => {
  const M5 = 300_000

  it('末尾 bar 时间 + 周期 ≥ endTime → 覆盖', () => {
    // 末根收盘 bar 开盘 = endTime - M5（无进行中 bar 的历史窗口）
    const endTime = 1_700_000_000_000
    const bars = [mkBar(endTime - 2 * M5, 100), mkBar(endTime - M5, 101)]
    expect(coverageOk(bars, M5, endTime)).toBe(true)
  })

  it('缺尾部（末根 + 周期 < endTime）→ 未覆盖', () => {
    const endTime = 1_700_000_000_000
    const bars = [mkBar(endTime - 3 * M5, 100), mkBar(endTime - 2 * M5, 101)]
    expect(coverageOk(bars, M5, endTime)).toBe(false)
  })

  it('空数组 → 未覆盖', () => {
    expect(coverageOk([], M5, 1_700_000_000_000)).toBe(false)
  })
})

describe('fetchKlines 完整性（注入假 http，不落脏缓存）', () => {
  const M5 = 300_000
  const start = Date.UTC(2024, 0, 1, 0, 0)
  const end = start + 3 * M5 // 窗口覆盖 3 根收盘 bar（+ 进行中）？end 对齐到 bar 开盘边界

  function fakeRow(t: number, p: number): unknown[] {
    return [t, p, p, p, p, 0, t + M5, 0, 0, 0, 0, 0]
  }

  let calls: Array<{ url: string }> = []
  function makeSource(respond: (url: string) => unknown) {
    const http: HttpClient = {
      async getJson(url: string) {
        calls.push({ url })
        return respond(url)
      },
      async postJson() {
        return {}
      },
    }
    return new BinanceSource({ baseUrl: DEFAULT_BASE_URL, http })
  }

  beforeEach(() => {
    calls = []
  })

  it('正常返回（覆盖尾部）并写入缓存', async () => {
    const symbol = 'INTEGRITY_OK'
    const src = makeSource(() => {
      // 一次返回窗口内 3 根 + 进行中（end）1 根 = 覆盖
      return [fakeRow(start, 100), fakeRow(start + M5, 101), fakeRow(start + 2 * M5, 102), fakeRow(end, 103)]
    })
    const bars = await src.fetchKlines({ symbol, interval: '5m', startTime: start, endTime: end })
    expect(bars).toHaveLength(4)
    expect(bars[bars.length - 1].time).toBe(end)
    // 缓存可读回
    expect(loadCachedKlines('binance', { symbol, interval: '5m' }, start, end)).not.toBeNull()
  })

  it('分页缺尾部 → 整窗重试一次后仍不完整 → 抛错且不写缓存', async () => {
    const symbol = 'INTEGRITY_GAP'
    // 两次都只回 2 根（缺到 end 的那根）
    const src = makeSource(() => {
      return [fakeRow(start, 100), fakeRow(start + M5, 101)]
    })
    await expect(src.fetchKlines({ symbol, interval: '5m', startTime: start, endTime: end })).rejects.toThrow(
      /拉取不完整/,
    )
    expect(loadCachedKlines('binance', { symbol, interval: '5m' }, start, end)).toBeNull()
    // 每轮 doFetch 分页 2 次（首轮缺尾 → 整窗重试 1 轮）→ 共 4 次 HTTP
    expect(calls.length).toBe(4)
  })

  it('第一次缺尾、第二次补全 → 重试后成功并写缓存', async () => {
    const symbol = 'INTEGRITY_RETRY'
    let n = 0
    const src = makeSource(() => {
      n++
      if (n === 1) return [fakeRow(start, 100)] // 第一次只回 1 根（缺尾部）
      return [fakeRow(start, 100), fakeRow(start + M5, 101), fakeRow(start + 2 * M5, 102), fakeRow(end, 103)]
    })
    const bars = await src.fetchKlines({ symbol, interval: '5m', startTime: start, endTime: end })
    expect(bars).toHaveLength(4)
    expect(loadCachedKlines('binance', { symbol, interval: '5m' }, start, end)).not.toBeNull()
  })

  it('空窗口（服务端返回空）→ 返回空数组且不抛错、不写缓存', async () => {
    const symbol = 'INTEGRITY_EMPTY'
    const src = makeSource(() => [])
    const bars = await src.fetchKlines({ symbol, interval: '5m', startTime: start, endTime: end })
    expect(bars).toHaveLength(0)
    expect(loadCachedKlines('binance', { symbol, interval: '5m' }, start, end)).toBeNull()
    expect(calls.length).toBe(1) // 空窗不重试
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