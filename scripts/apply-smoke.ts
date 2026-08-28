/**
 * Smoke test: 模拟 DSH ctx 调用 apply(ctx)，验证 25 个 tool + settings namespace 注册。
 *
 * 用法：npx tsx scripts/apply-smoke.ts
 *
 * 退出码：0 = 通过；1 = 契约违例
 */
import { apply } from '../lib/index.js'

const registered: Record<string, unknown[]> = {
  tools: [],
  systemPrompt: [],
  commands: [],
  agents: [],
  jobs: [],
  schedule: [],
  credentials: [],
  settings: [],
}

const mockCtx = {
  entry: { id: 'garmin-coach' },
  credentials: {
    set: async (k: string, v: unknown) => {
      ;(registered.credentials as unknown[]).push({ k, v })
      return v
    },
    get: async <T>(_k: string): Promise<T | null> => null,
    delete: async (k: string) => {
      ;(registered.credentials as unknown[]).push({ deleted: k })
    },
  },
  tools: {
    register: (item: unknown) => {
      ;(registered.tools as unknown[]).push(item)
    },
  },
  systemPrompt: {
    register: (fragment: unknown) => {
      ;(registered.systemPrompt as unknown[]).push(fragment)
    },
  },
  commands: {
    register: (item: unknown) => {
      ;(registered.commands as unknown[]).push(item)
    },
  },
  agents: { inject: () => Promise.resolve() },
  jobs: { register: () => {} },
  schedule: { register: () => {} },
  settings: {
    register: (
      ns: string,
      schema: unknown,
      options?: { base?: unknown; applies?: string },
    ) => {
      ;(registered.settings as unknown[]).push({ ns, schema, options })
      return {
        get: () => undefined,
        watch: () => () => {},
        update: async (patch: unknown) => {
          ;(registered.settings as unknown[]).push({ updated: patch })
        },
        replace: async (section: unknown) => {
          ;(registered.settings as unknown[]).push({ replaced: section })
        },
      }
    },
    describe: () => [],
  },
}

apply(mockCtx as unknown as Parameters<typeof apply>[0])

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    console.error(`  ✗ ${msg}`)
    failures++
  }
}

console.log('=== apply smoke ===')

// 1. 工具数量（9 基础 + 16 统计 = 25）
const tools = registered.tools as Array<{ name?: string }>
check(tools.length === 25, `tools 注册数 = 25（实际 ${tools.length}）`)

// 2. commands 契约（防御今天这类 bug）
const commands = registered.commands as Array<Record<string, unknown>>
for (const cmd of commands) {
  const name = cmd['name']
  check('name' in cmd, `command "${name}" 有 name 字段`)
  check(
    'handler' in cmd,
    `command "${name}" 有 handler（旧 invoke 字段已废弃）`,
  )
  check(!('invoke' in cmd), `command "${name}" 不再使用旧 invoke 字段`)
  check(!('id' in cmd), `command "${name}" 不再使用旧 id 字段`)
}

// 3. settings namespace
const settings = registered.settings as Array<{ ns?: string }>
const nsCalls = settings.filter((s) => typeof s.ns === 'string')
check(nsCalls.length > 0, `settings.register 至少一次带 ns 参数`)
for (const s of nsCalls) {
  check(s.ns === 'garmin-coach', `settings namespace = 'garmin-coach'（got '${s.ns}'）`)
}

// 4. 工具命名约定
for (const t of tools) {
  if (t.name) {
    check(
      t.name.startsWith('garmin_'),
      `tool "${t.name}" 以 garmin_ 开头`,
    )
  }
}

console.log(`\n=== 结果: ${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`} ===`)
process.exit(failures === 0 ? 0 : 1)
