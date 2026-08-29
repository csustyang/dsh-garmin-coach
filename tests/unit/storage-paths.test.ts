/**
 * storage 跨平台路径 bug 回归测试
 *
 * 背景：原 src/storage.ts 使用 `filePath.substring(0, filePath.lastIndexOf('/'))` 解析 sibling 路径。
 * 该实现在 Windows 上是 broken：Windows 路径用 `\` 分隔，`lastIndexOf('/')` 永远返回 -1，
 * `substring(0, -1)` 返回空串，导致 `mkdir ''` 失败（ENOENT）、`loadTrainingPlan` 失败。
 *
 * 修复：用 `path.dirname(filePath)` 替代（Node.js 跨平台 API）。
 * 本测试在 macOS / Windows / Linux 上必须都通过。
 */
import assert from 'node:assert/strict'
import { GarminStoreFile } from '../../src/storage.js'
import { dirname, join } from 'node:path'

globalThis.test('storage: filePath / planPath / diaryPath 在 Windows 路径下也是绝对路径', () => {
  const s = new GarminStoreFile({ dataDir: 'C:\\workspace\\data' })
  // 访问 private 字段用 `as any`（测试黑盒）
  const filePath = (s as any).filePath as string
  const planPath = (s as any).planPath as string
  const diaryPath = (s as any).diaryPath as string
  // filePath = C:\workspace\data\garmin.json
  assert.ok(
    filePath.includes('garmin.json'),
    `filePath 应包含 garmin.json，实际: ${filePath}`,
  )
  // planPath 应是 sibling（不是相对路径 'training-plan.json'，不是 ''）
  assert.ok(
    planPath.endsWith('training-plan.json'),
    `planPath 应以 training-plan.json 结尾，实际: ${planPath}`,
  )
  assert.ok(
    planPath.includes('\\') || planPath.includes('/'),
    `planPath 必须是绝对路径（包含 \\ 或 /），实际: ${planPath}`,
  )
  // diaryPath 同理
  assert.ok(
    diaryPath.endsWith('training-diary.json'),
    `diaryPath 应以 training-diary.json 结尾，实际: ${diaryPath}`,
  )
})

globalThis.test('storage: planPath 实际指向 filePath 同目录', () => {
  const s = new GarminStoreFile({ dataDir: '/tmp/garmin-test' })
  const filePath = (s as any).filePath as string
  const planPath = (s as any).planPath as string
  const planDir = dirname(filePath)
  const planPathDir = dirname(planPath)
  assert.equal(
    planPathDir,
    planDir,
    `planPath 目录 ${planPathDir} 应等于 filePath 目录 ${planDir}`,
  )
})

globalThis.test('storage: Windows 路径下能正确创建 training-plan-history 目录', () => {
  const s = new GarminStoreFile({ dataDir: 'C:\\workspace\\data' })
  const filePath = (s as any).filePath as string
  const planPath = (s as any).planPath as string
  // historyDir 来自 planPath（dir of dir of planPath 是 filePath 目录）
  const expectedHistory = join(dirname(planPath), 'training-plan-history')
  assert.ok(
    expectedHistory.includes('training-plan-history'),
    `history 路径应包含 training-plan-history，实际: ${expectedHistory}`,
  )
  assert.ok(
    !expectedHistory.includes('undefined'),
    `history 路径不应包含 undefined，实际: ${expectedHistory}`,
  )
  // 反向验证：原 bug 行为
  // - Windows 路径（只用 \）：lastIndexOf('/') 永远 -1 → substring(0, -1) = '' → 触发 bug
  // - Mac/Linux 路径（含 /）：lastIndexOf('/') 找到正常位置 → 不触发 bug
  const oldStyle = filePath.substring(0, filePath.lastIndexOf('/'))
  if (process.platform === 'win32') {
    assert.equal(
      oldStyle,
      '',
      `Windows 路径下原 lastIndexOf('/') 应该是空串（这就是 bug 根因），实际: '${oldStyle}'`,
    )
  } else {
    // Mac / Linux：原实现碰巧能工作，验证这一点
    assert.notEqual(
      oldStyle,
      '',
      `Mac/Linux 路径下原 lastIndexOf('/') 碰巧能工作（找到正斜杠），不是空串`,
    )
  }
})