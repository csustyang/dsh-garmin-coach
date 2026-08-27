/**
 * Smoke test: 模拟 DSH ctx 调用 apply(ctx)，验证 9 个 tool + settings namespace 注册。
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

console.log('=== apply smoke 结果 ===')
for (const [ns, items] of Object.entries(registered)) {
  const filtered = items.filter(
    (i: unknown) => typeof i !== 'object' || !('replaced' in (i as object)),
  )
  console.log(`  ${ns}: ${filtered.length} 次`)
}

console.log('\n工具:')
const tools = registered.tools as Array<{ name: string; description: string }>
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description.slice(0, 50)}…`)
}

console.log('\nSettings namespace:')
const settings = registered.settings as Array<{ ns?: string }>
for (const s of settings.filter((s) => 'ns' in s)) {
  console.log(`  - ns="${s.ns}"`)
}
