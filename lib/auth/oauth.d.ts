/**
 * OAuth 1.0a 签名 + 工具函数。
 * 来源：移植自 dsebastien/ai-skill-garmin（MIT）。
 */
export declare function percentEncode(s: string): string;
/** 生成 OAuth1 nonce + timestamp */
export declare function newNonce(): {
    nonce: string;
    timestamp: string;
};
/**
 * 构造 Authorization 头的 OAuth1 签名。
 * 算法：HMAC-SHA1 + PLAINTEXT（参考 RFC 5849 §3.4）。
 */
export declare function oauth1Header(params: {
    method: string;
    url: string;
    consumerKey: string;
    consumerSecret: string;
    token?: string;
    tokenSecret?: string;
    extra?: Readonly<Record<string, string>>;
}): Promise<string>;
