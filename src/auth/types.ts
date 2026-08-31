/**
 * Garmin 认证与 token 类型
 *
 * 来源：基于 dsebastien/ai-skill-garmin（MIT）改造为 DSH 插件模块。
 * 上游：Bun 单文件 → 这里拆成 Cordis 风格的多文件。
 */

export interface OAuth1Token {
  readonly token: string
  readonly secret: string
}

export interface OAuth2Token {
  readonly access_token: string
  readonly refresh_token: string
  /** ISO 时间字符串，方便序列化到 ctx.credentials */
  readonly expires_at: string
  readonly token_type: string
  readonly scope?: string
  readonly refresh_token_expires_at?: string
}

/**
 * Garmin DI (Device Identity) OAuth2 token —— 2025Q2 起的新认证。
 */
export interface DIToken {
  readonly access_token: string
  readonly refresh_token: string
  /** ISO 时间字符串 */
  readonly expires_at: string
  readonly token_type: string
  /** 用于 DI 交换的 client_id */
  readonly client_id?: string
}

/**
 * 持久化的整套 token。
 * 真实 DSH 插件里整个对象应通过 ctx.credentials.set('garmin', json) 存储。
 * 验证脚本里为了不依赖 Cordis 上下文，先落盘到 ./.garmin/tokens.json。
 */
export interface GarminCachedTokens {
  /** DI OAuth2 token（2025Q2 起）*/
  readonly di: DIToken
  readonly displayName?: string
}

/**
 * MFA 状态：phase 1 后挂起，等待 phase 2 输入邮箱验证码。
 */
export interface GarminMfaState {
  readonly cookies: Readonly<Record<string, string>>
  readonly loginParams: Readonly<Record<string, string>>
  readonly mfaMethod: string
  readonly createdAt: string
}
