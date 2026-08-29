/**
 * 插件内部日志：所有异常、warning、info 都写到文件，不污染 DSH 控制台。
 *
 * 路径策略：
 *   - 优先写到 DSH 的 profile 日志目录（与 DSH 主日志相邻）
 *     ~/.dsh/profiles/<profile>/logs/<plugin-id>.log
 *   - 取不到 DSH_HOME 时回退到工作目录 ./logs/<plugin-id>.log
 *
 * 接口参考 DSH 的 ctx.logger（info / warn / error），但落盘而非 stdout。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const PLUGIN_ID = 'garmin-coach'

function resolveLogDir(): string {
  // 与 token 存储一致：$DSH_HOME 优先，否则 ~/.dsh。不要回退到 cwd——
  // DSH 从不同目录启动时日志会写到不同位置，无法统一排查。
  const dshHome = process.env['DSH_HOME']?.trim()
  const profile = process.env['DSH_PROFILE'] ?? 'web'
  const home = dshHome ? dshHome : join(homedir(), '.dsh')
  return resolve(home, 'profiles', profile, 'logs')
}

function ensureLogFile(): string {
  const logDir = resolveLogDir()
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // 失败也无所谓，最后用 fallback
    }
  }
  return resolve(logDir, `${PLUGIN_ID}.log`)
}

const LOG_PATH = ensureLogFile()

function ts(): string {
  return new Date().toISOString()
}

function format(level: string, scope: string, msg: string, extra?: unknown): string {
  const base = `[${ts()}] [${level}] [${scope}] ${msg}`
  if (extra === undefined) return base
  try {
    const detail = extra instanceof Error
      ? `${extra.name}: ${extra.message}\n${extra.stack ?? ''}`
      : typeof extra === 'string'
        ? extra
        : JSON.stringify(extra)
    return `${base}\n${detail}`
  } catch {
    return base
  }
}

function write(level: string, scope: string, msg: string, extra?: unknown): void {
  try {
    appendFileSync(LOG_PATH, format(level, scope, msg, extra) + '\n', 'utf8')
  } catch {
    // 最后兜底：写 stderr 但不 throw
    try {
      process.stderr.write(format(level, scope, msg, extra) + '\n')
    } catch {
      /* swallow */
    }
  }
}

export const logger = {
  /** 调试信息，最详细 */
  debug(scope: string, msg: string, extra?: unknown): void {
    write('DEBUG', scope, msg, extra)
  },

  /** 一般事件 */
  info(scope: string, msg: string, extra?: unknown): void {
    write('INFO', scope, msg, extra)
  },

  /** 警告，但插件仍可继续工作 */
  warn(scope: string, msg: string, extra?: unknown): void {
    write('WARN', scope, msg, extra)
  },

  /**
   * 错误。**绝不抛回调用方**——只在文件里记录。
   * 调用方应自己决定是否向用户返回降级响应。
   */
  error(scope: string, msg: string, err?: unknown): void {
    write('ERROR', scope, msg, err)
  },

  /** 日志文件路径（用于 Settings 卡片展示给用户） */
  logPath(): string {
    return LOG_PATH
  },
}

/**
 * 高阶函数：把任意 async fn 包成"出异常 → 记日志 → 返回降级响应"。
 * 永远不会 throw——所有调用方都可以放心 await。
 */
export function safeAsync<T, A extends unknown[]>(
  scope: string,
  fallback: T,
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return async (...args: A): Promise<T> => {
    try {
      return await fn(...args)
    } catch (err) {
      logger.error(scope, `safeAsync caught: ${fn.name ?? 'anonymous'}`, err)
      return fallback
    }
  }
}