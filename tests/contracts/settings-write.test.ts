/**
 * settings 写入契约回归测试
 *
 * 防御两类真实 bug（2026-09-26 修复）：
 *   BUG-1  save 丢弃 expectedRevision → 多标签页并发覆盖（冲突检测失效）
 *   BUG-2  save 走整体替换 replace → 前端未提交的字段（fullSyncFrom）被抹回默认值
 *
 * 契约来源：
 *   - @deepseek-ai/dsh-settings#SettingsProvider
 *     `update(ns, patch, expectedRevision)` 走 mergeLayers(user, patch)：
 *        显式发送的字段覆盖，未发送的字段保持不动
 *     `replace(ns, section, expectedRevision)` 是整体替换：
 *        未出现的键回落 base/schema 默认值
 *   - 前端 lib/client.js doSave()/safeConnected 只提交
 *     isCn/status/displayName/lastSyncAt/syncDaysBack（**不含 fullSyncFrom**）
 *
 * 因此插件的 save 必须走 update（合并）+ 透传 expectedRevision。
 */
import assert from 'node:assert/strict'
import { apply } from '../../src/index.js'

interface UpdateCall {
  ns: unknown
  patch: Record<string, unknown>
  expectedRevision: number | undefined
}
interface ReplaceCall {
  ns: unknown
  section: unknown
  expectedRevision: number | undefined
}

const captured = {
  update: [] as UpdateCall[],
  replace: [] as ReplaceCall[],
}

/** 模拟 SettingsProvider 的用户层：update 合并、replace 整体替换 */
let userSection: Record<string, unknown> = {}
const REVISION = 5

let route:
  | {
      path: string
      kind: string
      handler: (
        req: unknown,
        res: unknown,
      ) => void | Promise<void>
    }
  | undefined

/** 造一对假的 req/res，返回响应体 */
function exchange(method: string, body?: unknown) {
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return req
    },
  }
  const res: Record<string, unknown> = {
    writeHead(status: number) {
      res['_status'] = status
    },
    end(bytes: Uint8Array) {
      res['_body'] = JSON.parse(Buffer.from(bytes).toString('utf8'))
    },
  }
  return {
    req,
    res,
    result() {
      return { status: res['_status'] as number, body: res['_body'] as Record<string, unknown> }
    },
  }
}

before(() => {
  apply({
    entry: { id: 'garmin-coach' },
    credentials: {
      set: async () => undefined,
      get: async () => null,
      delete: async () => undefined,
    },
    tools: {
      register: () => () => undefined,
    },
    commands: {
      register: () => () => undefined,
    },
    agents: { inject: () => Promise.resolve() },
    settings: {
      register: () => ({
        get: () => ({ ...userSection }),
        watch: () => () => undefined,
        update: async (patch: unknown) => {
          // scope 级写入也记入同一数组：若有人回退成 scope 路径，测试仍能给出
          // 「expectedRevision 未透传」的精确诊断，而不是泛泛的「没有写入」
          captured.update.push({
            ns: 'garmin-coach',
            patch: patch as Record<string, unknown>,
            expectedRevision: undefined,
          })
          userSection = { ...userSection, ...(patch as Record<string, unknown>) }
        },
        replace: async (section: unknown) => {
          captured.replace.push({
            ns: 'garmin-coach',
            section,
            expectedRevision: undefined,
          })
          userSection = { ...(section as Record<string, unknown>) }
        },
      }),
      // service 级写入（writeGarminSettings 的首选路径）
      update: async (ns: unknown, patch: unknown, expectedRevision?: number) => {
        captured.update.push({
          ns,
          patch: patch as Record<string, unknown>,
          expectedRevision,
        })
        // 真实语义：合并
        userSection = { ...userSection, ...(patch as Record<string, unknown>) }
      },
      replace: async (ns: unknown, section: unknown, expectedRevision?: number) => {
        captured.replace.push({ ns, section, expectedRevision })
        // 真实语义：整体替换
        userSection = { ...(section as Record<string, unknown>) }
      },
      describe: () => [
        { ns: 'garmin-coach', revision: REVISION, user: userSection, value: userSection },
      ],
      writable: true,
    },
    inject: (deps: string[], cb: (scoped: unknown) => void) => {
      if (deps.includes('webServer')) {
        cb({
          webServer: {
            register: (r: typeof route) => {
              route = r
              return () => undefined
            },
          },
          effect: (fn: () => () => void) => fn(),
        })
      }
      return () => undefined
    },
  } as unknown as Parameters<typeof apply>[0])
})

