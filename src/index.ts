/**
 * dsh-garmin-coach entry.
 *
 * 三层防御，确保 apply() 任何异常都被 catch，绝不传给 DSH 主进程：
 *   1. 外层 try-catch 兜底整个 apply()，最后 logger + return
 *   2. 每个 seam (tools / settings / commands) 单独 try-catch，单点失败不影响其它
 *   3. 异常统一走 logger.error() 写到日志文件，不污染 DSH console
 *
 * 严格按 DSH 0.1.7-rc.2 官方 API（SettingsForms）：
 *   - 工具注册：ctx.tools.register(def) → 返回 disposer（scope-fiber effect）
 *   - Settings：入口导出 `Config`（schemastery，字段 .volatile()），
 *     SettingsForms 自动生成「设置 → 插件」配置卡片；读写按 loader entry id
 *     走 ctx.settings.describe() / ctx.settings.update(id, patch, expectedRevision)
 *   - 命令注册：ctx.commands.register({ name, description, input, handler })
 *
 * 软依赖用 ctx.inject + try-catch 兜住"服务不存在"的 fatal。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { GarminClient } from './auth/client.js'
import type { TokenStore } from './auth/client.js'
import type { GarminCachedTokens, GarminMfaState } from './auth/types.js'
import { FileTokenStore } from './auth/file-store.js'
import { makeQueries } from './api/queries.js'
import type { GarminQueries } from './api/queries.js'
import { defineGarminTools } from './tools/register.js'
import { defineStatsTools } from './tools/stats-tools.js'
import { GarminStoreFile, SYNC_DAYS_BACK_MAX, FULL_SYNC_DEFAULT_DAYS } from './storage.js'
import type { SyncResult } from './sync.js'
import {
  GARMIN_SETTINGS_NS,
  installGarminSettingsRoute,
  makeGarminSettingsHandler,
  type GarminSettingsValue,
} from './settings-web.js'
import { logger } from './logger.js'

export const name = 'dsh-garmin-coach'
export const inject = [
  'credentials',
  'tools',
  'commands',
  'agents',
  'settings',
] as const

// 安全：不持久化账号(email)/密码 —— 凭据只在登录时内存用一次，token 过期后需重新输入。
//
// dsh 0.1.7-rc.2 SettingsForms：
//   - 插件入口导出的 Config 就是该 entry 的配置 schema，设置面板据此自动生成卡片；
//   - 字段必须 `.volatile()`，SettingsForms 才会呈现，并允许在线编辑（不重启插件）；
//   - 解析后的 config 里 volatile 字段是 `{ get() }` 引用，由 cordis 在配置变化时原地更新。
export const Config = z.object({
  // 区域：true=中国区(garmin.cn)，false=国际区(garmin.com)
  isCn: z.boolean().default(true).volatile(),
  status: z
    .union([z.const('disconnected'), z.const('connected'), z.const('awaiting_mfa')])
    .default('disconnected')
    .volatile(),
  displayName: z.string().default('').volatile(),
  lastSyncAt: z.string().default('').volatile(),
  // 注意：这里不带 `.max(30)` —— 历史脏数据（用户在旧版本手动设的 90/365）会被 schema 拒绝，
  // 导致整个 Config 失效，所有保存操作静默失败（面板永远显示 fallback 默认值）。
  // 实际拉取天数的硬上限在 src/sync.ts L3 + src/index.ts L2 两层截断保证。
  // 默认值与上限都从 storage.ts 的 SYNC_DAYS_BACK_MAX 导出常量读取（单一来源）
  syncDaysBack: z.number().min(1).default(SYNC_DAYS_BACK_MAX).volatile(),
  /** 全量同步起始日期（YYYY-MM-DD）*/
  fullSyncFrom: z.string().default('').volatile(),
  // 说明：只支持手动同步，不配置自动同步频率（防 Garmin 行为指纹检测）
})

/** Config 默认值：服务缺失 / 读取失败时的兜底 */
const DEFAULT_SETTINGS = {
  isCn: true,
  status: 'disconnected' as const,
  displayName: '',
  lastSyncAt: '',
  syncDaysBack: SYNC_DAYS_BACK_MAX,
  fullSyncFrom: '',
}

// ────────────────────────────────────────────────────────────────────────
//  ctx 类型（宽松、容错 —— 适配 0.1.7 ToolRuntime / SettingsProvider 接口）
// ────────────────────────────────────────────────────────────────────────

