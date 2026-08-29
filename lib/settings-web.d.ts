/**
 * Garmin 设置 route —— /garmin-settings
 *
 * 完全参考 dsh-email 的保存方式：
 *   - GET  → 读取当前 settings 值 + revision
 *   - POST {action:'save', value, expectedRevision} → 保存整个表单
 *   - POST {action:'connect', email, password} → 连接（登录）
 *
 * 后端用 ctx.settings.replace(NAMESPACE, value, expectedRevision) 保存。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface GarminSettingsValue {
    email?: string;
    password?: string;
    isCn?: boolean;
    status?: string;
    displayName?: string;
    lastSyncAt?: string;
    syncDaysBack?: number;
}
export declare const GARMIN_SETTINGS_NS = "garmin-coach";
interface SettingsRouteDeps {
    /** 读取当前 settings 值（scope.get()）*/
    getValue: () => GarminSettingsValue;
    /** 读取 revision（settings.describe 查 ns）*/
    getRevision: () => number;
    /** 是否可写 */
    isWritable: () => boolean;
    /** 保存整个 value */
    save: (value: GarminSettingsValue, expectedRevision?: number) => Promise<void>;
    /** 清掉 Garmin token（账号变更时调）*/
    clearGarminTokens: () => Promise<void>;
    /** 连接 Garmin（登录）*/
    connect: (email: string, password?: string, mfaCode?: string) => Promise<{
        ok: boolean;
        displayName?: string;
        mfaRequired?: boolean;
        message?: string;
    }>;
    /** 手动触发同步 */
    sync: () => Promise<{
        ok: boolean;
        message?: string;
        result?: unknown;
    }>;
    /** 看板聚合数据 */
    dashboard: () => Promise<unknown>;
    /** AI 训练建议生成 */
    insights: () => Promise<unknown>;
    /** 训练任务打卡 */
    toggleTask: (taskId: string) => Promise<{
        ok: boolean;
        task?: unknown;
        message?: string;
    }>;
}
export declare function makeGarminSettingsHandler(deps: SettingsRouteDeps): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
/** 注册 /garmin-settings route */
export declare function installGarminSettingsRoute(ctx: Context, handler: ReturnType<typeof makeGarminSettingsHandler>): void;
export {};