/** 复刻 lib/client.js doSave() 的载荷：只有 5 个字段，不含 fullSyncFrom */
const FRONTEND_FORM_PAYLOAD = {
  isCn: true,
  status: 'disconnected',
  displayName: 'young_garmin',
  lastSyncAt: '2026-09-26T00:00:00.000Z',
  syncDaysBack: 30,
}

// ─────────────────────────────────────────────
// BUG-1: expectedRevision 必须透传（并发冲突检测）
// ─────────────────────────────────────────────

test('settings.save: 必须透传前端 expectedRevision（并发冲突检测）', async () => {
  assert.ok(route, '/garmin-settings route 必须注册')
  captured.update.length = 0
  captured.replace.length = 0

  const ex = exchange('POST', {
    action: 'save',
    value: FRONTEND_FORM_PAYLOAD,
    expectedRevision: 42,
  })
  await route.handler(ex.req, ex.res)

  const written = [...captured.update, ...captured.replace]
  assert.ok(written.length > 0, 'save 必须触发一次 settings 写入')
  for (const w of written) {
    assert.equal(
      w.expectedRevision,
      42,
      'save 必须把预期 revision 透传给 settings（否则陈旧视图会静默覆盖他人改动）',
    )
  }
})

// ─────────────────────────────────────────────
// BUG-2: save 必须走合并（update），不能用整体替换（replace）
// ─────────────────────────────────────────────

test('settings.save: 走合并写入 update（不能用整体替换）', async () => {
  assert.ok(route, '/garmin-settings route 必须注册')
  captured.update.length = 0
  captured.replace.length = 0

  // 用户手工配置过全量同步起点（前端表单不提交这个字段）
  userSection = { fullSyncFrom: '2022-01-01' }

  const ex = exchange('POST', { action: 'save', value: FRONTEND_FORM_PAYLOAD })
  await route.handler(ex.req, ex.res)

  assert.equal(
    captured.replace.length,
    0,
    '❌ save 不得使用整体替换 replace —— 前端未提交的字段（如 fullSyncFrom）会被抹回默认值',
  )
  assert.ok(captured.update.length > 0, 'save 必须使用 update（合并）')

  assert.equal(
    userSection['fullSyncFrom'],
    '2022-01-01',
    '❌ 前端未提交的 fullSyncFrom 必须保留（合并语义）',
  )
  assert.equal(
    userSection['displayName'],
    'young_garmin',
    '✅ 前端显式提交的字段必须照常生效',
  )
})

// ─────────────────────────────────────────────
// 安全：凭据绝不落盘
// ─────────────────────────────────────────────

test('settings.save: email/password 必须被剥离，不得落盘', async () => {
  assert.ok(route, '/garmin-settings route 必须注册')
  userSection = {}

  const ex = exchange('POST', {
    action: 'save',
    value: { ...FRONTEND_FORM_PAYLOAD, email: 'leak@example.com', password: 'p@ssw0rd' },
  })
  await route.handler(ex.req, ex.res)

  const dumped = JSON.stringify(userSection)
  assert.ok(
    !dumped.includes('leak@example.com') && !dumped.includes('p@ssw0rd'),
    `❌ 凭据泄漏到 settings: ${dumped}`,
  )
})

// ─────────────────────────────────────────────
// GET 契约：前端拿到的结构必须可用于并发检测
// ─────────────────────────────────────────────

test('settings GET: 返回 revision + writable（前端并发检测依赖）', async () => {
  assert.ok(route, '/garmin-settings route 必须注册')
  const ex = exchange('GET')
  await route.handler(ex.req, ex.res)
  const { status, body } = ex.result()

  assert.equal(status, 200)
  const settings = body['settings'] as { revision?: unknown; value?: unknown }
  assert.equal(
    settings.revision,
    REVISION,
    'GET 必须返回 revision（save 时回传用于冲突检测）',
  )
  assert.ok(settings.value, 'GET 必须返回 settings.value')
  assert.equal(body['writable'], true, 'GET 必须返回 writable 标记')
})