interface CordisCredentials {
  set: (ref: string, value: unknown) => Promise<unknown>
  /** DSH 返回 { value, source } 或 undefined */
  get: (ref: string) => Promise<{ value?: unknown; source?: string } | undefined>
  unset: (ref: string) => Promise<unknown>
}

/** Tools seam —— 0.1.7 ToolRuntime.register 接受完整 ToolDefinition。 */
interface PluginTools {
  register: (definition: unknown) => () => void
}

/** Commands seam —— 0.1.7 命令注册契约。 */
interface PluginCommands {
  register: (cmd: {
    name: string
    description?: string
    input?: {
      hint: string
      images?: boolean
    }
    recordInput?: boolean
    handler: (i: string, signal?: AbortSignal) => Promise<unknown>
  }) => () => void | unknown
}

/** SettingsForms.describe() 返回的一行（ns = loader entry id）。 */
interface SettingsFormRow {
  ns: string
  revision?: number
  value?: unknown
}
/**
 * Settings seam —— dsh 0.1.7-rc.2 SettingsForms。
 *
 * 不再有 register(ns, schema) / owner scope：schema 由入口导出的 Config 提供，
 * 读写按 loader entry id 调 service 上的 update/replace/describe。
 */
interface PluginSettings {
  /** 返回所有可配置 entry 的表单行（含 revision，用于并发冲突检测） */
  describe: (options?: { redactSecrets?: boolean }) => SettingsFormRow[]
  /** 合并 patch 写入：显式字段覆盖，未发送字段保持不动 + 冲突检测 */
  update?: (ns: string, patch: unknown, expectedRevision?: number) => Promise<unknown>
  /** 整体替换写入（兜底）：未出现的键回落 schema 默认值 */
  replace?: (ns: string, section: unknown, expectedRevision?: number) => Promise<unknown>
  /** SettingsForms.writable getter */
  writable?: boolean
}

interface PluginContext {
  credentials?: CordisCredentials
  tools?: PluginTools
  commands?: PluginCommands
  settings?: PluginSettings
  /** cordis 会把当前 fiber 挂到 ctx 上（fiber.entry.options.id 即 loader entry id） */
  fiber?: { entry?: { options?: { id?: string }; id?: string } }
  entry?: { id?: string; options?: { id?: string } }
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
    logger.warn('plugin', 'ctx.tools 不可用，跳过 tool 注册')
    return
  }
  safeSync('apply.tools', undefined, () => {
    for (const t of tools) {
      safeSync(`apply.tools.${t.name}`, undefined, () => {
        // t 已是 defineTool 结果（含 output.schema/render）。
        // 0.1.7 register 返回 disposer（unregister 函数），本插件全局随 apply 单次注册，
        // 由 cordis fiber 在 reload/dispose 时清理，无需手动持有。
        ctx.tools!.register(t)
      })
    }
    logger.info('plugin', `registered ${tools.length} tools`)
  })
}

/** 读取 volatile 引用（schemastery .volatile() 解析后是 `{ get() }` 形式）。 */
function readVolatile<T>(node: unknown, fallback: T): T {
  if (node !== null && typeof node === 'object' && typeof (node as { get?: unknown }).get === 'function') {
    const value = (node as { get: () => T | undefined }).get()
    return value === undefined ? fallback : value
  }
  return node === undefined || node === null ? fallback : (node as T)
}

/** 从 apply 的第二个参数（已解析的 Config）读当前 settings 快照。 */
function readSettingsFromConfig(config: unknown): GarminSettingsValue {
  const c = (config ?? {}) as Record<string, unknown>
  return {
    isCn: readVolatile(c['isCn'], DEFAULT_SETTINGS.isCn),
    status: readVolatile(c['status'], DEFAULT_SETTINGS.status),
    displayName: readVolatile(c['displayName'], DEFAULT_SETTINGS.displayName),
    lastSyncAt: readVolatile(c['lastSyncAt'], DEFAULT_SETTINGS.lastSyncAt),
    syncDaysBack: readVolatile(c['syncDaysBack'], DEFAULT_SETTINGS.syncDaysBack),
    fullSyncFrom: readVolatile(c['fullSyncFrom'], DEFAULT_SETTINGS.fullSyncFrom),
  }
}

/**
 * 解析当前 loader entry id —— SettingsForms 以 entry id 作为写入/查询的 ns。
 * bundles 加载时由包内 cordis.patch.yml 指定为 'garmin-coach'；这里优先取运行时值。
 */
