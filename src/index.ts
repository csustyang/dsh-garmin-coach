/**
 * dsh-garmin-coach entry.
 *
 * 三层防御，确保 apply() 任何异常都被 catch，绝不传给 DSH 主进程：
 *   1. 外层 try-catch 兜底整个 apply()，最后 logger + return
 *   2. 每个 seam (tools / settings / commands) 单独 try-catch，单点失败不影响其它
 *   3. 异常统一走 logger.error() 写到日志文件，不污染 DSH console
 *
 * 严格按 DSH 官方 API：ctx.tools.register / ctx.settings.register。
 * 软依赖用 ctx.inject + try-catch 兜住"服务不存在"的 fatal。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'

import { GarminClient } from './auth/client.js'
import type { TokenStore } from './auth/client.js'
import type { GarminCachedTokens, GarminMfaState } from './auth/types.js'
import { FileTokenStore } from './auth/file-store.js'
import { makeQueries } from './api/queries.js'
import type { GarminQueries } from './api/queries.js'
import { defineGarminTools } from './tools/register.js'
import { defineStatsTools } from './tools/stats-tools.js'
import { GarminStoreFile } from './storage.js'
import { installConnectRoute, makeConnectHandler } from './connect.js'
import {
  GARMIN_SETTINGS_NS,
  installGarminSettingsRoute,
  makeGarminSettingsHandler,
  type GarminSettingsValue,
} from './settings-web.js'
import { logger } from './logger.js'
import {
  installSettingsSection,
  settingsNamespace,
} from '@deepseek-ai/dsh-settings'

export const name = 'dsh-garmin-coach'
export const inject = [
  'credentials',
  'tools',
  'commands',
  'agents',
  'settings',
] as const

// 用 settingsNamespace() 生成命名空间（官方推荐），而不是硬编码字符串
const SETTINGS_NAMESPACE = settingsNamespace('garmin-coach')

const GarminSettingsSchema = z.object({
  email: z.string().default(''),
  // 密码用 role('secret')：DSH 会加密存储、响应中脱敏（同 dsh-email）
  password: z.string().role('secret').default(''),
  // 区域：true=中国区(garmin.cn)，false=国际区(garmin.com)
  isCn: z.boolean().default(true),
  status: z
    .union([z.const('disconnected'), z.const('connected'), z.const('awaiting_mfa')])
    .default('disconnected'),
  displayName: z.string().default(''),
  lastSyncAt: z.string().default(''),
  syncDaysBack: z.number().default(14),
  // 说明：只支持手动同步，不配置自动同步频率（防 Garmin 行为指纹检测）
})

const INITIAL_SETTINGS = {
  email: '',
  password: '',
  isCn: true,
  status: 'disconnected' as const,
  displayName: '',
  lastSyncAt: '',
  syncDaysBack: 14,
}

// ────────────────────────────────────────────────────────────────────────
//  ctx 类型（宽松、容错）
// ────────────────────────────────────────────────────────────────────────

interface CordisCredentials {
  set: (ref: string, value: unknown) => Promise<unknown>
  /** DSH 返回 { value, source } 或 undefined */
  get: (ref: string) => Promise<{ value?: unknown; source?: string } | undefined>
  unset: (ref: string) => Promise<unknown>
}

interface PluginContext {
  credentials?: CordisCredentials
  tools?: {
    register: (t: {
      name: string
      description: string
      parameters: unknown
      execute: (args: unknown) => Promise<unknown>
    }) => unknown
  }
  commands?: {
    register: (c: {
      id: string
      title: string
      description?: string
      invoke: (i: string) => Promise<unknown>
    }) => unknown
  }
  settings?: {
    register: (
      ns: string,
      schema: unknown,
      options?: { base?: unknown; applies?: string },
    ) => {
      get: () => unknown
      watch: (cb: (v: unknown) => void) => () => void
      update: (patch: unknown) => Promise<unknown>
      replace: (section: unknown) => Promise<unknown>
    }
    describe: () => Array<{ ns: string; schema: unknown; value: unknown; user?: unknown; revision?: number }>
    replace: (ns: string, section: unknown, expectedRevision?: number) => Promise<unknown>
    writable?: boolean
  }
}

// ────────────────────────────────────────────────────────────────────────
//  安全工具
// ────────────────────────────────────────────────────────────────────────

/**
 * 同步 try-catch 包装：catch 后 logger.error 并返回 fallback。
 */
function safeSync<T>(scope: string, fallback: T, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    logger.error(scope, 'safeSync caught', e)
    return fallback
  }
}

/**
 * 异步 try-catch 包装：catch 后 logger.error 并返回 fallback。
 */
