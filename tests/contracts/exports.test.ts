/**
 * 导出路径契约测试
 *
 * 验证 package.json#exports 里声明的每个子路径都能 import 成功。
 * 防御：拼写错误 / 文件缺失 / 路径前缀错误。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// npm test 必须从仓库根运行（cwd = 仓库根）
const ROOT = resolve(process.cwd())
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
}

// 简化类型：每个 exports 元素要么是字符串，要么含 default/types
type ExportTarget = string | { default?: string; types?: string }

test('exports: 至少有 "." 子路径', () => {
  assert.ok(pkg.exports['.'], `package.json#exports["."] 必须存在（DSH 插件加载入口）`)
})

test('exports: 声明的每个子路径对应的文件都存在', () => {
  const exports = pkg.exports as Record<string, string | { default?: string; types?: string }>
  for (const [subpath, target] of Object.entries(exports)) {
    const file = typeof target === 'string' ? target : (target.default ?? target.types)
    if (!file) continue
    // ./package.json 是虚拟导出（npm 强制）
    if (file === './package.json') {
      assert.ok(existsSync(resolve(ROOT, 'package.json')), `${subpath} → package.json 必须存在`)
      continue
    }
    const full = resolve(ROOT, file)
    assert.ok(
      existsSync(full),
      `${subpath} → ${file} 不存在。package.json#exports 声明了但文件缺失`,
    )
  }
})

test('exports: ./client 指向 lib/client.js（DSH web UI bundle）', () => {
  const clientExports = pkg.exports['./client'] as ExportTarget | undefined
  const file = typeof clientExports === 'string' ? clientExports : clientExports?.default
  assert.ok(file, `./client 必须声明文件路径`)
  assert.equal(
    file,
    './lib/client.js',
    `./client 必须指向 ./lib/client.js（手写 IIFE bundle，不能换）: got ${file}`,
  )
})

test('exports: ./cordis.patch.yml 指向根目录 yml', () => {
  const ymlExports = pkg.exports['./cordis.patch.yml'] as ExportTarget | undefined
  const file = typeof ymlExports === 'string' ? ymlExports : ymlExports?.default
  assert.ok(file, `./cordis.patch.yml 必须声明文件路径`)
  assert.equal(
    file,
    './cordis.patch.yml',
    `./cordis.patch.yml 必须指向根 yml: got ${file}`,
  )
})

test('exports: 主入口的 types 和 default 都必须指向 lib/', () => {
  const main = pkg.exports['.'] as { types?: string; default?: string }
  assert.ok(
    main.types?.startsWith('./lib/'),
    `主入口 types 应指向 ./lib/*.d.ts: got ${main.types}`,
  )
  assert.ok(
    main.default?.startsWith('./lib/'),
    `主入口 default 应指向 ./lib/*.js: got ${main.default}`,
  )
})