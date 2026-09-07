// 测试：实时监控模块（星级判定 / 消息格式化 / Lark 加急 / 收盘处理 / WS 消息解析）

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'

import { gradeFvg } from '../src/monitor/grade.js'
import { formatFvgAlert } from '../src/monitor/format.js'
import { LarkClient, type LarkConfig } from '../src/monitor/lark.js'
import { handleClosedBar, catchUpAfterReconnect, pollForNewBars, type MonitorContext } from '../src/monitor/monitor.js'
import { parseKlineMessage, parseKlineUpdate, shouldForceReconnect, STALE_STREAM_MS } from '../src/data/binance.js'
import type { HttpClient } from '../src/data/httpClient.js'
import type { DataSource, KlineRequest } from '../src/data/exchange.js'
import type { Kline } from '../src/data/types.js'
import { Engine } from '../src/engine/engine.js'
import { deriveConfig } from '../src/config/load.js'
import { defaultConfig } from '../src/config/default.js'

const T0 = Date.UTC(2024, 6, 1, 6, 30) // 06:30 UTC（07:00 UTC = 03:00 NY = LN 会话开始）

function mkBar(time: number, o: number, h: number, l: number, c: number): Kline {
  return {
    time,
    open: new BigNumber(o),
    high: new BigNumber(h),
    low: new BigNumber(l),
    close: new BigNumber(c),
    volume: new BigNumber(0),
  }
}

describe('gradeFvg（星级判定）', () => {
  const C = (n: number) => new BigNumber(n)

  it('逆势 bull（trend≠1）→ 1 星 All FVG', () => {
    const g = gradeFvg(0, 'bull', C(102), C(103), C(100))
    expect(g.stars).toBe(1)
    expect(g.label).toBe('All FVG')
  })
  it('逆势 bear（trend==1）→ 1 星 All FVG', () => {
    const g = gradeFvg(1, 'bear', C(98), C(103), C(100))
    expect(g.stars).toBe(1)
    expect(g.label).toBe('All FVG')
  })
  it('顺势 bull + close≥top → 3 星 Super-Strict', () => {
    expect(gradeFvg(1, 'bull', C(105), C(103), C(100))).toEqual({ stars: 3, label: 'Super-Strict' })
  })
  it('顺势 bull + 收盘在 box 内 → 2 星 Strict', () => {
    expect(gradeFvg(1, 'bull', C(101), C(103), C(100))).toEqual({ stars: 2, label: 'Strict' })
  })
  it('顺势 bull + close<bottom → 1 星 Only FVG in the same direction of trend', () => {
    expect(gradeFvg(1, 'bull', C(99), C(103), C(100))).toEqual({ stars: 1, label: 'Only FVG in the same direction of trend' })
  })
  it('顺势 bear + close≤bottom → 3 星 Super-Strict', () => {
    expect(gradeFvg(-1, 'bear', C(99), C(103), C(100))).toEqual({ stars: 3, label: 'Super-Strict' })
  })
  it('顺势 bear + close>top → 1 星 Only FVG', () => {
    expect(gradeFvg(-1, 'bear', C(104), C(103), C(100))).toEqual({ stars: 1, label: 'Only FVG in the same direction of trend' })
  })
})

describe('formatFvgAlert', () => {
  it('包含币种/会话/时间/现价/方向/范围/质量', () => {
    const msg = formatFvgAlert({
      symbol: 'BTCUSDT',
      session: 'LN',
      time: T0,
      close: new BigNumber('64310.4'),
      fvg: { type: 'bull', top: new BigNumber('64310.4'), bottom: new BigNumber('64281.4') },
      grade: { stars: 3, label: 'Super-Strict' },
    })
    expect(msg).toContain('BTCUSDT')
    expect(msg).toContain('LN（03-04 NY）')
    expect(msg).toContain('现价：64310.4')
    expect(msg).toContain('看涨 FVG')
    expect(msg).toContain('范围：64281.4 ~ 64310.4')
    expect(msg).toContain('质量：⭐⭐⭐ Super-Strict')
  })
})

describe('shouldForceReconnect（WS 假活判定）', () => {
  it('距最近推送超过阈值 → 强制重连', () => {
    expect(shouldForceReconnect(STALE_STREAM_MS + 1)).toBe(true)
    expect(shouldForceReconnect(120_000)).toBe(true) // > 90s
  })
  it('距最近推送未超阈值 → 不强制', () => {
    expect(shouldForceReconnect(0)).toBe(false)
    expect(shouldForceReconnect(STALE_STREAM_MS)).toBe(false) // 恰好等于阈值不算假活
    expect(shouldForceReconnect(30_000)).toBe(false)
  })
})

