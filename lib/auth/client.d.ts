/**
 * GarminClient —— DSH 插件的核心认证与数据访问类。
 *
 * 认证：Garmin 2025Q2 起的 DI (Device Identity) OAuth2 流程，支持区域 + MFA：
 *   - 区域：isCn=true → garmin.cn（中国区），false → garmin.com（国际区）
 *   - 1. POST {sso}/mobile/api/login（email+password）→ serviceTicketId 或 MFA_REQUIRED
 *   - 2. MFA：POST {sso}/mobile/api/mfa/verifyCode（mfaVerificationCode）→ serviceTicketId
 *   - 3. POST {diauth}/di-oauth2-service/oauth/token（service_ticket grant）→ DI token
 *   - 4. {api} 请求用 `Authorization: Bearer <di_token>`
 *
 * 参考：cyberjunky/python-garminconnect（CN + MFA + DI 认证流程）
 */
import type { TokenStore } from './token-store.js';
import type { GarminCachedTokens } from './types.js';
export declare class GarminAuthError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
export interface GarminClientOptions {
    store: TokenStore;
    /** true = 中国区（garmin.cn）*/
    isCn?: boolean;
    timeoutMs?: number;
}
interface ApiHandle {
    displayName: string;
    daily: (date: string) => Promise<unknown>;
    sleep: (date: string) => Promise<unknown>;
    hrv: (date: string) => Promise<unknown>;
    readiness: (date: string) => Promise<unknown>;
    training: (date: string) => Promise<unknown>;
    activities: (from: string, to: string, limit?: number) => Promise<unknown[]>;
}
export declare class GarminClient {
    private readonly store;
    private readonly isCn;
    private readonly timeoutMs;
    private readonly sso;
    private readonly api;
    private readonly diauth;
    constructor(opts: GarminClientOptions);
    login(email: string, password: string): Promise<{
        kind: 'ok';
        tokens: GarminCachedTokens;
    } | {
        kind: 'mfa_required';
        method: string;
    }>;
    completeMfa(code: string, email?: string): Promise<GarminCachedTokens>;
    private exchangeTicket;
    private exchangeDiToken;
    private refreshDiToken;
    /**
     * 是否已登录（disk token 存在且含 di.access_token）。
     * 用于工具在未连接时跳过 getApi() 直接返回降级响应，
     * 避免 withBoundary 的 fallback 对象违反 output schema。
     */
    hasToken(): Promise<boolean>;
    getApi(): Promise<ApiHandle>;
    private fetchWithTimeout;
    private fetchDisplayName;
    private makeApi;
}
export type { TokenStore } from './token-store.js';
