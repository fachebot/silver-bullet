// 数据层类型定义

import type BigNumber from 'bignumber.js'

// 单根 K 线（价格统一用 BigNumber 保证精度）
export interface Kline {
  time: number
  open: BigNumber
  high: BigNumber
  low: BigNumber
  close: BigNumber
  volume: BigNumber
}

// 缓存文件结构
export interface CacheFile {
  meta: {
    exchange: string
    symbol: string
    interval: string
    startTime: number
    endTime: number
    fetchedAt: string
  }
  bars: Array<[number, string, string, string, string, string]>
}