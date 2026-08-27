/**
 * 极简 Set-Cookie jar。
 * 不处理 domain/path scoping——Garmin SSO 全程在同一域下用就够了。
 */
export declare class CookieJar {
    private readonly jar;
    absorb(res: Response): void;
    /** 序列化为单个 Cookie 请求头 */
    header(): string;
    /** 把 jar 内容导出为 dict（用于 MFA 状态持久化）*/
    snapshot(): Readonly<Record<string, string>>;
    /** 从 dict 恢复 */
    restore(cookies: Readonly<Record<string, string>>): void;
    clear(): void;
}
