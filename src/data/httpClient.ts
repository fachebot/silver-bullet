// 代理感知 HTTP 客户端
// - 无代理：node-fetch 直连
// - 有代理：proxy-agent 自动识别协议（http/https/socks4/socks5/socks5h 等）并注入 node-fetch 的 agent
// 说明：Node 内置 fetch（undici）无法直接使用 http.Agent 型代理，故统一采用 node-fetch。
// 保留原有 3 次重试 + 指数退避。

import fetch from 'node-fetch'
import { ProxyAgent } from 'proxy-agent'
import type { Agent } from 'node:http'

import type { ProxyConfig } from './exchange.js'

export interface HttpClient {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>
  // 发送 JSON 请求（method 默认 POST，支持 PATCH 等）
  postJson(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    method?: string,
  ): Promise<unknown>
}

// 每次请求的超时时间（毫秒），防止目标主机不可达时无限挂起
const REQUEST_TIMEOUT_MS = 15_000

// proxy-agent 支持的协议
const PROXY_SCHEMES = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
  'pac+http:',
  'pac+https:',
])

// 校验并补齐代理 URL（把独立配置的认证信息拼入 URL）
export function buildProxyUrl(proxy: ProxyConfig): string {
  const scheme = proxy.url.split('://')[0] + ':'
  if (!PROXY_SCHEMES.has(scheme)) {
    throw new Error(`不支持的代理协议: ${proxy.url}（支持 http/https/socks4/socks4a/socks5/socks5h）`)
  }
  let url = proxy.url
  if (proxy.username && !/:\/\/[^/@]+@/.test(url)) {
    const cred =
      encodeURIComponent(proxy.username) +
      (proxy.password ? ':' + encodeURIComponent(proxy.password) : '')
    url = url.replace(/^(\w+:\/\/)/, `$1${cred}@`)
  }
  return url
}

// 创建 HTTP 客户端
export function createHttpClient(proxy?: ProxyConfig | null): HttpClient {
  let agent: Agent | undefined
  if (proxy?.url) {
    // 固定使用配置的代理 URL（覆盖 proxy-agent 默认的环境变量解析）
    agent = new ProxyAgent({ getProxyForUrl: () => buildProxyUrl(proxy) })
  }

  return {
    async getJson(url, headers = {}) {
      let lastErr: Error | undefined
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            agent,
            headers: { Accept: 'application/json', ...headers },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (!res.ok) {
            const body = await res.text()
            throw new Error(`HTTP ${res.status}: ${body}`)
          }
          return await res.json()
        } catch (err) {
          lastErr = err as Error
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt))
          }
        }
      }
      throw new Error(`请求失败（已重试 3 次）: ${lastErr?.message}`)
    },

    async postJson(url, body, headers = {}, method = 'POST') {
      let lastErr: Error | undefined
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            agent,
            method,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (!res.ok) {
            const bodyText = await res.text()
            throw new Error(`HTTP ${res.status}: ${bodyText}`)
          }
          return await res.json()
        } catch (err) {
          lastErr = err as Error
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt))
          }
        }
      }
      throw new Error(`请求失败（已重试 3 次）: ${lastErr?.message}`)
    },
  }
}