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
import { CONNECTAPI_UA, endpointsFor, serviceUrlFor, API_PATHS, } from './constants.js';
// ────────────────────────────────────────────────────────────
//  常量
// ────────────────────────────────────────────────────────────
const IOS_SSO_CLIENT_ID = 'GCM_IOS_DARK';
const IOS_LOGIN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DI_GRANT_TYPE = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
const DI_CLIENT_IDS = [
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    'GARMIN_CONNECT_MOBILE_IOS_DI',
];
// ────────────────────────────────────────────────────────────
//  错误类型
// ────────────────────────────────────────────────────────────
export class GarminAuthError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'GarminAuthError';
    }
}
/** 从响应收集 set-cookie，转成 {name: value} */
function collectCookies(res) {
    const out = {};
    try {
        const setCookies = res.headers.getSetCookie?.() ?? [];
        for (const sc of setCookies) {
            const pair = sc.split(';')[0];
            if (!pair)
                continue;
            const eq = pair.indexOf('=');
            if (eq > 0)
                out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
    }
    catch {
        // 忽略
    }
    return out;
}
export class GarminClient {
    store;
    isCn;
    timeoutMs;
    sso;
    api;
    diauth;
    constructor(opts) {
        this.store = opts.store;
        this.isCn = opts.isCn ?? false;
        this.timeoutMs = opts.timeoutMs ?? 20_000;
        const ep = endpointsFor(this.isCn);
        this.sso = ep.sso;
        this.api = ep.api;
        this.diauth = ep.diauth;
    }
    // ────────────── 认证流程 ──────────────
    async login(email, password) {
        const url = `${this.sso}/mobile/api/login?clientId=${IOS_SSO_CLIENT_ID}&locale=en-US&service=${encodeURIComponent(serviceUrlFor(this.isCn))}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'User-Agent': IOS_LOGIN_UA,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/plain, */*',
                Origin: this.sso,
            },
            body: JSON.stringify({
                username: email,
                password,
                rememberMe: true,
                captchaToken: '',
            }),
        });
        const body = (await res.json().catch(() => ({})));
        if (res.status === 429) {
            throw new GarminAuthError('Garmin 登录限流（429），请稍后再试');
        }
        if (res.status === 403) {
            throw new GarminAuthError('Garmin 登录被拦截（403 Cloudflare），请稍后再试');
        }
        const statusType = body.responseStatus?.type;
        if (statusType === 'INVALID_USERNAME_PASSWORD') {
            throw new GarminAuthError('邮箱或密码错误');
        }
        if (statusType === 'CAPTCHA_REQUIRED') {
            throw new GarminAuthError('需要验证码（CAPTCHA），请在浏览器中登录一次');
        }
        // MFA 需要：保存 cookies + email/password，等 phase 2 输入验证码
        if (statusType === 'MFA_REQUIRED' || body.customerMfaInfo) {
            // 捕获 set-cookie（SSO 会话 cookie，MFA 验证要用）
            const cookies = collectCookies(res);
            const mfaState = {
                cookies,
                loginParams: {
                    clientId: IOS_SSO_CLIENT_ID,
                    locale: 'en-US',
                    service: serviceUrlFor(this.isCn),
                },
                mfaMethod: body.customerMfaInfo?.mfaLastMethodUsed ?? 'email',
                createdAt: new Date().toISOString(),
            };
            mfaState.email = email;
            mfaState.password = password;
            mfaState.isCn = this.isCn;
            await this.store.saveMfaState(mfaState);
            return { kind: 'mfa_required', method: mfaState.mfaMethod };
        }
        if (!body.serviceTicketId) {
            throw new GarminAuthError(`登录失败：${statusType ?? 'unknown'} ${body.responseStatus?.message ?? ''}`);
        }
        const tokens = await this.exchangeTicket(body.serviceTicketId, email);
        await this.store.saveTokens(tokens);
        return { kind: 'ok', tokens };
    }
    async completeMfa(code) {
        const state = await this.store.loadMfaState();
        if (!state) {
            throw new GarminAuthError('没有挂起的 MFA 状态——请先调用 login()');
        }
        const isCn = state.isCn ?? this.isCn;
        const sso = isCn ? endpointsFor(true).sso : endpointsFor(false).sso;
        const cookies = state.cookies ?? {};
        const mfaMethod = state.mfaMethod ?? 'email';
        // 用 login 时保存的 cookies 提交验证码（不重新 login——否则验证码作废）
        // 必须带和 login 相同的 query 参数（clientId/locale/service）
        const mfaUrl = `${sso}/mobile/api/mfa/verifyCode?clientId=${IOS_SSO_CLIENT_ID}&locale=en-US&service=${encodeURIComponent(serviceUrlFor(this.isCn))}`;
        const cookieHeader = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        const mfaRes = await this.fetchWithTimeout(mfaUrl, {
            method: 'POST',
            headers: {
                'User-Agent': IOS_LOGIN_UA,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/plain, */*',
                Origin: sso,
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            body: JSON.stringify({
                mfaMethod,
                mfaVerificationCode: code,
                rememberMyBrowser: true,
                reconsentList: [],
                mfaSetup: false,
            }),
        });
        const mfaBody = (await mfaRes.json().catch(() => ({})));
        // 从响应拿 ticket（可能直接 serviceTicketId，或 serviceURL 的 query 参数）
        let ticket = mfaBody.serviceTicketId;
        if (!ticket && mfaBody.serviceURL) {
            const m = mfaBody.serviceURL.match(/[?&]ticket=([^&\s]+)/);
            if (m)
                ticket = m[1];
        }
        if (!ticket) {
            throw new GarminAuthError(`MFA 验证失败：${mfaBody.responseStatus?.type ?? 'unknown'} (${JSON.stringify(mfaBody).slice(0, 150)})`);
        }
        const email = state.email ?? '';
        const tokens = await this.exchangeTicket(ticket, email, isCn);
        await this.store.saveTokens(tokens);
        await this.store.clearMfaState();
        return tokens;
    }
    async exchangeTicket(ticket, email, isCnOverride) {
        const isCn = isCnOverride ?? this.isCn;
        const diauth = endpointsFor(isCn).diauth;
        let lastErr = null;
        for (const clientId of DI_CLIENT_IDS) {
            try {
                const di = await this.exchangeDiToken(clientId, ticket, diauth, isCn);
                const displayName = await this.fetchDisplayName(di).catch(() => email);
                return { di, displayName };
            }
            catch (e) {
                lastErr = e;
            }
        }
        throw new GarminAuthError(`DI token 交换失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, lastErr);
    }
    async exchangeDiToken(clientId, ticket, diauth, isCn) {
        const body = new URLSearchParams({
            grant_type: DI_GRANT_TYPE,
            service_ticket: ticket,
            service_url: serviceUrlFor(isCn),
            client_id: clientId,
        });
        const res = await this.fetchWithTimeout(`${diauth}/di-oauth2-service/oauth/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                'Cache-Control': 'no-cache',
            },
            body: body.toString(),
        });
        if (res.status === 429) {
            throw new GarminAuthError('DI token 交换被限流（429）');
        }
        const json = (await res.json().catch(() => ({})));
        if (!json.access_token) {
            throw new GarminAuthError(`DI token 响应无 access_token：${JSON.stringify(json).slice(0, 200)}`);
        }
        return {
            access_token: json.access_token,
            refresh_token: json.refresh_token ?? '',
            expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
            token_type: json.token_type ?? 'Bearer',
            client_id: clientId,
        };
    }
    async refreshDiToken(di) {
        if (!di.refresh_token) {
            throw new GarminAuthError('DI token 无 refresh_token，需重新登录');
        }
        const cid = di.client_id ?? DI_CLIENT_IDS[0];
        const diauth = endpointsFor(this.isCn).diauth;
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: di.refresh_token,
            client_id: cid,
        });
        const res = await this.fetchWithTimeout(`${diauth}/di-oauth2-service/oauth/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${cid}:`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: body.toString(),
        });
        const json = (await res.json().catch(() => ({})));
        if (!json.access_token) {
            throw new GarminAuthError('DI token 刷新失败');
        }
        return {
            ...di,
            access_token: json.access_token,
            refresh_token: json.refresh_token ?? di.refresh_token,
            expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
        };
    }
    // ────────────── 数据查询 ──────────────
    async getApi() {
        const tokens = await this.store.loadTokens();
        if (!tokens?.di) {
            throw new GarminAuthError('未登录——请先完成 Garmin 连接');
        }
        let di = tokens.di;
        // 已过期或即将过期（提前 60 秒）→ 用 refresh_token 刷新
        if (Date.now() >= new Date(di.expires_at).getTime() - 60_000) {
            try {
                di = await this.refreshDiToken(di);
                await this.store.saveTokens({ ...tokens, di });
            }
            catch (e) {
                // refresh_token 也失效 → 清除失效 token + 明确提示重新登录
                await this.store.clear().catch(() => { });
                await this.store.clearMfaState().catch(() => { });
                throw new GarminAuthError('登录已过期（refresh token 失效）。请到 Settings → Garmin Coach 重新连接（需短信验证码）', e);
            }
        }
        return this.makeApi(tokens.displayName ?? '', di);
    }
    // ────────────── 内部辅助 ──────────────
    async fetchWithTimeout(url, init) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), this.timeoutMs);
        try {
            return await fetch(url, { ...init, signal: c.signal });
        }
        finally {
            clearTimeout(t);
        }
    }
    async fetchDisplayName(di) {
        const url = `${this.api}/userprofile-service/socialProfile`;
        const res = await this.fetchWithTimeout(url, {
            headers: {
                Authorization: `Bearer ${di.access_token}`,
                'User-Agent': CONNECTAPI_UA,
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            throw new GarminAuthError(`fetchDisplayName 失败 status=${res.status}`);
        }
        const json = (await res.json());
        return json.displayName ?? '';
    }
    makeApi(displayName, di) {
        const authHeaders = () => ({
            Authorization: `Bearer ${di.access_token}`,
            'User-Agent': CONNECTAPI_UA,
            Accept: 'application/json',
        });
        const apiGet = async (path) => {
            const url = `${this.api}${path}`;
            const res = await this.fetchWithTimeout(url, {
                headers: authHeaders(),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new GarminAuthError(`API ${path} 失败 status=${res.status} body=${body.slice(0, 200)}`);
            }
            return (await res.json());
        };
        return {
            displayName,
            daily: (d) => apiGet(API_PATHS.daily(displayName, d)),
            sleep: (d) => apiGet(API_PATHS.sleep(displayName, d)),
            hrv: (d) => apiGet(API_PATHS.hrv(d)),
            readiness: async (d) => {
                const r = await apiGet(API_PATHS.readiness(d));
                return Array.isArray(r) ? r[0] : r;
            },
            training: (d) => apiGet(API_PATHS.training(d)),
            activities: (from, to, limit = 50) => apiGet(API_PATHS.activities(from, to, limit)),
        };
    }
}
