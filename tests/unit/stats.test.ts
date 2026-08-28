/**
 * stats.ts 计算正确性测试
 *
 * 覆盖 bestPace / distanceStats / dailyStats / sportBreakdown / formatPace / formatDuration 的边界 case。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GarminStoreFile } from '../../src/storage.js'
import type { ActivityRecord, DailyRecord } from '../../src/storage.js'
import {
  bestPace,
  distanceStats,
  dailyStats,
  sportBreakdown,
  formatPace,
  formatDuration,
  recentActivities,
} from '../../src/stats.js'

let dir: string
let store: GarminStoreFile

const A = (
  id: string,
  sport: string,
  km: number,
  paceSec: number,
  date: string,
  extras: Partial<ActivityRecord> = {},
): ActivityRecord => ({
  activityId: id,
  activityName: `${sport}-${id}`,
  sport,
  startTime: `${date}T07:00:00`,
  durationSec: km * 1000 * paceSec / 1000,
  distanceMeters: km * 1000,
  avgPaceSecPerKm: paceSec,
  avgSpeedMps: 1000 / paceSec,
  ...extras,
})

const D = (date: string, partial: Partial<DailyRecord> = {}): DailyRecord => ({
  date,
  ...partial,
})

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'garmin-stats-'))
  store = new GarminStoreFile({ dataDir: dir })
  // 注入 6 条活动 + 5 天 daily
  await store.upsertActivities([
    A('1', 'running', 10, 240, '2026-08-20'),    // 4:00/km
    A('2', 'running', 10, 270, '2026-08-18'),    // 4:30/km  最慢10k
    A('3', 'running', 5, 300, '2026-08-15'),     // 5:00/km
    A('4', 'cycling', 50, 90, '2026-08-10'),     // 1:30/km 骑行车速
    A('5', 'hiking', 15, 360, '2026-08-05'),
    A('6', 'running', 21.1, 255, '2026-07-30'),  // 4:15/km 半马
  ])
  await store.upsertDailies([
    D('2026-08-20', { steps: 12000, restingHeartRate: 55, sleepSeconds: 28800, sleepScore: 85 }),
    D('2026-08-19', { steps: 8000, restingHeartRate: 57, sleepSeconds: 25200 }),
    D('2026-08-18', { steps: 15000, restingHeartRate: 56 }),
    D('2026-08-17', { steps: 10000 }),
    D('2026-08-16', { steps: 11000 }),
  ])
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────
// formatPace / formatDuration
// ─────────────────────────────────────────────

test('formatPace: 标准配速', () => {
  assert.equal(formatPace(240), '4:00/km')
  assert.equal(formatPace(255), '4:15/km')
  assert.equal(formatPace(360), '6:00/km')
})

test('formatPace: 无效值返回破折号', () => {
  assert.equal(formatPace(undefined), '—')
  assert.equal(formatPace(0), '—')
  assert.equal(formatPace(-1), '—')
})

test('formatDuration: 秒级（round 后仍 < 1 分钟）', () => {
  // 注意：formatDuration 对 45s 会 round 到 1m（向上取整），源码行为如此
  // 测试 < 30s 的情况才能拿到 'Ns' 形式
  assert.equal(formatDuration(10), '10s', '< 30s → 秒（round(10/60)=0）')
})

test('formatDuration: 分钟级', () => {
  assert.equal(formatDuration(24 * 60), '24m', '< 1 小时 → 分钟')
})

test('formatDuration: 小时+分钟', () => {
  assert.equal(formatDuration(96 * 60), '1h36m', '> 1 小时 → h+m')
  assert.equal(formatDuration(60 * 60), '1h', '整小时不显示 0m')
})

// ─────────────────────────────────────────────
// bestPace
// ─────────────────────────────────────────────

test('bestPace: 10km 跑步最好成绩是 act-1 (4:00/km)', async () => {
  const best = await bestPace(store, { distanceMeters: 10000, sport: 'running' })
  assert.ok(best)
  assert.equal(best.activityId, '1')
})

test('bestPace: 半马最好成绩是 act-6 (4:15/km)', async () => {
  const best = await bestPace(store, { distanceMeters: 21097, sport: 'running' })
  assert.ok(best)
  assert.equal(best.activityId, '6')
})

test('bestPace: 没找到返回 null（不抛错）', async () => {
  const best = await bestPace(store, { distanceMeters: 42195, sport: 'running' })
  assert.equal(best, null, '没全马数据应返回 null')
})

test('bestPace: 不同运动类型不混算', async () => {
  // 10km 骑行 (act-4) 比 10km 跑步慢 → best 仍是跑步
  const best = await bestPace(store, { distanceMeters: 10000 })
  assert.equal(best?.sport, 'running', '不指定 sport 时按默认 running')
})

// ─────────────────────────────────────────────
// distanceStats
// ─────────────────────────────────────────────

test('distanceStats: 跑步总距离 46.1km（10+10+5+21.1）', async () => {
  const s = await distanceStats(store, { sport: 'running' })
  assert.equal(s.count, 4)
  assert.equal(s.totalKm, 46.1)
})

test('distanceStats: 全部运动 = 4+1+1 = 6 条', async () => {
  const s = await distanceStats(store, {})
  assert.equal(s.count, 6)
})

// ─────────────────────────────────────────────
// dailyStats
// ─────────────────────────────────────────────

test('dailyStats: 5 天平均步数 = (12000+8000+15000+10000+11000)/5', async () => {
  const s = await dailyStats(store, { days: 7 })
  assert.equal(s.avgSteps, (12000 + 8000 + 15000 + 10000 + 11000) / 5)
})

test('dailyStats: 平均静息心率（仅算有的）', async () => {
  const s = await dailyStats(store, { days: 7 })
  // 只有前3 天有 restingHeartRate：55/57/56
  assert.equal(s.avgRestingHr, (55 + 57 + 56) / 3)
})

test('dailyStats: 睡眠秒数 → 小时', async () => {
  const s = await dailyStats(store, { days: 7 })
  // 只有2 天有 sleepSeconds：28800/25200 → 7.5h
  assert.equal(s.avgSleepHours, ((28800 + 25200) / 2 / 3600))
})

// ─────────────────────────────────────────────
// sportBreakdown
// ─────────────────────────────────────────────

test('sportBreakdown: 跑步 4 次排第一', async () => {
  const b = await sportBreakdown(store, 90)
  assert.ok(b.length >= 3)
  assert.equal(b[0]?.sport, 'running')
  assert.equal(b[0]?.count, 4)
})

// ─────────────────────────────────────────────
// recentActivities
// ─────────────────────────────────────────────

test('recentActivities: 按日期降序', async () => {
  const r = await recentActivities(store, { limit: 3 })
  assert.equal(r.length, 3)
  assert.equal(r[0]?.activityId, '1', '最新日期 act-1 (8-20)')
})

test('recentActivities: 运动类型筛选', async () => {
  const r = await recentActivities(store, { sport: 'cycling', limit: 10 })
  assert.equal(r.length, 1)
  assert.equal(r[0]?.sport, 'cycling')
})