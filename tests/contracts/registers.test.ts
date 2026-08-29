/**
 * 注册契约回归测试
 *
 * 防御今天这种 bug：commands.register 字段名漂移（invoke → handler）。
 * 策略：用 mock ctx 调 apply()，捕获每个 register() 调用的入参，断言其字段集 = 官方契约。
 *
 * 契约来源：
 *   - @deepseek-ai/dsh-tools#defineTool (name/description/parameters/output/execute)
 *   - @deepseek-ai/dsh-commands#register (name/description/input/recordInput/handler)
 *   - DSH ctx.settings.register (ns/schema/options)
 */
import assert from 'node:assert/strict'
import { apply } from '../../src/index.js'

interface SettingsCall {
  ns: unknown
  schema: unknown
  options?: unknown
}

const captured = {
  tools: [] as unknown[],
  commands: [] as unknown[],
  settings: [] as SettingsCall[],
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
      register: (item: unknown) => {
        captured.tools.push(item)
      },
    },
    commands: {
      register: (item: unknown) => {
        captured.commands.push(item)
      },
    },
    agents: { inject: () => Promise.resolve() },
    jobs: { register: () => undefined },
    schedule: { register: () => undefined },
    settings: {
      register: (ns: unknown, schema: unknown, options?: unknown) => {
        captured.settings.push({ ns, schema, options })
        return {
          get: () => undefined,
          watch: () => () => undefined,
          update: async () => undefined,
          replace: async () => undefined,
        }
      },
      describe: () => [],
    },
  } as unknown as Parameters<typeof apply>[0])
})

// ─────────────────────────────────────────────
// tools.register 契约
// ─────────────────────────────────────────────

test('tools.register: 每个工具都有 name/description/parameters/output/execute', () => {
  assert.ok(captured.tools.length > 0, 'apply() 必须注册至少 1 个 tool')
  for (const t of captured.tools as Array<Record<string, unknown>>) {
    for (const k of ['name', 'description', 'parameters', 'output', 'execute']) {
      assert.ok(k in t, `tool.${k} 必须存在: ${String(t['name'] ?? '<anonymous>')}`)
    }
    assert.equal(
      typeof t['execute'],
      'function',
      `tool.execute 必须是函数: ${String(t['name'])}`,
    )
    const output = t['output'] as { schema?: unknown } | undefined
    assert.ok(
      output?.schema,
      `tool.output.schema 必须存在 (定义见 src/tools/helpers.ts#defineGarminTool): ${String(t['name'])}`,
    )
  }
})

test('tools.register: 工具名以 garmin_ 开头（命名约定）', () => {
  for (const t of captured.tools as Array<{ name?: unknown }>) {
    assert.ok(
      typeof t.name === 'string' && t.name.startsWith('garmin_'),
      `tool.name 应以 garmin_ 开头: ${String(t.name)}`,
    )
  }
})

test('tools.register: 数量 ≥ 11（精简后 6 基础 + 5 统计）', () => {
  assert.ok(
    captured.tools.length >= 11,
    `工具数 ${captured.tools.length} < 11（README 约定）。改了 src/tools/*.ts 后请同步 README.md#AI-工具列表`,
  )
})

// ─────────────────────────────────────────────
// commands.register 契约（今天 bug 防御点）
// ─────────────────────────────────────────────

test('commands.register: 每个命令都有 name + handler（不能用旧字段）', () => {
  assert.ok(captured.commands.length > 0, 'commands.register 至少一次')
  for (const cmd of captured.commands as Array<Record<string, unknown>>) {
    assert.ok('name' in cmd, `commands item 必须有 name: ${JSON.stringify(cmd)}`)
    assert.ok(
      'handler' in cmd,
      `commands item 必须有 handler（旧 invoke 已废弃）: ${JSON.stringify(cmd)}`,
    )
    assert.equal(
      typeof cmd['handler'],
      'function',
      `commands.handler 必须是函数: ${String(cmd['name'])}`,
    )

    // 禁止旧字段（严格模式）
    assert.ok(
      !('invoke' in cmd),
      `❌ commands.item.invoke 已废弃 → 请改用 handler。参考 src/index.ts:240 tryRegisterCommands() 与 @deepseek-ai/dsh-commands 契约`,
    )
    assert.ok(
      !('id' in cmd),
      `❌ commands.item.id 已废弃 → 请改用 name。`,
    )
    assert.ok(
      !('title' in cmd),
      `❌ commands.item.title 已废弃 → 请改用 description。`,
    )
  }
})

test('commands.register: input.hint 必须存在（DSH 官方约定）', () => {
  for (const cmd of captured.commands as Array<{ name?: unknown; input?: { hint?: unknown } }>) {
    const hint = cmd.input?.hint
    assert.ok(
      typeof hint === 'string' && hint.length > 0,
      `commands.item.input.hint 必须是非空字符串（用户输入提示）: ${String(cmd.name)}`,
    )
  }
})

// ─────────────────────────────────────────────
// settings.register 契约
// ─────────────────────────────────────────────

test('settings.register: 命名空间必须是 "garmin-coach"', () => {
  const calls = captured.settings.filter((s) => typeof s.ns === 'string')
  assert.ok(calls.length > 0, 'settings.register 至少一次带 ns 参数')
  for (const s of calls) {
    assert.equal(
      s.ns,
      'garmin-coach',
      `settings namespace 必须是 'garmin-coach'（保持与其他代码位一致）: got ${String(s.ns)}`,
    )
  }
})

test('settings.register: schema 是 zod 对象（function / object 形式）', () => {
  const calls = captured.settings.filter((s) => typeof s.ns === 'string')
  assert.ok(calls.length > 0, '至少有 1 个带 ns 的 settings.register 调用')
  for (const s of calls) {
    // schemastery 的 z.object() 返回的是函数（构造器）；运行时会序列化
    // 既可能是 typeof 'function'（schemastery 本体）也可能是 typeof 'object'（编译后包装）
    assert.ok(
      typeof s.schema === 'function' || (typeof s.schema === 'object' && s.schema !== null),
      `settings schema 必须是 function/object: ns=${String(s.ns)}, got ${typeof s.schema}`,
    )
  }
})