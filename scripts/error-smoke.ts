/**
 * 故意制造错误，验证三层防御能挡住所有异常。
 *
 * 测试场景：
 *   1. ctx.tools.register 抛错（模拟 DSH 内部错乱）
 *   2. ctx.settings.register 抛错
 *   3. ctx.commands.register 抛错
 *   4. ctx.credentials.get 抛错
 *   5. 顶层某处抛错（最外层 try-catch 兜底）
 *
 * 每个测试 apply() 都不应 throw，全部异常被吞并 logger.error。
 */
import { apply } from '../lib/index.js'

function makeMockCtx(opts: {
  toolsThrow?: boolean
  settingsThrow?: boolean
  commandsThrow?: boolean
  credentialsThrow?: boolean
}) {
  return {
    entry: { id: 'garmin-coach' },
    credentials: opts.credentialsThrow
      ? {
          set: async () => {
            throw new Error('credentials.set fail')
          },
          get: async () => {
            throw new Error('credentials.get fail')
          },
          delete: async () => {
            throw new Error('credentials.delete fail')
          },
        }
      : {
          set: async () => {},
          get: async () => null,
          delete: async () => {},
        },
    tools: opts.toolsThrow
      ? {
          register: () => {
            throw new Error('ctx.tools.register fail')
          },
        }
      : { register: () => {} },
    systemPrompt: { register: () => {} },
    commands: opts.commandsThrow
      ? {
          register: () => {
            throw new Error('ctx.commands.register fail')
          },
        }
      : { register: () => {} },
    agents: { inject: async () => {} },
    jobs: { register: () => {} },
    schedule: { register: () => {} },
    settings: opts.settingsThrow
      ? {
          register: () => {
            throw new Error('ctx.settings.register fail')
          },
          describe: () => [],
        }
      : {
          register: () => ({
            get: () => undefined,
            watch: () => () => {},
            update: async () => {},
            replace: async () => {},
          }),
          describe: () => [],
        },
  }
}

const scenarios = [
  { name: '正常情况', opts: {} },
  { name: 'ctx.tools.register 抛错', opts: { toolsThrow: true } },
  { name: 'ctx.settings.register 抛错', opts: { settingsThrow: true } },
  { name: 'ctx.commands.register 抛错', opts: { commandsThrow: true } },
  { name: 'ctx.credentials 全部抛错', opts: { credentialsThrow: true } },
  { name: 'tools + settings + commands 同时抛错', opts: { toolsThrow: true, settingsThrow: true, commandsThrow: true } },
]

let allPass = true
for (const s of scenarios) {
  console.log(`\n── 场景：${s.name} ──`)
  try {
    apply(makeMockCtx(s.opts) as unknown as Parameters<typeof apply>[0])
    console.log('  ✓ apply() 没抛错')
  } catch (e) {
    console.error(`  ✗ apply() 抛错到 DSH: ${e instanceof Error ? e.message : String(e)}`)
    allPass = false
  }
}

console.log(
  allPass
    ? '\n✅ 全部场景通过：apply() 永远不抛错到 DSH'
    : '\n❌ 有场景失败：apply() 抛错到 DSH（违反铁律）',
)
process.exit(allPass ? 0 : 1)
