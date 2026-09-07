// 查询本应用视角下的用户 open_id / union_id（解决 open_id cross app 问题）
// 用法：
//   npx tsx scripts/get-openid.ts --mobile 13800138000
//   npx tsx scripts/get-openid.ts --email xxx@example.com
// 前置：应用需在开放平台开通通讯录读取权限（如 contact:user.base:readonly）且目标用户在应用可用范围内
import { loadConfigFile } from '../src/config/load.js'
import { createHttpClient } from '../src/data/httpClient.js'
import type { ProxyConfig } from '../src/data/exchange.js'
import { LarkClient } from '../src/monitor/lark.js'

const config = loadConfigFile()
const proxy: ProxyConfig | null = config.data.proxyUrl
  ? { url: config.data.proxyUrl, username: config.data.proxyUsername, password: config.data.proxyPassword }
  : null
const lark = new LarkClient(config.monitor.lark, createHttpClient(proxy))

const args = process.argv.slice(2)
const mobileIdx = args.indexOf('--mobile')
const emailIdx = args.indexOf('--email')
const mobiles = mobileIdx !== -1 ? [args[mobileIdx + 1]] : []
const emails = emailIdx !== -1 ? [args[emailIdx + 1]] : []
if (mobiles.length === 0 && emails.length === 0) {
  console.log('用法: npx tsx scripts/get-openid.ts --mobile <手机号> | --email <邮箱>')
  process.exit(1)
}

const users = await lark.resolveUserIds({ mobiles, emails })
if (users.length === 0) {
  console.log('未找到用户。请确认：1) 应用已开通通讯录读取权限 2) 该用户在应用可用范围内')
  process.exit(1)
}
for (const u of users) {
  console.log('open_id :', u.open_id ?? '(无)')
  console.log('union_id:', u.union_id ?? '(无)')
  console.log('user_id :', u.user_id ?? '(无)')
}
console.log('\n把 open_id（或 union_id）填入 config.json 的 monitor.lark.urgentOpenIds，userIdType 相应设为 open_id / union_id')