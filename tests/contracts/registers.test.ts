/**
 * 注册契约回归测试
 *
 * 防御今天这种 bug：commands.register 字段名漂移（invoke → handler）。
 * 策略：用 mock ctx 调 apply()，捕获每个 register() 调用的入参，断言其字段集 = 官方契约。
 *
 * 契约来源：
 *   - @deepseek-ai/dsh-tools#defineTool (name/description/parameters/output/execute)
 *   - @deepseek-ai/dsh-commands#register (name/description/input/recordInput/handler)
 *   - 0.1.7 SettingsForms: 入口导出 Config（volatile 字段）即 schema；写入走 ctx.settings.update/replace(ns=entry id)
 */
import assert from 'node:assert/strict'
import { apply, Config } from '../../src/index.js'
import { GARMIN_SETTINGS_NS } from '../../src/settings-web.js'

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
// ─────────────────────────────────────────────
// settings 契约（0.1.7 SettingsForms：schema = 入口导出的 Config，不再 register）
// ─────────────────────────────────────────────

test('settings: 入口导出 Config（SettingsForms 设置卡片的数据源）', () => {
  assert.ok(Config !== undefined, '入口必须导出 Config（0.1.7 SettingsForms 约定）')
  // schemastery 的 z.object() 本体是函数（构造器）；编译后可能是 object 包装
  assert.ok(
    typeof Config === 'function' || (typeof Config === 'object' && Config !== null),
    `Config 必须是 schemastery schema（function/object）: got ${typeof Config}`,
  )
})

test('settings: 命名空间常量 GARMIN_SETTINGS_NS === "garmin-coach"（= loader entry id）', () => {
  assert.equal(
    GARMIN_SETTINGS_NS,
    'garmin-coach',
    'settings 读写 ns 必须与 cordis.patch.yml 的 entry id 一致',
  )
})

test('settings: 0.1.7 下不再调用 settings.register（owner scope 已移除）', () => {
  assert.equal(
    captured.settings.length,
    0,
    `0.1.7 SettingsForms 设计下不应有 settings.register 调用（schema 就是导出的 Config；写入走 service.update/replace），got ${captured.settings.length}`,
  )
})