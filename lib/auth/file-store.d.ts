/**
 * 默认 TokenStore：把 token 写到磁盘。
 *
 * 生产 DSH 插件应替换为 CordisTokenStore，用 ctx.credentials 加密存储。
 */
import type { TokenStore } from './token-store.js';
import type { GarminCachedTokens, GarminMfaState } from './types.js';
export declare class FileTokenStore implements TokenStore {
    private readonly tokenPath;
    private readonly mfaPath;
    constructor(tokenPath: string, mfaPath: string);
    static default(): FileTokenStore;
    loadTokens(): Promise<GarminCachedTokens | null>;
    saveTokens(t: GarminCachedTokens): Promise<void>;
    clear(): Promise<void>;
    loadMfaState(): Promise<GarminMfaState | null>;
    saveMfaState(s: GarminMfaState): Promise<void>;
    clearMfaState(): Promise<void>;
}
