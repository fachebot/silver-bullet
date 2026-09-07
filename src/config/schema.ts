// zod 校验 schema：校验 config.json，非法值启动即报错
// 范围约束与 Pine 一致（left: 1~20）

import { z } from 'zod'

export const fvgModeSchema = z.enum([
  'All FVG',
  'Only FVG in the same direction of trend',
  'Strict',
  'Super-Strict',
])

export const targetOptionSchema = z.enum([
  'previous session (any)',
  'previous session (similar)',
])

export const syminfoTypeSchema = z.enum([
  'stock',
  'futures',
  'index',
  'forex',
  'crypto',
  'fund',
])

export const configSchema = z.object({
  swings: z
    .object({
      left: z.number().int().min(1).max(20),
    })
    .strict(),
  fvg: z
    .object({
      mode: fvgModeSchema,
      extend: z.boolean(),
    })
    .strict(),
  targets: z
    .object({
      sessionOption: targetOptionSchema,
      keepLines: z.boolean(),
    })
    .strict(),
  data: z
    .object({
      exchange: z.string().min(1),
      symbol: z.string().min(1),
      interval: z.string().min(1),
      startTime: z.number().int().nullable(),
      endTime: z.number().int().nullable(),
      syminfoType: syminfoTypeSchema,
      baseUrl: z.string().url().nullable(),
      proxyUrl: z.string().url().nullable(),
      proxyUsername: z.string().nullable(),
      proxyPassword: z.string().nullable(),
      refresh: z.boolean(),
    })
    .strict(),
  monitor: z
    .object({
      symbols: z.array(z.string().min(1)).default(['BTCUSDT', 'ETHUSDT']),
      warmupDays: z.number().int().positive(),
      pollSeconds: z.number().int().min(0), // 0 = 关闭 REST 轮询兜底
      useWebSocket: z.boolean(),
      notifySessionBoundary: z.boolean(),
      lark: z
        .object({
          appId: z.string(),
          appSecret: z.string(),
          baseUrl: z.string().url(),
          userIdType: z.enum(['open_id', 'union_id', 'user_id']),
          urgentOpenIds: z.array(z.string()),
        })
        .strict(),
    })
    .strict(),
  logging: z
    .object({
      level: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']),
      dir: z.string().min(1),
      maxSizeMb: z.number().int().positive(),
      maxFiles: z.number().int().positive(),
      zipped: z.boolean(),
    })
    .strict(),
  market: z
    .object({
      statusApiBase: z.string().url(),
      apiKey: z.string(),
      cacheSeconds: z.number().int().positive(),
      useLocalFallback: z.boolean(),
    })
    .strict(),
}).strict()

export type ConfigSchema = z.infer<typeof configSchema>