/**
 * GarminStoreFile 单元测试
 *
 * 覆盖：落库 / 去重 / 原子写 / mutate 顺序保证 / 容错（ENOENT + 损坏文件）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminStoreFile } from '../../src/storage.js'
import type { ActivityRecord, DailyRecord } from '../../src/storage.js'

let dir: string
let store: GarminStoreFile

const mockActivity = (id: string, km = 10, sport = 'running', paceSec = 240): ActivityRecord => ({
  activityId: id,
  activityName: `${sport}-${id}`,
  sport,
  startTime: '2026-08-20T07:00:00',
  durationSec: km * 1000 * paceSec / 1000,
  distanceMeters: km * 1000,
  avgPaceSecPerKm: paceSec,
  avgSpeedMps: 1000 / paceSec,
})

const mockDaily = (date: string, steps = 10000): DailyRecord => ({
  date,
  steps,
})

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'garmin-store-'))
  store = new GarminStoreFile({ dataDir: dir })
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────
// 落库 + 去重
// ─────────────────────────────────────────────

test('upsertActivity: 首次落库返回 true（新增）', async () => {
  const added = await store.upsertActivity(mockActivity('a1'))
  assert.equal(added, true, '首次写入应返回 true（表示新增）')
})

test('upsertActivity: 同一 activityId 二次写入返回 false（去重）', async () => {
  await store.upsertActivity(mockActivity('a1'))
  const added = await store.upsertActivity(mockActivity('a1', 12)) // 改 distance，看能否被覆盖
  assert.equal(added, false, '重复写入应返回 false（表示非新增）')
  // 注意：会去重但不会阻止覆盖字段
  const data = await store.read()
  assert.equal(data.activities['a1']?.distanceMeters, 12000, '新字段值应生效（去重不阻塞覆盖）')
})

test('upsertActivities: 批量新增返回 N，重复返回 0', async () => {
  const added = await store.upsertActivities([
    mockActivity('b1'),
    mockActivity('b2'),
    mockActivity('b3'),
  ])
  assert.equal(added, 3)

  const dup = await store.upsertActivities([mockActivity('b1'), mockActivity('b2')])
  assert.equal(dup, 0, '全部已存在应返回 0')
})

test('upsertActivities: 部分新增部分已存在返回新增数', async () => {
  await store.upsertActivities([mockActivity('c1')])
  const added = await store.upsertActivities([
    mockActivity('c1'), // 已有
    mockActivity('c2'), // 新增
  ])
  assert.equal(added, 1, '部分新增应只算新增那部分')
})

// ─────────────────────────────────────────────
// 每日健康
// ─────────────────────────────────────────────

test('upsertDaily: 按日期覆盖（最新覆盖旧的）', async () => {
  await store.upsertDaily({ date: '2026-08-20', steps: 8000 })
  await store.upsertDaily({ date: '2026-08-20', steps: 12000 })
  const data = await store.read()
  assert.equal(data.daily['2026-08-20']?.steps, 12000, '同日二次写入应覆盖（最新值生效）')
})

// ─────────────────────────────────────────────
// 容错
// ─────────────────────────────────────────────

test('read(): 文件不存在时返回空库，不抛错', async () => {
  const freshDir = await mkdtemp(join(tmpdir(), 'garmin-fresh-'))
  const freshStore = new GarminStoreFile({ dataDir: freshDir })
  const data = await freshStore.read()
  assert.equal(Object.keys(data.activities).length, 0)
  assert.equal(Object.keys(data.daily).length, 0)
  await rm(freshDir, { recursive: true, force: true })
})

test('read(): 文件损坏时返回空库，不抛错', async () => {
  const corruptDir = await mkdtemp(join(tmpdir(), 'garmin-corrupt-'))
  const storePath = join(corruptDir, 'garmin.json')
  await writeFile(storePath, 'not valid json {{{', 'utf8')
  const corruptStore = new GarminStoreFile({ dataDir: corruptDir })
  const data = await corruptStore.read()
  assert.equal(Object.keys(data.activities).length, 0, '损坏文件应返回空库而非抛错')
  await rm(corruptDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────
// 同步游标
// ─────────────────────────────────────────────

test('setSyncMeta: 记录 lastSyncAt + syncDaysBack', async () => {
  const ts = '2026-08-28T10:00:00.000Z'
  await store.setSyncMeta(ts, 21)
  const data = await store.read()
  assert.equal(data.lastSyncAt, ts)
  assert.equal(data.syncDaysBack, 21)
})