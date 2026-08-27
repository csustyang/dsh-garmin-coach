/**
 * TokenStore 接口 —— 认证 token 的持久化抽象。
 *
 * DSH 插件里用 ctx.credentials 实现（加密存储）；
 * 验证/测试用 FileTokenStore（磁盘 JSON）。
 */
import type { GarminCachedTokens, GarminMfaState } from './types.js';
export interface TokenStore {
    loadTokens(): Promise<GarminCachedTokens | null>;
    saveTokens(t: GarminCachedTokens): Promise<void>;
    clear(): Promise<void>;
    loadMfaState(): Promise<GarminMfaState | null>;
    saveMfaState(s: GarminMfaState): Promise<void>;
    clearMfaState(): Promise<void>;
}
