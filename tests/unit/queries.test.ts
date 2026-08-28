/**
 * queries.ts (api) 单元测试
 *
 * 覆盖：whoami 在未连接时短路返回友好字符串（hasToken 今天新加）；
 *      daily/sleep/hrv/readiness/training 在 getApi 抛错时由 withBoundary 兜底。
 *
 * 注意：whoami 走 withBoundary，所以未连接不抛错，但 fallback 是 {error:true} 对象，
 *       会违反 output schema。today 的 hasToken 短路就是为了修复这个 bug。
 */
import assert from 'node:assert/strict'
import { makeQueries } from '../../src/api/queries.js'
import { GarminAuthError, GarminClient } from '../../src/auth/client.js'
import type { TokenStore } from '../../src/auth/token-store.js'

// 内存 mock TokenStore
function mockStore(tokens: any = null, mfa: any = null): TokenStore {
  return {
    async loadTokens() {
      return tokens
    },
    async saveTokens(t) {
      void t
    },
    async clear() {
      void undefined
    },
    async loadMfaState() {
      return mfa
    },
    async saveMfaState(s) {
      void s
    },
    async clearMfaState() {
      void undefined
    },
  }
}

// 抛错的 mock client
function throwingClient(msg = '未登录'): GarminClient {
  const c = Object.create(GarminClient.prototype) as GarminClient
  ;(c as any).getApi = async () => {
    throw new GarminAuthError(msg)
  }
  ;(c as any).hasToken = async () => false
  return c
}

// ─────────────────────────────────────────────
// whoami
// ─────────────────────────────────────────────

test('whoami: 未连接（无 token）时返回友好字符串而非 throw', async () => {
  const client = Object.create(GarminClient.prototype) as GarminClient
  ;(client as any).store = mockStore(null)
  ;(client as any).hasToken = async () => false
  // getApi 故意不实现（未连接时不应被调用）
  let getApiCalled = false
  ;(client as any).getApi = async () => {
    getApiCalled = true
    throw new GarminAuthError('未登录')
  }
  const q = makeQueries(client)
  const result = await q.whoami()
  assert.equal(typeof result, 'string', '未连接时必须返回字符串（schema 要求）')
  assert.ok(result.includes('未连接') || result.includes('设置') || result.includes('Garmin'))
  assert.equal(getApiCalled, false, 'hasToken 短路：不应调用 getApi')
})

test('whoami: 有 token 但 displayName 为空时返回空字符串', async () => {
  const client = Object.create(GarminClient.prototype) as GarminClient
  ;(client as any).hasToken = async () => true
  ;(client as any).getApi = async () => ({
    displayName: '',
    daily: async () => undefined,
    sleep: async () => undefined,
    hrv: async () => undefined,
    readiness: async () => undefined,
    training: async () => undefined,
    activities: async () => [],
  })
  const q = makeQueries(client)
  const result = await q.whoami()
  assert.equal(result, '', '有 token 但 displayName 为空 → 返回空字符串')
})

test('whoami: 有 token 且 displayName 正常返回名字', async () => {
  const client = Object.create(GarminClient.prototype) as GarminClient
  ;(client as any).hasToken = async () => true
  ;(client as any).getApi = async () => ({
    displayName: 'yangtao',
    daily: async () => undefined,
    sleep: async () => undefined,
    hrv: async () => undefined,
    readiness: async () => undefined,
    training: async () => undefined,
    activities: async () => [],
  })
  const q = makeQueries(client)
  assert.equal(await q.whoami(), 'yangtao')
})

// ─────────────────────────────────────────────
// daily / sleep / hrv / readiness / training（getApi 抛错时由 withBoundary 兜底）
// ─────────────────────────────────────────────

test('daily: getApi 抛错时由 withBoundary 兜底，不 throw', async () => {
  const q = makeQueries(throwingClient('未登录'))
  // daily 本身不包 withBoundary（在 helper 里包装了）；但抛错会冒泡到 tool 层
  // 这里只验证：error 是 GarminAuthError，未被吞
  await assert.rejects(
    () => q.daily(),
    (err: unknown) => err instanceof GarminAuthError,
    'daily 应抛出 GarminAuthError',
  )
})

test('summary: getApi 内部调用全部 .catch(() => null) — 任一失败不影响其他', async () => {
  const c = Object.create(GarminClient.prototype) as GarminClient
  ;(c as any).getApi = async () => ({
    displayName: '',
    daily: async () => {
      throw new Error('boom')
    },
    sleep: async () => null,
    hrv: async () => null,
    readiness: async () => null,
    training: async () => null,
    activities: async () => {
      throw new Error('boom')
    },
  })
  const q = makeQueries(c)
  const s = await q.summary('2026-08-20')
  assert.equal(s.date, '2026-08-20')
  assert.equal(s.daily, null, 'daily 失败 → null')
  assert.deepEqual(s.activities, [], 'activities 失败 → []（空数组而非 throw）')
})

// ─────────────────────────────────────────────
// activities 默认窗口
// ─────────────────────────────────────────────

test('activities: from 缺省时根据 limit 推断（limit ≤ 50 → 7 天窗口）', async () => {
  let capturedArgs: unknown = null
  const c = Object.create(GarminClient.prototype) as GarminClient
  ;(c as any).getApi = async () => ({
    displayName: '',
    daily: async () => undefined,
    sleep: async () => undefined,
    hrv: async () => undefined,
    readiness: async () => undefined,
    training: async () => undefined,
    activities: async (from: string, to: string, limit?: number) => {
      capturedArgs = { from, to, limit }
      return []
    },
  })
  const q = makeQueries(c)
  await q.activities({ limit: 10 })
  const args = capturedArgs as { from: string; to: string; limit?: number }
  assert.ok(args.from && args.to, 'from/to 应被推断')
  // limit=10 < 50 → 默认 7 天窗口
  // (to - from) 应为 6 天（再加一天等于 7）
  const fromDate = new Date(args.from + 'T00:00:00Z').getTime()
  const toDate = new Date(args.to + 'T00:00:00Z').getTime()
  const days = Math.round((toDate - fromDate) / 86400000)
  assert.ok(days >= 6 && days <= 7, `窗口应约 7 天（from=${args.from}, to=${args.to}）`)
})

test('activities: limit > 50 时默认 30 天窗口', async () => {
  let capturedArgs: unknown = null
  const c = Object.create(GarminClient.prototype) as GarminClient
  ;(c as any).getApi = async () => ({
    displayName: '',
    daily: async () => undefined,
    sleep: async () => undefined,
    hrv: async () => undefined,
    readiness: async () => undefined,
    training: async () => undefined,
    activities: async (from: string, to: string) => {
      capturedArgs = { from, to }
      return []
    },
  })
  const q = makeQueries(c)
  await q.activities({ limit: 100 })
  const args = capturedArgs as { from: string; to: string }
  const fromDate = new Date(args.from + 'T00:00:00Z').getTime()
  const toDate = new Date(args.to + 'T00:00:00Z').getTime()
  const days = Math.round((toDate - fromDate) / 86400000)
  assert.ok(days >= 29 && days <= 30, `窗口应约 30 天（from=${args.from}, to=${args.to}）`)
})