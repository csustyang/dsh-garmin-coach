/**
 * dsh-garmin-coach entry.
 *
 * 三层防御，确保 apply() 任何异常都被 catch，绝不传给 DSH 主进程：
 *   1. 外层 try-catch 兜底整个 apply()，最后 logger + return
 *   2. 每个 seam (tools / settings / commands) 单独 try-catch，单点失败不影响其它
 *   3. 异常统一走 logger.error() 写到日志文件，不污染 DSH console
 *
 * 严格按 DSH 官方 API：ctx.tools.register / ctx.settings.register。
 * 软依赖用 ctx.inject + try-catch 兜住"服务不存在"的 fatal。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-garmin-coach";
export declare const inject: readonly ["credentials", "tools", "commands", "agents", "settings"];
export declare function apply(rawCtx: Context): void;
export { GarminClient } from './auth/client.js';
export { FileTokenStore } from './auth/file-store.js';
export { makeQueries } from './api/queries.js';
export { defineGarminTools } from './tools/register.js';
