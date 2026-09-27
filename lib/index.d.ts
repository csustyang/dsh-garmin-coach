/**
 * dsh-garmin-coach entry.
 *
 * 三层防御，确保 apply() 任何异常都被 catch，绝不传给 DSH 主进程：
 *   1. 外层 try-catch 兜底整个 apply()，最后 logger + return
 *   2. 每个 seam (tools / settings / commands) 单独 try-catch，单点失败不影响其它
 *   3. 异常统一走 logger.error() 写到日志文件，不污染 DSH console
 *
 * 严格按 DSH 0.1.7-rc.2 官方 API（SettingsForms）：
 *   - 工具注册：ctx.tools.register(def) → 返回 disposer（scope-fiber effect）
 *   - Settings：入口导出 `Config`（schemastery，字段 .volatile()），
 *     SettingsForms 自动生成「设置 → 插件」配置卡片；读写按 loader entry id
 *     走 ctx.settings.describe() / ctx.settings.update(id, patch, expectedRevision)
 *   - 命令注册：ctx.commands.register({ name, description, input, handler })
 *
 * 软依赖用 ctx.inject + try-catch 兜住"服务不存在"的 fatal。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-garmin-coach";
export declare const inject: readonly ["credentials", "tools", "commands", "agents", "settings"];
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    isCn: z<boolean, boolean, "volatile-defined">;
    status: z<"connected" | "disconnected" | "awaiting_mfa", "connected" | "disconnected" | "awaiting_mfa", "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    lastSyncAt: z<string, string, "volatile-defined">;
    syncDaysBack: z<number, number, "volatile-defined">;
    /** 全量同步起始日期（YYYY-MM-DD）*/
    fullSyncFrom: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    isCn: z<boolean, boolean, "volatile-defined">;
    status: z<"connected" | "disconnected" | "awaiting_mfa", "connected" | "disconnected" | "awaiting_mfa", "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    lastSyncAt: z<string, string, "volatile-defined">;
    syncDaysBack: z<number, number, "volatile-defined">;
    /** 全量同步起始日期（YYYY-MM-DD）*/
    fullSyncFrom: z<string, string, "volatile-defined">;
}>>, "plain">;
export declare function apply(rawCtx: Context, config?: unknown): void;
export { GarminClient } from './auth/client.js';
export { FileTokenStore } from './auth/file-store.js';
export { makeQueries } from './api/queries.js';
export { defineGarminTools } from './tools/register.js';
