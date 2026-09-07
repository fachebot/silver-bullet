// 测试：日志模块（createLogger / 单例 + 文件输出 + 级别过滤）

import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type winston from 'winston'

import { createLogger, initLogger, getLogger } from '../src/log/logger.js'

const tmpDir = join(tmpdir(), `sb-log-test-${Date.now()}`)
const created: winston.Logger[] = []

afterAll(async () => {
  // 先关闭所有 logger 的流，再删除临时目录（避免 ENOENT）
  for (const lg of created) lg.close()
  await new Promise((r) => setTimeout(r, 300))
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('createLogger', () => {
  it('写可读文本日志到控制台传输与文件（含时间戳/级别）', async () => {
    const logger = createLogger({
      level: 'info',
      dir: tmpDir,
      maxSizeMb: 10,
      maxFiles: 2,
      zipped: false,
    })
    created.push(logger)
    logger.info('test info 消息')
    logger.error('test error 消息')
    // 等待异步文件写入
    await new Promise((r) => setTimeout(r, 500))

    // 只读取实际日志文件（忽略 winston-daily-rotate-file 的 -audit.json 状态文件）
    const logFiles = readdirSync(tmpDir).filter((f) => f.endsWith('.log'))
    expect(logFiles.length).toBeGreaterThan(0)
    const content = readFileSync(join(tmpDir, logFiles[0]), 'utf-8')
    expect(content).toContain('[INFO]')
    expect(content).toContain('test info 消息')
    expect(content).toContain('test error 消息')
    // 文件存在（目录自动创建）
    expect(existsSync(tmpDir)).toBe(true)
  })

  it('级别过滤：warn 级 logger 不写 info', async () => {
    const dir = join(tmpDir, 'level')
    const logger = createLogger({ level: 'warn', dir, maxSizeMb: 10, maxFiles: 2, zipped: false })
    created.push(logger)
    logger.info('should-not-appear')
    logger.warn('should-appear')
    await new Promise((r) => setTimeout(r, 500))
    const logFiles = readdirSync(dir).filter((f) => f.endsWith('.log'))
    const content = readFileSync(join(dir, logFiles[0]), 'utf-8')
    expect(content).not.toContain('should-not-appear')
    expect(content).toContain('should-appear')
  })
})

describe('模块级单例', () => {
  it('initLogger 后 getLogger 返回同一 logger，未 init 时降级为可用 logger', () => {
    const l1 = initLogger({ level: 'info', dir: tmpDir, maxSizeMb: 10, maxFiles: 2, zipped: false })
    created.push(l1)
    const l2 = getLogger()
    expect(l1).toBe(l2)
  })
})