async function safeAsync<T>(scope: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    logger.error(scope, 'safeAsync caught', e)
    return fallback
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Cordis TokenStore 适配
// ────────────────────────────────────────────────────────────────────────

function makeCordisTokenStore(creds: CordisCredentials): TokenStore {
  return {
    async loadTokens() {
      const r = await safeAsync('token.loadTokens', undefined, () =>
        creds.get('garmin_tokens'),
      )
      return (r?.value as GarminCachedTokens | undefined) ?? null
    },
    async saveTokens(t) {
      await safeAsync('token.saveTokens', undefined, () => creds.set('garmin_tokens', t))
    },
    async clear() {
      await safeAsync('token.clear', undefined, () => creds.unset('garmin_tokens'))
    },
    async loadMfaState() {
      const r = await safeAsync('token.loadMfaState', undefined, () =>
        creds.get('garmin_mfa_state'),
      )
      return (r?.value as GarminMfaState | undefined) ?? null
    },
    async saveMfaState(s) {
      await safeAsync('token.saveMfaState', undefined, () => creds.set('garmin_mfa_state', s))
    },
    async clearMfaState() {
      await safeAsync('token.clearMfaState', undefined, () => creds.unset('garmin_mfa_state'))
    },
  }
}

// ────────────────────────────────────────────────────────────────────────
//  每个 seam 注册：单独 try-catch
// ────────────────────────────────────────────────────────────────────────

function tryRegisterTools(ctx: PluginContext, tools: ReturnType<typeof defineGarminTools>): void {
  if (!ctx.tools) {
    logger.warn('plugin', 'ctx.tools 不可用，跳过 9 个 tool 注册')
    return
  }
  safeSync('apply.tools', undefined, () => {
    for (const t of tools) {
      safeSync(`apply.tools.${t.name}`, undefined, () => {
        // t 已是 defineTool 结果（含 output.schema/render）
        ctx.tools!.register(t as never)
      })
    }
    logger.info('plugin', `registered ${tools.length} tools`)
  })
}

function tryRegisterSettings(
  ctx: Context,
  store: TokenStore,
): void {
  // 参考 dsh-email：直接用 ctx.settings.register 注册命名空间，
  // 返回 scope 用于读取（scope.get()），保存用 ctx.settings.replace。
  if (!ctx.settings) {
    logger.warn('plugin', 'ctx.settings 不可用，跳过 Settings 注册')
    return
  }
  safeSync('apply.settings', undefined, () => {
    const settingsScope = ctx.settings!.register(
      SETTINGS_NAMESPACE,
      GarminSettingsSchema,
      {
        base: INITIAL_SETTINGS,
        applies: 'live',
      },
    )

    logger.info('plugin', `settings namespace "${SETTINGS_NAMESPACE}" registered (dsh-email 方式)`)

    // 启动时尝试从 token 缓存恢复 connected 状态（不会抛）
    void (async () => {
      await safeAsync('settings.recoverStatus', undefined, async () => {
        const tokens = await store.loadTokens()
        if (tokens?.displayName) {
          logger.info('settings', `recovered token: ${tokens.displayName}`)
        }
      })
    })()
  })
}

function tryRegisterCommands(ctx: PluginContext, queries: GarminQueries): void {
  if (!ctx.commands) {
    logger.warn('plugin', 'ctx.commands 不可用，跳过命令注册')
    return
  }
  safeSync('apply.commands', undefined, () => {
    ctx.commands!.register({
      id: 'garmin-dashboard',
      title: 'Garmin Dashboard',
      description: '显示今日 Garmin 健康看板摘要（步数、睡眠、HRV 等）。',
      invoke: async (input: string) => {
        // 命令 invoke 内部：catch 一切异常，返回降级响应
        try {
          const daily = await queries.daily()
          return {
            ok: true,
            date: new Date().toISOString().slice(0, 10),
            steps: (daily as { totalSteps?: number } | null)?.totalSteps,
            message: input || 'Garmin 今日状态',
          }
        } catch (e) {
          logger.error('commands.garmin-dashboard', 'invoke failed', e)
          return {
            ok: false,
            error: '未连接或 Garmin 暂时不可用',
            hint: '在 Settings → Garmin Coach 连接账号',
          }
        }
      },
    })
    logger.info('plugin', 'command /garmin-dashboard registered')
  })
}

// ────────────────────────────────────────────────────────────────────────
//  apply() 入口：三层防御
// ────────────────────────────────────────────────────────────────────────

/**
 * 连接成功后自动同步（异步，不阻塞连接返回）。
 */
async function syncOnConnect(
  store: GarminStoreFile | null,
  queries: ReturnType<typeof makeQueries> | null,
  getSettings: () => GarminSettingsValue,
): Promise<void> {
  if (!store || !queries) return
  try {
    const settings = getSettings()
    const days = settings.syncDaysBack ?? 14
    const { syncGarmin } = await import('./sync.js')
    const result = await syncGarmin({
      days,
      store,
      queries,
    })
    logger.info('settings-web', `连接后自动同步完成: ${JSON.stringify(result)}`)
  } catch (e) {
    logger.error('settings-web', '连接后自动同步失败', e)
  }
}

export function apply(rawCtx: Context): void {
  try {
    logger.info('plugin', 'apply(ctx) start')
    const ctx = rawCtx as unknown as PluginContext

    // 构造 store / client / queries：每一个内部 try-catch
    // 用 FileTokenStore（磁盘 JSON）存 Garmin token——DSH credentials 只支持字符串值，不适合存 token 对象
    const store = safeSync('apply.store', FileTokenStore.default(), () =>
      FileTokenStore.default(),
    )

    // 从 settings 读 isCn（区域），决定用 garmin.cn 还是 garmin.com
    const initialSettings = (() => {
      try {
        const s = (rawCtx as unknown as { settings?: { describe?: () => Array<{ ns: string; user?: unknown }> } }).settings
        const row = (s?.describe?.() ?? []).find((r) => r.ns === 'garmin-coach')
        return (row?.user ?? {}) as { isCn?: boolean }
      } catch {
        return {}
      }
    })()
    const client = safeSync('apply.client', null, () => new GarminClient({ store, isCn: initialSettings.isCn ?? true }))
    if (!client) {
      logger.error('plugin', 'GarminClient 构造失败，apply 提前结束')
      return
    }
    const queries = safeSync('apply.queries', null, () => makeQueries(client))
    if (!queries) {
      logger.error('plugin', 'makeQueries 失败，apply 提前结束')
      return
    }
    const tools = safeSync('apply.toolsList', [], () => defineGarminTools(queries))

    // Garmin 数据存储（独立 JSON 文件，后期可换 PostgreSQL）
    const garminStore = safeSync(
      'apply.garminStore',
      null,
      () => new GarminStoreFile(),
    )

    // 统计查询工具（基于本地落库数据，不实时调 Garmin API）
    const statsTools = safeSync(
      'apply.statsTools',
      [],
      () => (garminStore ? defineStatsTools({ store: garminStore }) : []),
    )

    // 各 seam 注册（每个内部已包）
    tryRegisterTools(ctx, [...tools, ...statsTools])
    tryRegisterSettings(rawCtx, store)
    tryRegisterCommands(ctx, queries)

    // 暴露 garminStore 供其它 sub-plugin 用（存到 globalThis，避免 ctx 写属性）
    if (garminStore) {
      ;(globalThis as Record<string, unknown>).__garmin_store = garminStore
      logger.info('plugin', 'garmin store ready (data/garmin.json)')
    }

    // Garmin 设置 + 连接 route：/garmin-settings（读/保存/连接，参考 dsh-email）
    safeSync('apply.settingsRoute', undefined, () => {
      // 读取当前 settings 值
      const getSettingsValue = (): GarminSettingsValue => {
        try {
          const rawCtx2 = rawCtx as unknown as { settings?: { describe?: () => Array<{ ns: string; user?: unknown }> } }
          const describe = rawCtx2.settings?.describe?.() ?? []
          const row = describe.find((r) => r.ns === GARMIN_SETTINGS_NS)
          const user = (row?.user ?? {}) as GarminSettingsValue
          return { ...INITIAL_SETTINGS, ...user }
        } catch {
          return { ...INITIAL_SETTINGS }
        }
      }
      const getRevision = (): number => {
        try {
          const rawCtx2 = rawCtx as unknown as { settings?: { describe?: () => Array<{ ns: string; revision?: number }> } }
          const row = (rawCtx2.settings?.describe?.() ?? []).find((r) => r.ns === GARMIN_SETTINGS_NS)
          return row?.revision ?? 0
        } catch {
          return 0
        }
      }

      const handler = makeGarminSettingsHandler({
        getValue: getSettingsValue,
        getRevision,
        isWritable: () => {
          try {
            const rawCtx2 = rawCtx as unknown as { settings?: { writable?: boolean } }
            return rawCtx2.settings?.writable !== false
          } catch {
            return true
          }
        },
        save: async (value, expectedRevision) => {
          try {
            const s = (rawCtx as unknown as { settings?: { replace?: (ns: string, v: unknown, rev?: number) => Promise<unknown> } })
              .settings
            await s?.replace?.(GARMIN_SETTINGS_NS, value, expectedRevision)
            logger.info('settings-web', `保存成功: ${JSON.stringify({ ...value, password: value.password ? '***' : '' })}`)
          } catch (e) {
            logger.error('settings-web', '保存失败', e)
            throw e
          }
        },
        connect: async (email, password, mfaCode) => {
          try {
            // 若已有有效 token：直接返回已连接（不重新登录，避免重复触发验证码）
            try {
              const existing = await store.loadTokens()
              if (existing?.di && !mfaCode) {
                const exp = new Date(existing.di.expires_at).getTime()
                if (Date.now() < exp) {
                  return {
                    ok: true,
                    displayName: existing.displayName ?? '',
                    alreadyConnected: true,
                  }
                }
              }
            } catch {
              // token 读取失败，忽略，继续走登录
            }
            const saved = getSettingsValue()
            const effEmail = email || saved.email || ''
            const effPassword = password || saved.password || ''
            if (!effEmail || !effPassword) {
              return { ok: false, message: '请提供邮箱和密码，或先保存配置' }
            }
            // 登录成功后更新 settings 状态
            const markConnected = async (displayName: string) => {
              try {
                const s = (rawCtx as unknown as { settings?: { replace?: (ns: string, v: unknown, rev?: number) => Promise<unknown> } }).settings
                await s?.replace?.(GARMIN_SETTINGS_NS, {
                  ...getSettingsValue(),
                  email: effEmail,
                  status: 'connected',
                  displayName,
                  lastSyncAt: new Date().toISOString(),
                })
                logger.info('settings-web', `已连接: ${displayName}`)
              } catch (e) {
                logger.error('settings-web', '更新连接状态失败', e)
              }
            }
            // 若有 mfaCode：完成 MFA
            if (mfaCode) {
              const tokens = await client.completeMfa(mfaCode)
              await markConnected(tokens.displayName ?? '')
              // 触发同步（异步，不阻塞连接返回）
              void syncOnConnect(garminStore, queries, getSettingsValue)
              return { ok: true, displayName: tokens.displayName }
            }
            // 首次：登录（可能返回 mfa_required）
            const result = await client.login(effEmail, effPassword)
            if (result.kind === 'ok') {
              await markConnected(result.tokens.displayName ?? '')
              void syncOnConnect(garminStore, queries, getSettingsValue)
              return { ok: true, displayName: result.tokens.displayName }
            }
            return {
              ok: false,
              mfaRequired: true,
              message: '需要验证码：请查收手机短信，输入验证码后再次连接',
            }
          } catch (e) {
            logger.error('settings-web', '连接失败', e)
            return {
              ok: false,
              message: e instanceof Error ? e.message : String(e),
            }
          }
        },
        // 手动触发同步
        sync: async () => {
          try {
            const settings = getSettingsValue()
            const days = settings.syncDaysBack ?? 14
            logger.info('settings-web', `手动同步触发（${days} 天）`)
            const result = await syncOnConnect(garminStore, queries, getSettingsValue)
            // 更新 settings 的 lastSyncAt（卡片/看板显示用）
            if (garminStore) {
              try {
                const storeData = await garminStore.read()
                const s = (rawCtx as unknown as { settings?: { replace?: (ns: string, v: unknown, rev?: number) => Promise<unknown> } }).settings
                await s?.replace?.(GARMIN_SETTINGS_NS, {
                  ...getSettingsValue(),
                  lastSyncAt: storeData.lastSyncAt || new Date().toISOString(),
                })
                logger.info('settings-web', `同步完成，更新 lastSyncAt=${storeData.lastSyncAt}`)
              } catch (e) {
                logger.error('settings-web', '更新 lastSyncAt 失败', e)
              }
            }
            return { ok: true, message: '同步完成', result }
          } catch (e) {
            logger.error('settings-web', '手动同步失败', e)
            return { ok: false, message: e instanceof Error ? e.message : String(e) }
          }
        },
        // 看板聚合数据
        dashboard: async () => {
          if (!garminStore) return { error: true, message: '数据存储未就绪' }
          const { dashboardSummary } = await import('./stats.js')
          return dashboardSummary(garminStore)
        },
        // AI 训练建议（基于规则生成结构化洞察）
        insights: async () => {
          if (!garminStore) return { error: true, message: '数据存储未就绪' }
          const { generateInsights } = await import('./stats.js')
          return generateInsights(garminStore)
        },
        // 训练任务打卡
        toggleTask: async (taskId: string) => {
          if (!garminStore) return { ok: false, message: '数据存储未就绪' }
          return garminStore.toggleTask(taskId)
        },
      })
      installGarminSettingsRoute(rawCtx, handler)
    })



    logger.info('plugin', 'apply(ctx) finished')
  } catch (e) {
    // 最后一道防线：catch 一切，绝不让异常传到 DSH
    logger.error('plugin', 'apply(ctx) FATAL — caught at outermost boundary', e)
  }
}

// 重新导出
export { GarminClient } from './auth/client.js'
export { FileTokenStore } from './auth/file-store.js'
export { makeQueries } from './api/queries.js'
export { defineGarminTools } from './tools/register.js'
