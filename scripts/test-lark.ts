// 临时脚本：发送一条 Lark 测试消息（含加急）验证连通性
import { loadConfigFile } from '../src/config/load.js'
import { createHttpClient } from '../src/data/httpClient.js'
import type { ProxyConfig } from '../src/data/exchange.js'
import { initLogger } from '../src/log/logger.js'
import { LarkClient } from '../src/monitor/lark.js'

const config = loadConfigFile()
initLogger(config.logging)

if (!config.monitor.lark.appId || !config.monitor.lark.appSecret) {
  throw new Error('monitor.lark.appId / appSecret 未配置')
}
if (config.monitor.lark.urgentOpenIds.length === 0) {
  throw new Error('monitor.lark.urgentOpenIds 为空')
}

const proxy: ProxyConfig | null = config.data.proxyUrl
  ? { url: config.data.proxyUrl, username: config.data.proxyUsername, password: config.data.proxyPassword }
  : null
const lark = new LarkClient(config.monitor.lark, createHttpClient(proxy))

const text = `✅ Lark 加急测试成功：Silver Bullet 监控链路连通（${new Date().toISOString()}）`
console.log('发送中...')
await lark.notify(text)
console.log('已发送并加急，请在飞书确认收到')