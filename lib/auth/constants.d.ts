/**
 * Garmin Connect API 常量
 */
export declare const SSO_URL = "https://sso.garmin.com";
export declare const API_URL = "https://connectapi.garmin.com";
/** CN 区域端点（中国区账号用 garmin.cn）*/
export declare const SSO_URL_CN = "https://sso.garmin.cn";
export declare const API_URL_CN = "https://connectapi.garmin.cn";
export declare const DIAUTH_URL_CN = "https://diauth.garmin.cn";
export declare const DIAUTH_URL_COM = "https://diauth.garmin.com";
/**
 * 按区域返回端点集合。
 * @param isCn - true = 中国区（garmin.cn），false = 国际区（garmin.com）
 */
export declare function endpointsFor(isCn: boolean): {
    sso: string;
    api: string;
    diauth: string;
};
/**
 * Mobile iOS service URL（domain-aware）：
 *  - CN 区域用 garmin.cn（登录拿的 ticket 对应这个 service）
 *  - 国际区用 garmin.com
 * login / MFA / DI 交换必须用同一个 service_url，否则 ticket 不匹配。
 */
export declare function serviceUrlFor(isCn: boolean): string;
/** Garmin Connect Mobile SSO（绕 Cloudflare：UA 伪装成手机客户端）*/
export declare const SSO_CLIENT_ID = "GCM_ANDROID_DARK";
export declare const SSO_SERVICE_URL = "https://mobile.integration.garmin.com/gcm/android";
export declare const SSO_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
export declare const CONNECTAPI_UA = "GCM-iOS-5.22.1.4";
/**
 * Garmin 公开放在 S3 上的 consumer key/secret。
 * 所有第三方 Garmin 客户端用同一对凭据；Garmin 偶尔轮换，garth 在 S3 维护最新版。
 */
export declare const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
export declare const OAUTH_CONSUMER_FALLBACK_KEY = "fc3e99d2-118c-44b8-8ae3-03370dde24c0";
export declare const OAUTH_CONSUMER_FALLBACK_SECRET = "E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF";
export declare const OAUTH_CONSUMER_CACHE_TTL_SEC: number;
/**
 * Connect API 端点（来自上游 garmin.ts 的 makeApi()）。
 * 用模板字符串时插入 displayName / date / 日期区间。
 */
export declare const API_PATHS: {
    readonly daily: (name: string, date: string) => string;
    readonly sleep: (name: string, date: string) => string;
    readonly hrv: (date: string) => string;
    readonly readiness: (date: string) => string;
    readonly training: (date: string) => string;
    readonly activities: (from: string, to: string, limit: number) => string;
};
