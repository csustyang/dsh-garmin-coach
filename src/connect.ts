/**
 * Garmin 认证 route —— /garmin-connect
 *
 * 处理浏览器卡片发来的连接请求：
 *   POST /garmin-connect {action:'connect'|'mfa', email, password, mfaCode}
 *
 * 流程：
 *   connect → client.login(email, password)
 *     - 成功 → token 缓存 → 更新 settings 状态 → {ok:true, displayName}
 *     - 需要 MFA → {ok:false, mfaRequired:true}
 *   mfa → client.completeMfa(code) → {ok:true, displayName}
 *
 * 安全：
 *   - 仅 localhost
 *   - 密码只在内存用一次，不落盘（token 通过 credentials 缓存）
 */

import { GarminClient } from './auth/client.js'
import type { TokenStore } from './auth/client.js'
import { logger } from './logger.js'

export interface ConnectRequestBody {
  action?: 'connect' | 'mfa'
  email?: string
  password?: string
  mfaCode?: string
}

export interface ConnectResult {
  ok: boolean
  displayName?: string
  mfaRequired?: boolean
  message?: string
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLocalhost(remote: string | undefined): boolean {
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote === undefined
  )
}

function sendJson(
  res: import('node:http').ServerResponse,
  status: number,
  data: unknown,
): void {
  const bytes = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

/**
 * 构建 /garmin-connect 的 handler。
 * @param getClient - 返回当前 GarminClient（已注入 store）
 */
export function makeConnectHandler(
  getClient: () => GarminClient | null,
  updateStatus: (patch: {
    status?: string
    displayName?: string
    email?: string
  }) => Promise<void>,
  store?: TokenStore,
  /** 读取已保存的凭据（从 settings 用户层）*/
  getSavedCredentials?: () => { email?: string; password?: string },
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      // localhost-only
      if (!isLocalhost(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, message: '仅允许本地访问' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: '仅支持 POST' })
        return
      }

      const body = JSON.parse(await readBody(req)) as ConnectRequestBody
      const client = getClient()
      if (!client) {
        sendJson(res, 503, { ok: false, message: 'Garmin 客户端未就绪' })
        return
      }

      if (body.action === 'mfa') {
        if (!body.mfaCode) {
          sendJson(res, 400, { ok: false, message: '缺少 MFA 验证码' })
          return
        }
        // 先检查是否有挂起的 MFA 状态
        let hasMfa = false
        try {
          const state = store ? await store.loadMfaState() : null
          hasMfa = !!state
        } catch {
          hasMfa = false
        }
        if (!hasMfa) {
          sendJson(res, 400, {
            ok: false,
            message: '没有挂起的 MFA 状态。请先填写邮箱和密码点击"连接 Garmin"发起登录；' +
              '若您的账号未开启两步验证，则不需要验证码。',
          })
          return
        }
        const tokens = await client.completeMfa(body.mfaCode)
        await updateStatus({
          status: 'connected',
          displayName: tokens.displayName,
          email: body.email ?? '',
        })
        sendJson(res, 200, { ok: true, displayName: tokens.displayName })
        return
      }

      // connect
      let email = body.email
      let password = body.password
      // 若未提供，用已保存的凭据
      if ((!email || !password) && getSavedCredentials) {
        const saved = getSavedCredentials()
        email = email || saved.email || ''
        password = password || saved.password || ''
      }
      if (!email || !password) {
        sendJson(res, 400, {
          ok: false,
          message: '请提供邮箱和密码，或先保存配置',
        })
        return
      }
      const result = await client.login(email, password)
      if (result.kind === 'mfa_required') {
        // 需要 MFA，等待用户输入验证码
        sendJson(res, 200, {
          ok: false,
          mfaRequired: true,
          message: '需要邮箱验证码，请查收邮箱',
        })
        return
      }
      await updateStatus({
        status: 'connected',
        displayName: result.tokens.displayName,
        email: body.email,
      })
      sendJson(res, 200, { ok: true, displayName: result.tokens.displayName })
    } catch (e) {
      logger.error('connect', '连接处理失败', e)
      sendJson(res, 500, {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }
}

/** 在 ctx.webServer 上注册 /garmin-connect route */
export function installConnectRoute(
  ctx: unknown,
  handler: ReturnType<typeof makeConnectHandler>,
): void {
  const anyCtx = ctx as {
    inject?: (services: string[], cb: (sc: unknown) => void) => void
  }
  if (!anyCtx.inject) {
    logger.warn('connect', 'ctx.inject 不可用，跳过 route 注册')
    return
  }
  anyCtx.inject(['webServer'], (webCtx) => {
    const ws = (webCtx as { webServer?: { register: (o: unknown) => () => void } }).webServer
    if (!ws) {
      logger.warn('connect', 'webServer 不可用，跳过 route 注册')
      return
    }
    const dispose = ws.register({
      kind: 'exact',
      path: '/garmin-connect',
      handler,
    })
    // 卸载时清理
    ;(webCtx as { effect?: (fn: () => () => void, label?: string) => void }).effect?.(
      () => dispose,
      'dsh-garmin-coach: connect route',
    )
    logger.info('connect', '/garmin-connect route registered')
  })
}
