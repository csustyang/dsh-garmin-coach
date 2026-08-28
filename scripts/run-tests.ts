/**
 * 简易测试 runner
 *
 * 设计原则：
 *   - 不依赖 node:test（dsh sandbox 拦截其 spawn）
 *   - 测试文件用全局 this.test() / this.before() 注册
 *   - runner 收集 → 顺序执行 → 输出
 *
 * 测试文件写法：
 *   import assert from 'node:assert/strict'
 *
 *   globalThis.test('用例名', () => {
 *     assert.equal(...)
 *   })
 *
 *   globalThis.test('async 用例', async () => {
 *     const r = await ...
 *     assert.ok(r)
 *   })
 *
 * 用法：
 *   npx tsx scripts/run-tests.ts          # 跑全部
 *   npx tsx scripts/run-tests.ts contracts # 只跑 contracts/
 *   npx tsx scripts/run-tests.ts unit      # 只跑 unit/
 */

import { readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

// import.meta.dirname 在 .ts 源里是 scripts/，但编译后会变成 lib-tests/scripts/
// 都用 ../ 就够了
const ROOT = resolve(import.meta.dirname, '..')
const TESTS_DIR = join(ROOT, 'tests')

interface TestEntry {
  file: string
  name: string
  fn: () => void | Promise<void>
}

// ──────────────────────────────────────────────
// 注册 API
// ──────────────────────────────────────────────

const tests: TestEntry[] = []
let globalBefore: (() => void | Promise<void>) | undefined
const globalAfters: Array<() => void | Promise<void>> = []

declare global {
  // eslint-disable-next-line no-var
  var test: (name: string, fn: () => void | Promise<void>) => void
  // eslint-disable-next-line no-var
  var before: (fn: () => void | Promise<void>) => void
  // eslint-disable-next-line no-var
  var after: (fn: () => void | Promise<void>) => void
}

// 声明（每个文件 import 前会被覆盖）
globalThis.test = function (name, fn) {
  tests.push({ file: '<init>', name, fn })
}
globalThis.before = (fn) => {
  globalBefore = fn
}
globalThis.after = (fn) => {
  globalAfters.push(fn)
}

// ──────────────────────────────────────────────
// 加载所有 .test.ts
// ──────────────────────────────────────────────

function findTestFiles(dir: string): string[] {
  const out: string[] = []
  function walk(d: string): void {
    let entries: ReturnType<typeof readdirSync> | { name: string; isDirectory: () => boolean }[]
    try {
      entries = readdirSync(d, { withFileTypes: true }) as any
    } catch {
      return
    }
    for (const entry of entries as Array<{ name: string; isDirectory?: () => boolean }>) {
      const full = join(d, entry.name)
      const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
      if (isDir) {
        walk(full)
      } else if (entry.name.endsWith('.test.js')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

const mode = process.argv[2]
const filterDir =
  mode === 'contracts'
    ? join(TESTS_DIR, 'contracts')
    : mode === 'unit'
      ? join(TESTS_DIR, 'unit')
      : TESTS_DIR

const files = findTestFiles(filterDir).sort()

console.log(`\n加载 ${files.length} 个测试文件...\n`)

// 按文件记录 tests + before（每个文件各自一份）
interface FileSuite {
  file: string
  tests: TestEntry[]
  before?: () => void | Promise<void>
  after?: () => void | Promise<void>
}
const fileSuites: FileSuite[] = []

for (const f of files) {
  // 重置每文件的局部状态
  const localTests: TestEntry[] = []
  let localBefore: (() => void | Promise<void>) | undefined
  let localAfter: (() => void | Promise<void>) | undefined
  const fileName = basename(f)

  globalThis.test = function (name, fn) {
    localTests.push({ file: fileName, name, fn })
  }
  globalThis.before = (fn) => {
    localBefore = fn
  }
  globalThis.after = (fn) => {
    localAfter = fn
  }

  // 每个文件 import 一次 → 触发 globalThis.test/before/after 注册
  await import(pathToFileURL(f).href)

  fileSuites.push({
    file: fileName,
    tests: localTests,
    before: localBefore,
    after: localAfter,
  })
}

// ──────────────────────────────────────────────
// 运行
// ──────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: Array<{ file: string; test: string; err: Error }> = []

async function runOne(entry: TestEntry) {
  try {
    await entry.fn()
    console.log(`  ✓ ${entry.name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${entry.name}`)
    failed++
    failures.push({ file: entry.file, test: entry.name, err: err as Error })
  }
}

console.log('=== 跑测试 ===\n')

// 按文件分组跑：每个文件先 before()，再跑测试，再 after()
for (const suite of fileSuites) {
  if (suite.tests.length === 0) continue
  console.log(`\n── ${suite.file} ──`)
  if (suite.before) {
    try {
      await suite.before()
    } catch (err) {
      console.error(`  ✗ before() 抛错: ${err instanceof Error ? err.message : err}`)
      failed++
      continue
    }
  }
  for (const t of suite.tests) {
    await runOne(t)
  }
  if (suite.after) {
    try {
      await suite.after()
    } catch (err) {
      console.error(`  ✗ after() 抛错: ${err instanceof Error ? err.message : err}`)
      failed++
    }
  }
}

// ──────────────────────────────────────────────
// 结果
// ──────────────────────────────────────────────

console.log(`\n=== ${passed} 通过, ${failed} 失败 ===\n`)

if (failures.length > 0) {
  console.error('失败明细:')
  for (const f of failures) {
    console.error(`\n  ${f.file}: ${f.test}`)
    console.error(`    ${f.err.message ?? f.err}`)
    if (f.err.stack) {
      const stack = f.err.stack.split('\n').slice(1, 4).join('\n')
      console.error(`    ${stack}`)
    }
  }
  process.exit(1)
}

process.exit(0)