// 单元测试：配置加载与派生逻辑
// 验证：默认值与 Pine 一致、派生布尔正确、minimum_trade_framework 按品种计算

import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'
import { defaultConfig } from '../src/config/default.js'
import { deriveConfig } from '../src/config/load.js'
import { configSchema } from '../src/config/schema.js'
import { loadConfigFile } from '../src/config/load.js'

describe('默认配置（与 Pine 默认值一致）', () => {
  it('关键默认值', () => {
    expect(defaultConfig.swings.left).toBe(5)
    expect(defaultConfig.fvg.mode).toBe('Super-Strict')
    expect(defaultConfig.fvg.extend).toBe(true)
    expect(defaultConfig.targets.sessionOption).toBe('previous session (similar)')
    expect(defaultConfig.targets.keepLines).toBe(true)
  })
})

describe('deriveConfig 派生布尔', () => {
  const base = structuredClone(defaultConfig)

  function cfgOf(mode: string, opt: string, sym: string) {
    const c = structuredClone(base)
    c.fvg.mode = mode as typeof c.fvg.mode
    c.targets.sessionOption = opt as typeof c.targets.sessionOption
    c.data.syminfoType = sym as typeof c.data.syminfoType
    return deriveConfig(c, new BigNumber('0.01'))
  }

  it('Super-Strict → superstrict=true, iTrend=true, stricty=true', () => {
    const c = cfgOf('Super-Strict', 'previous session (similar)', 'crypto')
    expect(c.superstrict).toBe(true)
    expect(c.strict).toBe(false)
    expect(c.iTrend).toBe(true)
    expect(c.stricty).toBe(true)
    expect(c.prev).toBe(false)
  })

  it('Strict → strict=true, superstrict=false', () => {
    const c = cfgOf('Strict', 'previous session (similar)', 'crypto')
    expect(c.strict).toBe(true)
    expect(c.superstrict).toBe(false)
    expect(c.stricty).toBe(true)
  })

  it('All FVG → iTrend=false, stricty=false', () => {
    const c = cfgOf('All FVG', 'previous session (similar)', 'crypto')
    expect(c.iTrend).toBe(false)
    expect(c.stricty).toBe(false)
  })

  it('previous session (any) → prev=true', () => {
    const c = cfgOf('Super-Strict', 'previous session (any)', 'crypto')
    expect(c.prev).toBe(true)
  })

  it('crypto → minimumTradeFramework=0', () => {
    const c = cfgOf('Super-Strict', 'previous session (similar)', 'crypto')
    expect(c.minimumTradeFramework.toNumber()).toBe(0)
  })

  it('forex → mintick*15*10', () => {
    const c = cfgOf('Super-Strict', 'previous session (similar)', 'forex')
    expect(c.minimumTradeFramework.toNumber()).toBe(0.01 * 15 * 10)
  })

  it('futures → mintick*40', () => {
    const c = cfgOf('Super-Strict', 'previous session (similar)', 'futures')
    expect(c.minimumTradeFramework.toNumber()).toBe(0.01 * 40)
  })
})

describe('zod schema 校验', () => {
  it('left 超范围报错', () => {
    const bad = structuredClone(defaultConfig)
    bad.swings.left = 21
    expect(() => configSchema.parse(bad)).toThrow()
  })
  it('非法模式报错', () => {
    const bad = structuredClone(defaultConfig)
    bad.fvg.mode = 'Bad Mode' as never
    expect(() => configSchema.parse(bad)).toThrow()
  })
  it('未知键报错（strict）', () => {
    const bad = structuredClone(defaultConfig) as unknown as Record<string, unknown>
    bad.sbSession = { show: true } // 已删除的旧键
    expect(() => configSchema.parse(bad)).toThrow()
  })
  it('合法配置通过', () => {
    expect(() => configSchema.parse(defaultConfig)).not.toThrow()
  })
})

describe('loadConfigFile', () => {
  it('加载 config.json 并合并默认值', () => {
    const cfg = loadConfigFile()
    expect(cfg.swings.left).toBe(5)
    expect(cfg.fvg.mode).toBe('Super-Strict')
  })
})