describe('parseKlineMessage（WS 消息解析）', () => {
  it('合并流收盘（x=true）→ {symbol, bar}', () => {
    const raw = JSON.stringify({
      stream: 'btcusdt@kline_5m',
      data: { e: 'kline', s: 'BTCUSDT', k: { t: 1000, o: '1.1', h: '1.2', l: '1.0', c: '1.15', v: '3.3', x: true } },
    })
    const parsed = parseKlineMessage(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.symbol).toBe('BTCUSDT')
    expect(parsed!.bar.time).toBe(1000)
    expect(parsed!.bar.close.toString()).toBe('1.15')
  })
  it('单流收盘（x=true）→ {symbol, bar}（symbol 为空）', () => {
    const raw = JSON.stringify({ e: 'kline', k: { t: 1000, o: '1.1', h: '1.2', l: '1.0', c: '1.15', v: '3.3', x: true } })
    const parsed = parseKlineMessage(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.bar.close.toString()).toBe('1.15')
  })
  it('未收盘（x=false）→ null', () => {
    const raw = JSON.stringify({ e: 'kline', k: { x: false } })
    expect(parseKlineMessage(raw)).toBeNull()
  })

  it('parseKlineUpdate：进行中（x=false）也能解析出 symbol/close/closed=false（用于日志计数）', () => {
    const raw = JSON.stringify({
      stream: 'ethusdt@kline_5m',
      data: { e: 'kline', s: 'ETHUSDT', k: { t: 1000, o: '2.0', h: '2.1', l: '1.9', c: '2.05', v: '9', x: false } },
    })
    const upd = parseKlineUpdate(raw)
    expect(upd).not.toBeNull()
    expect(upd!.symbol).toBe('ETHUSDT')
    expect(upd!.closed).toBe(false)
    expect(upd!.close.toString()).toBe('2.05')
  })

  it('parseKlineUpdate：不完整消息 → null（不抛错）', () => {
    expect(parseKlineUpdate(JSON.stringify({ k: { x: false } }))).toBeNull()
  })
})

describe('LarkClient（mock http）', () => {
  interface Call {
    url: string
    body: unknown
    headers?: Record<string, string>
    method?: string
  }
  function makeHttp(script: Array<Record<string, unknown>>): { http: HttpClient; calls: Call[] } {
    const calls: Call[] = []
    let idx = 0
    const http: HttpClient = {
      async getJson(_url) {
        return {}
      },
      async postJson(url, body, headers, method) {
        calls.push({ url, body, headers, method })
        return script[Math.min(idx++, script.length - 1)] ?? { code: 0 }
      },
    }
    return { http, calls }
  }

  const larkCfg: LarkConfig = {
    appId: 'app_id',
    appSecret: 'secret',
    baseUrl: 'https://open.larksuite.com',
    userIdType: 'open_id',
    urgentOpenIds: ['ou_1', 'ou_2'],
  }

  it('按 token→send→urgent 序列调用并加急每个目标', async () => {
    const { http, calls } = makeHttp([
      { code: 0, tenant_access_token: 'tok', expire: 3600 },
      { code: 0, data: { message_id: 'om_1' } },
      { code: 0 },
      { code: 0, data: { message_id: 'om_2' } },
      { code: 0 },
    ])
    const client = new LarkClient(larkCfg, http)
    await client.notify('告警内容')

    expect(calls).toHaveLength(5)
    // 1. token
    expect(calls[0].url).toContain('/open-apis/auth/v3/tenant_access_token/internal')
    // 2/4. send 到各目标
    expect(calls[1].url).toContain('/open-apis/im/v1/messages?receive_id_type=open_id')
    expect((calls[1].body as { receive_id: string }).receive_id).toBe('ou_1')
    expect(calls[1].headers?.Authorization).toBe('Bearer tok')
    expect((calls[1].body as { content: string }).content).toContain('告警内容')
    expect(calls[3].body as { receive_id: string }).toMatchObject({ receive_id: 'ou_2' })
    // 3/5. urgent PATCH
    expect(calls[2].url).toContain('/urgent_app?user_id_type=open_id')
    expect(calls[2].method).toBe('PATCH')
    expect(calls[2].body).toEqual({ user_id_list: ['ou_1'] })
    expect((calls[4].body as { user_id_list: string[] }).user_id_list).toEqual(['ou_2'])
  })

  it('token 失败抛错', async () => {
    const { http } = makeHttp([{ code: 99999, msg: 'bad' }])
    const client = new LarkClient(larkCfg, http)
    await expect(client.notify('x')).rejects.toThrow(/token/)
  })
})

