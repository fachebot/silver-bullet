// 专业日志模块（模块级单例）：控制台 + 按大小滚动的文件双输出
// 用法：
//   initLogger(config.logging)   // 在 CLI 入口 main() 开头调用
//   getLogger().info('...')      // 各模块直接使用（未 init 时自动降级为仅控制台）

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'

import type { LoggingConfig } from '../config/types.js'

let logger: winston.Logger | null = null

// 可读文本格式（文件用）
const textFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}] ${message}`
  }),
)

// 控制台格式（彩色级别）
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level}] ${message}`
  }),
)

// 创建 logger：Console + DailyRotateFile（按日期分文件 + maxSize 大小滚动）
export function createLogger(cfg: LoggingConfig): winston.Logger {
  mkdirSync(cfg.dir, { recursive: true })
  return winston.createLogger({
    level: cfg.level,
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      new DailyRotateFile({
        filename: join(cfg.dir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: `${cfg.maxSizeMb}m`,
        maxFiles: cfg.maxFiles,
        zippedArchive: cfg.zipped,
        format: textFormat,
      }),
    ],
  })
}

// 未初始化时的降级 logger（仅控制台）
function defaultLogger(): winston.Logger {
  return winston.createLogger({
    level: 'info',
    transports: [new winston.transports.Console({ format: consoleFormat })],
  })
}

// 初始化全局单例（幂等，重复调用会重建）
export function initLogger(cfg: LoggingConfig): winston.Logger {
  logger = createLogger(cfg)
  return logger
}

// 获取全局 logger
export function getLogger(): winston.Logger {
  return logger ?? defaultLogger()
}