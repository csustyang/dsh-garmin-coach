/**
 * Garmin 认证 route —— /garmin-connect
 *
 * 处理浏览器卡片发来的连接请求：
 *   POST /garmin-connect {action:'connect'|'mfa', email, password, mfaCode}
 *
 * 流程：
 *   connect → client.login(email, password)
 *     - 成功 → token 缓存 → 更新 settings 状态 → {ok:true, displayName}
 *     - 需要 MFA → {ok:false, mfaRequired:true}
 *   mfa → client.completeMfa(code) → {ok:true, displayName}
 *
 * 安全：
 *   - 仅 localhost
 *   - 密码只在内存用一次，不落盘（token 通过 credentials 缓存）
 */
/// <reference types="node" />
import { GarminClient } from './auth/client.js';
import type { TokenStore } from './auth/client.js';
export interface ConnectRequestBody {
    action?: 'connect' | 'mfa';
    email?: string;
    password?: string;
    mfaCode?: string;
}
export interface ConnectResult {
    ok: boolean;
    displayName?: string;
    mfaRequired?: boolean;
    message?: string;
}
/**
 * 构建 /garmin-connect 的 handler。
 * @param getClient - 返回当前 GarminClient（已注入 store）
 */
export declare function makeConnectHandler(getClient: () => GarminClient | null, updateStatus: (patch: {
    status?: string;
    displayName?: string;
    email?: string;
}) => Promise<void>, store?: TokenStore): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
/** 在 ctx.webServer 上注册 /garmin-connect route */
export declare function installConnectRoute(ctx: unknown, handler: ReturnType<typeof makeConnectHandler>): void;