describe('handleClosedBar（收盘处理）', () => {
  function setup(): { ctx: MonitorContext; lark: { texts: string[]; notify: (t: string) => Promise<void> } } {
    const config = structuredClone(defaultConfig)
    config.fvg.mode = 'All FVG' // 监控用 All FVG 模式
    const cfg = deriveConfig(config, new BigNumber('0.1'))
    const engine = new Engine(cfg, 'BTCUSDT', '5m')

    // 预热 bars 0..11（06:30 起 12 根；bar 10 的 high 作为后续 FVG 下沿参考=100）
    const ohlc: Array<[number, number, number, number]> = []
    for (let i = 0; i < 12; i++) ohlc.push([100.5, i === 10 ? 100 : 102, 99, 100.5])
    for (let i = 0; i < 12; i++) {
      const [o, h, l, c] = ohlc[i]
      engine.feedBar(mkBar(T0 + i * 300_000, o, h, l, c))
    }

    const texts: string[] = []
    const lark = {
      texts,
      async notify(t: string): Promise<void> {
        texts.push(t)
      },
    }
    const ctx: MonitorContext = {
      config,
      engines: new Map([['BTCUSDT', engine]]),
      lastProcessed: new Map([['BTCUSDT', T0 + 11 * 300_000]]),
    }
    return { ctx, lark }
  }

  it('killzone 收盘 bar 产生 bull FVG → 告警', async () => {
    const { ctx, lark } = setup()
    // bar 12（07:30 UTC = 03:30 NY，LN 内）：low=103 > high[10]=100 → bull FVG
    const alerts = await handleClosedBar(ctx, 'BTCUSDT', mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5), lark as never)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('看涨 FVG')
    expect(alerts[0]).toContain('范围：100 ~ 103')
    expect(lark.texts).toHaveLength(1)
  })

  it('重复 bar（time ≤ lastProcessed）→ 不重复告警', async () => {
    const { ctx, lark } = setup()
    const bar = mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5)
    await handleClosedBar(ctx, 'BTCUSDT', bar, lark as never)
    const again = await handleClosedBar(ctx, 'BTCUSDT', bar, lark as never)
    expect(again).toHaveLength(0)
    expect(lark.texts).toHaveLength(1)
  })

  it('非 killzone bar 产生条件满足也不告警（引擎不建 FVG）', async () => {
    const { ctx, lark } = setup()
    // bar 12 是 killzone 内；bar 0（06:30 UTC = 02:30 NY）非 killzone，即使 low>high[2] 也不建 FVG
    const res = await handleClosedBar(ctx, 'BTCUSDT', mkBar(T0, 104, 105, 103, 104.5), lark as never)
    expect(res).toHaveLength(0)
    expect(lark.texts).toHaveLength(0)
  })
})

describe('catchUpAfterReconnect（断线补数）', () => {
  class MockSource implements DataSource {
    readonly name = 'mock'
    bars: Kline[] = []
    intervalToMs(_i: string): number {
      return 300_000
    }
    async fetchKlines(_req: KlineRequest): Promise<Kline[]> {
      return this.bars
    }
    async fetchRecentKlines(_s: string, _i: string, _l: number): Promise<Kline[]> {
      return this.bars
    }
    async fetchTickSize(_s: string): Promise<BigNumber> {
      return new BigNumber('0.1')
    }
    subscribeClosedKlines(): () => void {
      return () => {}
    }
  }

  function setup(): { ctx: MonitorContext; lark: { texts: string[]; notify: (t: string) => Promise<void> }; source: MockSource } {
    const config = structuredClone(defaultConfig)
    config.fvg.mode = 'All FVG'
    const cfg = deriveConfig(config, new BigNumber('0.1'))
    const engine = new Engine(cfg, 'BTCUSDT', '5m')
    for (let i = 0; i < 12; i++) {
      engine.feedBar(mkBar(T0 + i * 300_000, 100.5, i === 10 ? 100 : 102, 99, 100.5))
    }
    const texts: string[] = []
    const lark = { texts, async notify(t: string): Promise<void> { texts.push(t) } }
    const ctx: MonitorContext = {
      config,
      engines: new Map([['BTCUSDT', engine]]),
      lastProcessed: new Map([['BTCUSDT', T0 + 11 * 300_000]]),
    }
    const source = new MockSource()
    return { ctx, lark, source }
  }

  it('重连后补数：REST 拉回断线期间收盘的 FVG bar 并告警', async () => {
    const { ctx, lark, source } = setup()
    // 断线期间 bar 12（07:30 UTC = 03:30 NY，LN 内）收盘，形成 bull FVG
    source.bars = [mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5)]
    const alerts = await catchUpAfterReconnect(ctx, source, 'BTCUSDT', '5m', lark as never)
    expect(alerts).toBe(1)
    expect(lark.texts).toHaveLength(1)
    expect(lark.texts[0]).toContain('看涨 FVG')
    // lastProcessed 已推进到补数 bar
    expect(ctx.lastProcessed.get('BTCUSDT')).toBe(T0 + 12 * 300_000)
  })

  it('无缺口（nowFloor ≤ lastProcessed）→ 不请求不告警', async () => {
    const { ctx, lark, source } = setup()
    // 时间对齐到 bar11 收盘（lastProcessed），无缺口
    const alerts = await catchUpAfterReconnect(ctx, source, 'BTCUSDT', '5m', lark as never, () => T0 + 11 * 300_000)
    expect(alerts).toBe(0)
    expect(lark.texts).toHaveLength(0)
  })

  it('lastProcessed 为空（无基准）→ 不拉全史、不告警', async () => {
    const { ctx, lark, source } = setup()
    const fetchCalls: KlineRequest[] = []
    source.fetchKlines = async (req: KlineRequest) => {
      fetchCalls.push(req)
      return source.bars
    }
    // 预热异常 → lastProcessed 为 0（无基准）
    ctx.lastProcessed.set('BTCUSDT', 0)
    const alerts = await catchUpAfterReconnect(ctx, source, 'BTCUSDT', '5m', lark as never)
    expect(alerts).toBe(0)
    expect(fetchCalls).toHaveLength(0) // 不得拉全史
    expect(lark.texts).toHaveLength(0)
  })
})

