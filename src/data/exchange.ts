// 数据源抽象层：DataSource 接口 + 公共请求类型
// 接入新交易所 = 实现本接口 + 在工厂（data/index.ts）中注册

import type BigNumber from 'bignumber.js'
import type { Kline } from './types.js'

// 代理配置（HTTP/SOCKS4/SOCKS5/socks5h 等）
export interface ProxyConfig {
  url: string // 如 http://127.0.0.1:7890、socks5://127.0.0.1:1080
  username?: string | null
  password?: string | null
}

// K 线请求参数
export interface KlineRequest {
  symbol: string
  interval: string
  startTime?: number
  endTime?: number
  refresh?: boolean // true 时跳过本地缓存
}

// 交易所数据源接口
export interface DataSource {
  readonly name: string // 唯一标识，如 'binance'
  // 周期 → 毫秒（非法周期抛错），用于分页游标
  intervalToMs(interval: string): number
  // 拉取历史 K 线（自动分页 + 本地缓存）
  fetchKlines(req: KlineRequest): Promise<Kline[]>
  // 拉取最近 N 根 K 线（含进行中的 bar，不走缓存，实时轮询用）
  fetchRecentKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>
  // 查询 symbol 的最小价格步进（mintick）
  fetchTickSize(symbol: string): Promise<BigNumber>
  // 订阅多个 symbol 的已收盘 K 线（合并流，单连接，实时推送）
  // 重连成功后调用 onReconnect（用于补数），返回取消订阅函数
  subscribeClosedKlines(
    symbols: string[],
    interval: string,
    onBar: (symbol: string, bar: Kline) => void,
    onReconnect?: () => void,
  ): () => void
}