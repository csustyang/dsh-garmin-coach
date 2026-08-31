/**
 * Garmin Connect API 常量
 */
export const SSO_URL = 'https://sso.garmin.com';
export const API_URL = 'https://connectapi.garmin.com';
/** CN 区域端点（中国区账号用 garmin.cn）*/
export const SSO_URL_CN = 'https://sso.garmin.cn';
export const API_URL_CN = 'https://connectapi.garmin.cn';
export const DIAUTH_URL_CN = 'https://diauth.garmin.cn';
export const DIAUTH_URL_COM = 'https://diauth.garmin.com';
/**
 * 按区域返回端点集合。
 * @param isCn - true = 中国区（garmin.cn），false = 国际区（garmin.com）
 */
export function endpointsFor(isCn) {
    return {
        sso: isCn ? SSO_URL_CN : SSO_URL,
        api: isCn ? API_URL_CN : API_URL,
        diauth: isCn ? DIAUTH_URL_CN : DIAUTH_URL_COM,
    };
}
/**
 * Mobile iOS service URL（domain-aware）：
 *  - CN 区域用 garmin.cn（登录拿的 ticket 对应这个 service）
 *  - 国际区用 garmin.com
 * login / MFA / DI 交换必须用同一个 service_url，否则 ticket 不匹配。
 */
export function serviceUrlFor(isCn) {
    return isCn
        ? 'https://mobile.integration.garmin.cn/gcm/ios'
        : 'https://mobile.integration.garmin.com/gcm/ios';
}
/** Garmin Connect Mobile SSO（绕 Cloudflare：UA 伪装成手机客户端）*/
export const SSO_CLIENT_ID = 'GCM_ANDROID_DARK';
export const SSO_SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/android';
export const SSO_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const CONNECTAPI_UA = 'GCM-iOS-5.22.1.4';
/**
 * Connect API 端点（来自上游 garmin.ts 的 makeApi()）。
 * 用模板字符串时插入 displayName / date / 日期区间。
 */
export const API_PATHS = {
    daily: (name, date) => `/usersummary-service/usersummary/daily/${name}?calendarDate=${date}`,
    sleep: (name, date) => `/wellness-service/wellness/dailySleepData/${name}?date=${date}&nonSleepBufferMinutes=60`,
    hrv: (date) => `/hrv-service/hrv/${date}`,
    readiness: (date) => `/metrics-service/metrics/trainingreadiness/${date}`,
    training: (date) => `/metrics-service/metrics/trainingstatus/aggregated/${date}`,
    activities: (from, to, limit) => `/activitylist-service/activities/search/activities?startDate=${from}&endDate=${to}&limit=${limit}`,
};
