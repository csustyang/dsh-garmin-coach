/**
 * OAuth 1.0a 签名 + 工具函数。
 * 来源：移植自 dsebastien/ai-skill-garmin（MIT）。
 */

import { createHmac, randomBytes } from 'node:crypto'

export function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/** 生成 OAuth1 nonce + timestamp */
export function newNonce(): { nonce: string; timestamp: string } {
  return {
    nonce: randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000).toString(),
  }
}

/**
 * 构造 Authorization 头的 OAuth1 签名。
 * 算法：HMAC-SHA1 + PLAINTEXT（参考 RFC 5849 §3.4）。
 */
export async function oauth1Header(params: {
  method: string
  url: string
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
  extra?: Readonly<Record<string, string>>
}): Promise<string> {
  const { nonce, timestamp } = newNonce()

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
  }
  if (params.token) oauthParams.oauth_token = params.token
  if (params.extra) Object.assign(oauthParams, params.extra)

  // 1. 收集所有签名参数（query + oauth*）
  const u = new URL(params.url)
  const allParams: Record<string, string> = { ...oauthParams }
  for (const [k, v] of u.searchParams) {
    allParams[k] = v
  }

  // 2. 规范化
  const normalized = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k]!)}`)
    .join('&')

  // 3. 签名 base string
  const baseString = [
    params.method.toUpperCase(),
    percentEncode(u.origin + u.pathname),
    percentEncode(normalized),
  ].join('&')

  // 4. HMAC-SHA1
  const signingKey = `${percentEncode(params.consumerSecret)}&${percentEncode(
    params.tokenSecret ?? '',
  )}`
  const sig = createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64')

  oauthParams.oauth_signature = sig

  // 5. Authorization 头
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k]!)}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}