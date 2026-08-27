/**
 * 极简 Set-Cookie jar。
 * 不处理 domain/path scoping——Garmin SSO 全程在同一域下用就够了。
 */
function splitSetCookieHeader(header) {
    // 一个 Set-Cookie 头可能含多段 cookie，由 ", " 分隔。
    // 简单 split 不够安全（cookie value 里可能有逗号），但 Garmin 端点不会这么干。
    return header.split(/,\s*(?=[A-Za-z0-9_-]+=)/);
}
export class CookieJar {
    jar = new Map();
    absorb(res) {
        const raw = res.headers.get('set-cookie');
        if (!raw)
            return;
        const cookies = splitSetCookieHeader(raw);
        for (const c of cookies) {
            const [pair] = c.split(';');
            if (!pair)
                continue;
            const eq = pair.indexOf('=');
            if (eq < 0)
                continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (name)
                this.jar.set(name, value);
        }
    }
    /** 序列化为单个 Cookie 请求头 */
    header() {
        return Array.from(this.jar.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
    /** 把 jar 内容导出为 dict（用于 MFA 状态持久化）*/
    snapshot() {
        return Object.fromEntries(this.jar.entries());
    }
    /** 从 dict 恢复 */
    restore(cookies) {
        for (const [k, v] of Object.entries(cookies)) {
            this.jar.set(k, v);
        }
    }
    clear() {
        this.jar.clear();
    }
}
