// Lark 应用机器人加急客户端（移植自 aicoin-lark-webhook）
// 流程：tenant_access_token → 发送文本消息（receive_id_type=open_id）→ urgent_app 应用内加急
// 参考：https://open.larksuite.com/document/server-docs/im-v1/buzz-messages/urgent_app

import type { HttpClient } from '../data/httpClient.js'
import { getLogger } from '../log/logger.js'

export type LarkUserIdType = 'open_id' | 'union_id' | 'user_id'

export interface LarkConfig {
  appId: string
  appSecret: string
  baseUrl: string
  userIdType: LarkUserIdType
  urgentOpenIds: string[]
}

interface ApiResult {
  code: number
  msg?: string
  tenant_access_token?: string
  expire?: number
  data?: { message_id?: string; invalid_user_id_list?: string[] }
}

export class LarkClient {
  private token?: string
  private tokenExpiresAt = 0

  constructor(private cfg: LarkConfig, private http: HttpClient) {}

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '')
  }

  // 获取 tenant_access_token（缓存 + 过期前 1 分钟刷新）
  private async getTenantAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token
    }
    const res = (await this.http.postJson(
      `${this.base}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: this.cfg.appId, app_secret: this.cfg.appSecret },
    )) as ApiResult
    if (res.code !== 0) {
      throw new Error(`Lark 获取 tenant_access_token 失败: ${res.msg}`)
    }
    const token = res.tenant_access_token?.trim()
    if (!token) throw new Error('Lark 未返回 tenant_access_token')
    this.token = token
    this.tokenExpiresAt = Date.now() + Math.max((res.expire ?? 3600) * 1000, 60_000)
    return token
  }

  // 发送文本消息，返回 message_id
  async sendTextMessage(receiveId: string, text: string): Promise<string> {
    const token = await this.getTenantAccessToken()
    const url = `${this.base}/open-apis/im/v1/messages?receive_id_type=${this.cfg.userIdType}`
    const res = (await this.http.postJson(
      url,
      { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
      { Authorization: `Bearer ${token}` },
    )) as ApiResult
    if (res.code !== 0) throw new Error(`Lark 发送消息失败: ${res.msg}`)
    const messageId = res.data?.message_id?.trim()
    if (!messageId) throw new Error('Lark 发送消息未返回 message_id')
    return messageId
  }

  // 查询本应用视角下的用户 ID（open_id/union_id/user_id），需应用开通通讯录读取权限
// 流程：POST /users/batch_get_id（手机号/邮箱→用户ID，本应用下通常即 open_id 格式 ou_）
async resolveUserIds(opts: { mobiles?: string[]; emails?: string[] }): Promise<Array<{ open_id?: string; union_id?: string; user_id?: string }>> {
  const token = await this.getTenantAccessToken()
  const headers = { Authorization: `Bearer ${token}` }

  const batchBody: Record<string, string[]> = {}
  if (opts.mobiles && opts.mobiles.length > 0) batchBody.mobiles = opts.mobiles
  if (opts.emails && opts.emails.length > 0) batchBody.emails = opts.emails
  const batch = (await this.http.postJson(
    `${this.base}/open-apis/contact/v3/users/batch_get_id`,
    batchBody,
    headers,
  )) as { code: number; msg?: string; data?: { user_list?: Array<{ user_id?: string; mobile?: string; email?: string }> } }
  if (batch.code !== 0) throw new Error(`Lark 批量获取用户 ID 失败: ${batch.msg}`)

  const result: Array<{ open_id?: string; union_id?: string; user_id?: string }> = []
  for (const u of batch.data?.user_list ?? []) {
    if (!u.user_id) continue
    // batch_get_id 返回的 user_id 在本应用下为 open_id 格式（ou_ 开头），可直接用于发送/加急
    result.push({ open_id: u.user_id, user_id: u.user_id })
  }
  return result
}

// 应用内加急（只能加急机器人自己发的消息）
  async sendUrgentApp(messageId: string, userId: string): Promise<void> {
    const token = await this.getTenantAccessToken()
    const url = `${this.base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/urgent_app?user_id_type=${this.cfg.userIdType}`
    const res = (await this.http.postJson(
      url,
      { user_id_list: [userId] },
      { Authorization: `Bearer ${token}` },
      'PATCH',
    )) as ApiResult
    if (res.code !== 0) throw new Error(`Lark 加急失败: ${res.msg}`)
    if ((res.data?.invalid_user_id_list?.length ?? 0) > 0) {
      throw new Error(`Lark 加急存在无效用户: ${res.data?.invalid_user_id_list?.join(', ')}`)
    }
  }

  // 向所有告警目标发送并加急
  async notify(text: string): Promise<void> {
    for (const userId of this.cfg.urgentOpenIds) {
      const messageId = await this.sendTextMessage(userId, text)
      await this.sendUrgentApp(messageId, userId)
      getLogger().info(`[Lark] 已加急推送 ${userId}`)
    }
  }
}