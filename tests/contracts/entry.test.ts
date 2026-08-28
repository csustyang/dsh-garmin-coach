/**
 * 入口加载测试
 *
 * 验证 lib/index.js（编译产物）能 require 成功、name/inject 导出正确、apply 能调。
 * 这是 DSH 启动插件时的实际路径。
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// npm test 必须从仓库根运行
const ROOT = resolve(process.cwd())
const libIndexUrl = pathToFileURL(resolve(ROOT, 'lib/index.js')).href

test('lib/index.js 可 require 不抛错', async () => {
  const mod = await import(libIndexUrl)
  assert.ok(mod, 'lib/index.js 必须能被加载')
})

test('lib/index.js 导出 name = "dsh-garmin-coach"', async () => {
  const mod = await import(libIndexUrl)
  assert.equal(
    mod.name,
    'dsh-garmin-coach',
    `name 必须是 'dsh-garmin-coach'（cordis 用它去重插件）: got ${mod.name}`,
  )
})

test('lib/index.js 导出 inject 数组含 credentials/tools/commands/agents/settings', async () => {
  const mod = await import(libIndexUrl)
  const inject = mod.inject as readonly string[]
  for (const required of ['credentials', 'tools', 'commands', 'agents', 'settings']) {
    assert.ok(
      inject.includes(required),
      `inject 必须声明 '${required}' 依赖：缺这个 apply() 会 crash。got [${inject.join(', ')}]`,
    )
  }
})

test('lib/index.js 导出 apply 函数', async () => {
  const mod = await import(libIndexUrl)
  assert.equal(
    typeof mod.apply,
    'function',
    `apply 必须是函数（cordis 通过它启动插件）`,
  )
})

test('lib/index.js 重新导出 GarminClient/FileTokenStore/makeQueries/defineGarminTools', async () => {
  const mod = await import(libIndexUrl)
  for (const name of ['GarminClient', 'FileTokenStore', 'makeQueries', 'defineGarminTools']) {
    assert.ok(
      typeof mod[name] === 'function' || mod[name] !== undefined,
      `重新导出 ${name} 必须存在（允许用户在 dsh-garmin-coach 之外直接引用）`,
    )
  }
})

test('lib/client.js 文件存在（DSH web UI bundle）', async () => {
  const { existsSync } = await import('node:fs')
  const exists = existsSync(resolve(ROOT, 'lib/client.js'))
  assert.ok(
    exists,
    `lib/client.js 必须存在（DSH web 加载它渲染侧栏入口；该文件是手写 IIFE，不是 tsc 生成）`,
  )
})