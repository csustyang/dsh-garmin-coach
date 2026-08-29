/**
 * 权限检查回归测试（防止在 DSH 沙箱没 full access 时静默失败）
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GarminStoreFile } from '../../src/storage.js'

globalThis.test('storage: checkPermission 在可写目录 → 不抛错（缓存 OK）', async () => {
  const dir = join(tmpdir(), 'perm-test-' + Date.now() + '-' + Math.random())
  mkdirSync(dir, { recursive: true })  // 先创建
  const s = new GarminStoreFile({ dataDir: dir })
  await s.checkPermission() // 不抛错即过
  // 第二次用缓存
  await s.checkPermission()
  assert.ok(true)
})

globalThis.test('storage: checkPermission 抛出的友好错误信息有路径+修复建议', () => {
  const s = new GarminStoreFile({ dataDir: join(tmpdir(), 'perm-test') })
  const msg = (s as unknown as { permissionErrorMessage(): string }).permissionErrorMessage()
  assert.ok(msg.includes('full access'), `应包含 'full access'，实际: ${msg}`)
  assert.ok(msg.includes('garmin.json'), `应包含文件路径 garmin.json，实际: ${msg}`)
  assert.ok(msg.includes('开启') || msg.includes('修复'), `应包含修复建议，实际: ${msg}`)
})
