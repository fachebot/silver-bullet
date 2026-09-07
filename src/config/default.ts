// 默认配置：与 Pine 指标 ict-silver-bullet.pine 中已使用的 input.* 默认值保持一致
// 对照来源：
//   left        = input.int(5, ...)
//   choice      = input.string('Super-Strict', ...)
//   extend      = input.bool(true, ...)
//   opt         = input.string('previous session (similar)', ...)
//   keep        = input.bool(true, ...)
// 注：Pine 的 showSB / col_SB / cBullFVG / cBearFVG / cSupLine / cResLine / showT / showZZ
//     均为画图/配色设置，本工程为纯数据/信号输出，不保留。

import type { Config } from './types.js'

export const defaultConfig: Config = {
  swings: {
    left: 5,
  },
  fvg: {
    mode: 'Super-Strict',
    extend: true,
  },
  targets: {
    sessionOption: 'previous session (similar)',
    keepLines: true,
  },
  data: {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '5m',
    startTime: null,
    endTime: null,
    syminfoType: 'crypto',
    baseUrl: null,
    proxyUrl: null,
    proxyUsername: null,
    proxyPassword: null,
    refresh: false,
  },
  monitor: {
    symbols: ['BTCUSDT', 'ETHUSDT'],
    warmupDays: 30,
    pollSeconds: 5,
    useWebSocket: true,
    notifySessionBoundary: true,
    lark: {
      appId: '',
      appSecret: '',
      baseUrl: 'https://open.larksuite.com',
      userIdType: 'open_id',
      urgentOpenIds: [],
    },
  },
  logging: {
    level: 'info',
    dir: 'logs',
    maxSizeMb: 10,
    maxFiles: 10,
    zipped: false,
  },
  market: {
    statusApiBase: 'https://fincalapi.com',
    apiKey: '',
    cacheSeconds: 300,
    useLocalFallback: true,
  },
}