describe('pollForNewBars（REST 轮询兜底）', () => {
  class MockSource implements DataSource {
    readonly name = 'mock'
    bars: Kline[] = []
    intervalToMs(_i: string): number {
      return 300_000
    }
    async fetchKlines(_req: KlineRequest): Promise<Kline[]> {
      return []
    }
    async fetchRecentKlines(_s: string, _i: string, _l: number): Promise<Kline[]> {
      return this.bars
    }
    async fetchTickSize(_s: string): Promise<BigNumber> {
      return new BigNumber('0.1')
    }
    subscribeClosedKlines(): () => void {
      return () => {}
    }
  }

  function setup(): { ctx: MonitorContext; lark: { texts: string[]; notify: (t: string) => Promise<void> }; source: MockSource } {
    const config = structuredClone(defaultConfig)
    config.fvg.mode = 'All FVG'
    const cfg = deriveConfig(config, new BigNumber('0.1'))
    const engine = new Engine(cfg, 'BTCUSDT', '5m')
    for (let i = 0; i < 12; i++) {
      engine.feedBar(mkBar(T0 + i * 300_000, 100.5, i === 10 ? 100 : 102, 99, 100.5))
    }
    const texts: string[] = []
    const lark = { texts, async notify(t: string): Promise<void> { texts.push(t) } }
    const ctx: MonitorContext = {
      config,
      engines: new Map([['BTCUSDT', engine]]),
      lastProcessed: new Map([['BTCUSDT', T0 + 11 * 300_000]]),
    }
    return { ctx, lark, source: new MockSource() }
  }

  it('WS 无推送时轮询补上：新收盘 FVG bar 被处理并告警', async () => {
    const { ctx, lark, source } = setup()
    // 轮询拉到的最近 bar 含一根已收盘的新 bar（bar12，LN 内，形成 bull FVG）
    source.bars = [mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5)]
    const alerts = await pollForNewBars(ctx, source, 'BTCUSDT', '5m', lark as never, () => T0 + 13 * 300_000)
    expect(alerts).toBe(1)
    expect(lark.texts).toHaveLength(1)
    expect(ctx.lastProcessed.get('BTCUSDT')).toBe(T0 + 12 * 300_000)
  })

  it('进行中的 bar（未收盘）不处理', async () => {
    const { ctx, lark, source } = setup()
    // bar12 还没收盘（now 停在 bar12 内）→ 不处理
    source.bars = [mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5)]
    const alerts = await pollForNewBars(ctx, source, 'BTCUSDT', '5m', lark as never, () => T0 + 12 * 300_000)
    expect(alerts).toBe(0)
    expect(lark.texts).toHaveLength(0)
  })

  it('重复轮询同一根已处理 bar → 不重复告警', async () => {
    const { ctx, lark, source } = setup()
    source.bars = [mkBar(T0 + 12 * 300_000, 104, 105, 103, 104.5)]
    const first = await pollForNewBars(ctx, source, 'BTCUSDT', '5m', lark as never, () => T0 + 13 * 300_000)
    const second = await pollForNewBars(ctx, source, 'BTCUSDT', '5m', lark as never, () => T0 + 13 * 300_000)
    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(lark.texts).toHaveLength(1)
  })
})