function resolveEntryId(ctx: PluginContext): string {
  return (
    ctx.fiber?.entry?.options?.id ??
    ctx.fiber?.entry?.id ??
    ctx.entry?.options?.id ??
    ctx.entry?.id ??
    GARMIN_SETTINGS_NS
  )
}


function tryRegisterCommands(ctx: PluginContext, queries: GarminQueries): void {
  if (!ctx.commands) {
    logger.warn('plugin', 'ctx.commands 不可用，跳过命令注册')
    return
  }
  safeSync('apply.commands', undefined, () => {
    ctx.commands!.register({
      name: 'garmin-dashboard',
      description: '显示今日 Garmin 健康看板摘要（步数、睡眠、HRV 等）。',
      input: {
        hint: '可选：自定义看板标题，如"本周状态"',
        images: false,
      },
      handler: async (input: string, _signal?: AbortSignal) => {
        // 命令 handler 内部：catch 一切异常，返回 CommandResult（dsh 框架契约）
        try {
          const daily = await queries.daily()
          return {
            kind: 'success',
            text: `${input || 'Garmin 今日状态'}\n日期：${new Date().toISOString().slice(0, 10)}\n步数：${(daily as { totalSteps?: number } | null)?.totalSteps ?? '—'}`,
          }
        } catch (e) {
          logger.error('commands.garmin-dashboard', 'handler failed', e)
          return {
            kind: 'error',
            text: '未连接或 Garmin 暂时不可用。在 Settings → Garmin Coach 连接账号。',
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
): Promise<SyncResult | undefined> {
  if (!store || !queries) return undefined
  try {
    const settings = getSettings()
    // 强校验：超出 30 天强制截断（防用户改 settings 文件绕过 schema）
    const rawDays = settings.syncDaysBack ?? SYNC_DAYS_BACK_MAX
    const days = Math.min(Math.max(1, rawDays), SYNC_DAYS_BACK_MAX)
    const { syncGarmin } = await import('./sync.js')
    const result = await syncGarmin({
      days,
      store,
      queries,
    })
    logger.info('settings-web', `连接后自动同步完成: ${JSON.stringify(result)}`)
    return result
  } catch (e) {
    logger.error('settings-web', '连接后自动同步失败', e)
    return undefined
  }
}

/**
 * 写入 settings（dsh 0.1.7 语义修正）。
 *
 * **为什么用合并（update）而不是整体替换（replace）**：
 * 前端表单（`lib/client.js` doSave）只提交它管理的 5 个字段
 * （isCn / status / displayName / lastSyncAt / syncDaysBack），**不含 `fullSyncFrom`**；
 * 连接成功后的回写（safeConnected）同样只有这 5 个字段。
 * `SettingsProvider.replace()` 是**整体替换**：section 里没出现的键会回落 base/schema 默认值，
 * 于是每次保存/连接都会把用户手工配置的 `fullSyncFrom` 抹成 ''（全量同步起点丢失）。
 * `update()` 走 mergeLayers(user, patch)：显式发送的字段照常覆盖（前端会显式发 '' / 0），
 * 没发送的字段保持不动 —— 正是官方文档对"持有可能过期视图的 wire 调用方"推荐的写入路径。
 *
 * **为什么带 expectedRevision**：
 * 前端 GET 拿到 `revision` 并在 save 时回传；陈旧 revision 会被服务端以
 * `SettingsConflictError` 拒绝，避免多标签页并发覆盖。这是原始（HEAD）实现就有的行为，
 * 必须保留。
 *
 * 回退链：service.update → service.replace。
 */
async function writeGarminSettings(
  ctx: PluginContext,
  patch: Record<string, unknown>,
  expectedRevision?: number,
): Promise<void> {
  const settings = ctx.settings
  // 1) service.update：合并 + 冲突检测（首选，0.1.7 wire-surface 推荐路径）
  if (settings && typeof settings.update === 'function') {
    await settings.update(GARMIN_SETTINGS_NS, patch, expectedRevision)
    return
  }
  // 2) 兜底：整体替换（语义较弱，未发送字段会被重置）
  if (settings && typeof settings.replace === 'function') {
    await settings.replace(GARMIN_SETTINGS_NS, patch, expectedRevision)
    return
  }
  throw new Error('settings seam 不支持写入（update / replace 均不可用）')
}

export function apply(rawCtx: Context, config?: unknown): void {
  try {
    logger.info('plugin', 'apply(ctx) start')
    const ctx = rawCtx as unknown as PluginContext

    // 构造 store / client / queries：每一个内部 try-catch
    // 用 FileTokenStore（磁盘 JSON）存 Garmin token——DSH credentials 只支持字符串值，不适合存 token 对象
    const store = safeSync('apply.store', FileTokenStore.default(), () =>
      FileTokenStore.default(),
    )

    // 0.1.7 SettingsForms：无 owner scope —— 当前配置由入口导出的 Config 提供，
    // apply 的第二个参数就是已解析的 config（volatile 字段是 { get } 引用，原地更新）。
    // getSettings() 每次重读，天然拿到最新值（isCn 决定 garmin.cn / garmin.com）。
    const getSettings = (): GarminSettingsValue => readSettingsFromConfig(config)
    const initialSettings = getSettings()
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
    tryRegisterCommands(ctx, queries)

    // 暴露 garminStore 供其它 sub-plugin 用（存到 globalThis，避免 ctx 写属性）
    if (garminStore) {
      ;(globalThis as Record<string, unknown>).__garmin_store = garminStore
      logger.info('plugin', 'garmin store ready (data/garmin.json)')
    }

    // Garmin 设置 + 连接 route：/garmin-settings（读/保存/连接，参考 dsh-email）
    safeSync('apply.settingsRoute', undefined, () => {
      // volatile 引用每次重读都拿到最新值；读取失败由 readSettingsFromConfig 兜底默认值。
      const getSettingsValue = getSettings

      const getRevision = (): number => {
        // 0.1.7：scope.get() 返回 deepFreeze 的 resolved value；
        // 当前 SettingsProvider 没有把 revision 暴露到 scope —— 这里降级到 0，
        // 由 SettingsConflictError 在并发写时挡掉（owner-scope 写队列仍按顺序处理）。
        try {
          const s = (rawCtx as unknown as PluginContext).settings
          const desc = s?.describe?.() ?? []
          const row = desc.find((r) => r.ns === GARMIN_SETTINGS_NS)
          return row?.revision ?? 0
        } catch {
          return 0
        }
      }

      /** 全量同步实时进度（内存态，供前端轮询）*/
const fullSyncState: {
  status: 'idle' | 'running' | 'paused' | 'done' | 'error'
  processed: number
  total: number
  cursor?: string
  error?: string
  /** 本次全量同步累计新增活动数 */
  activitiesAdded?: number
  /** 本次全量同步后活动总数 */
  activitiesTotal?: number
} = { status: 'idle', processed: 0, total: 0 }

const handler = makeGarminSettingsHandler({
        getValue: getSettingsValue,
        getRevision,
        isWritable: () => {
          try {
            const s = (rawCtx as unknown as PluginContext).settings
            return s?.writable !== false
          } catch {
            return true
          }
        },
        save: async (value, expectedRevision) => {
          try {
            // 安全：任何来源的 save 都剥离 email/password，绝不落盘凭据
            const { email, password, ...safe } = (value ?? {}) as Record<string, unknown> & { email?: string; password?: string }
            // 合并写入 + 冲突检测（见 writeGarminSettings 文档注释）
            await writeGarminSettings(ctx, safe, expectedRevision)
            logger.info('settings-web', `保存成功: ${JSON.stringify({ ...safe, password: safe.password ? '***' : '' })}`)
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
            // 安全：不读已保存的凭据——email/password 必须由本次请求提供（内存用一次，不落盘）
            const effEmail = email || ''
            const effPassword = password || ''
            if (!effEmail || !effPassword) {
              return { ok: false, message: '请提供邮箱和密码' }
            }
            // 登录成功后更新 settings 状态（不写 email/password 到 settings）
            const markConnected = async (displayName: string) => {
              try {
                const next = {
                  ...getSettingsValue(),
                  status: 'connected' as const,
                  displayName,
                  lastSyncAt: new Date().toISOString(),
                }
                await writeGarminSettings(ctx, next)
                logger.info('settings-web', `已连接: ${displayName}`)
              } catch (e) {
                logger.error('settings-web', '更新连接状态失败', e)
              }
            }
            // 若有 mfaCode：完成 MFA（email 由本次请求传入，不从 mfa-state 读取）
            if (mfaCode) {
              const tokens = await client.completeMfa(mfaCode, effEmail)
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
            // 强校验：超出 30 天强制截断（防拉爆 Garmin）
            const rawDays = settings.syncDaysBack ?? SYNC_DAYS_BACK_MAX
            const days = Math.min(Math.max(1, rawDays), SYNC_DAYS_BACK_MAX)
            logger.info('settings-web', `手动同步触发（${days} 天）`)
            const result = await syncOnConnect(garminStore, queries, getSettingsValue)
            // 更新 settings 的 lastSyncAt（卡片/看板显示用）
            if (garminStore) {
              try {
                const storeData = await garminStore.read()
                const next = {
                  ...getSettingsValue(),
                  lastSyncAt: storeData.lastSyncAt || new Date().toISOString(),
                }
                await writeGarminSettings(ctx, next)
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
        // 全量同步（只同步活动，从指定日期起每 100 天批量拉取）
        syncAll: async (from) => {
          try {
            if (!garminStore) {
              return { ok: false, message: '数据存储未就绪' }
            }
            // 已在跑则不重复启动
            if (fullSyncState.status === 'running') {
              return { ok: true, started: true, message: '全量同步已在运行中', progress: fullSyncState }
            }
            const settings = getSettingsValue()
            // 默认起点：距今 FULL_SYNC_DEFAULT_DAYS 天前（含今天）—— 防止新用户点全量同步时直接拉 4+ 年把 Garmin 拉爆。
            // 用户在 UI 输入或 settings.fullSyncFrom 设置的更早日期才生效（用户明确行为优先）。
            const today0 = new Date()
            const defaultFromDate = new Date(today0)
            defaultFromDate.setDate(today0.getDate() - FULL_SYNC_DEFAULT_DAYS + 1)
            const defaultFrom = defaultFromDate.toISOString().slice(0, 10)
            const fromDate = from || settings.fullSyncFrom || defaultFrom
            logger.info('settings-web', '全量同步触发（从 ' + fromDate + '）')
            const { syncAllActivities } = await import('./sync.js')
            // 后台异步执行：立即返回，进度由 syncAllProgress 轮询
            fullSyncState.status = 'running'
            fullSyncState.processed = 0
            fullSyncState.total = 0
            fullSyncState.cursor = fromDate
            fullSyncState.error = undefined
            fullSyncState.activitiesAdded = 0
            fullSyncState.activitiesTotal = 0
            void (async () => {
              try {
                const result = await syncAllActivities(garminStore, queries, {
                  from: fromDate,
                  windowDays: 100,
                  sleepMs: 2000,
                  onProgress: (p) => {
                    fullSyncState.processed = p.processed
                    fullSyncState.total = p.total
                    fullSyncState.status = p.status
                    fullSyncState.cursor = p.cursor
                    fullSyncState.error = p.error
                  },
                })
                fullSyncState.status = result.synced ? 'done' : (result.error ? 'error' : 'done')
                if (result.error) fullSyncState.error = result.error
                // 记录本次全量同步实际新增活动数（供前端「同步完成」展示真实数字）
                fullSyncState.activitiesAdded = result.activitiesAdded
                fullSyncState.activitiesTotal = result.activitiesTotal
                if (result.synced) {
                  try {
                    const storeData = await garminStore.read()
                    const next = {
                      ...getSettingsValue(),
                      lastSyncAt: storeData.lastSyncAt || new Date().toISOString(),
                    }
                    await writeGarminSettings(ctx, next)
                  } catch (e) {
                    logger.error('settings-web', '全量同步后更新 lastSyncAt 失败', e)
                  }
                }
              } catch (e) {
                fullSyncState.status = 'error'
                fullSyncState.error = e instanceof Error ? e.message : String(e)
              }
            })()
            return { ok: true, started: true, message: '全量同步已启动，正在后台拉取…', progress: fullSyncState }
          } catch (e) {
            logger.error('settings-web', '全量同步启动失败', e)
            return { ok: false, message: e instanceof Error ? e.message : String(e) }
          }
        },
        // 全量同步进度查询（前端轮询）
        syncAllProgress: async () => {
          return { ok: true, progress: fullSyncState }
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
        // 清掉 Garmin token（账号变更时调）
        clearGarminTokens: async () => {
          try {
            await store.clear()
            logger.info('plugin', 'Garmin token 已清空（账号变更）')
          } catch (e) {
            logger.error('plugin', '清 Garmin token 失败', e)
            throw e
          }
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