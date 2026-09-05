/**
 * sync.ts 转换函数单元测试
 *
 * toActivityRecord / toDailyRecord 是纯函数映射，把 Garmin API 原始载荷转成内部 record。
 * 重点：CN daily 字段在顶层（非 userSummary 嵌套）、HRV 嵌套、readiness 数组兼容。
 */
import assert from 'node:assert/strict'
import { toActivityRecord, toDailyRecord } from '../../src/sync.js'

// ─────────────────────────────────────────────
// toActivityRecord
// ─────────────────────────────────────────────

test('toActivityRecord: 缺失 activityId 返回 null', () => {
  assert.equal(toActivityRecord({}), null, '空对象应返回 null')
  assert.equal(toActivityRecord({ activityId: '' }), null, '空字符串应返回 null')
  // 注意：123 会被 String() 转成 "123"，不视为缺失 — 这是源码行为
  assert.ok(toActivityRecord({ activityId: 123 }), '数字 activityId 会被 String() 转字符串')
})

test('toActivityRecord: null / 非对象返回 null', () => {
  assert.equal(toActivityRecord(null), null, 'null 应返回 null')
  assert.equal(toActivityRecord(undefined), null, 'undefined 应返回 null')
  assert.equal(toActivityRecord('string'), null, '字符串应返回 null')
  assert.equal(toActivityRecord(123), null, '数字应返回 null')
})

test('toActivityRecord: 标准 Garmin 载荷', () => {
  const raw = {
    activityId: '12345',
    activityName: 'Morning Run',
    activityType: { typeKey: 'running' },
    startTimeLocal: '2026-08-20T07:00:00',
    distance: 10000,
    duration: 2400,
    averageSpeed: 1000 / 240,
    averageHR: 150,
    maxHR: 175,
    calories: 500,
    elevationGain: 100,
    averageRunningCadenceInStepsPerMinute: 180,
    trainingEffect: 3.2,
  }
  const r = toActivityRecord(raw)
  assert.ok(r, '应成功转换')
  assert.equal(r.activityId, '12345')
  assert.equal(r.sport, 'running', '优先取 activityType.typeKey')
  assert.equal(r.distanceMeters, 10000)
  assert.equal(r.durationSec, 2400)
  assert.equal(r.avgPaceSecPerKm, 240, '1000m / (1000/240 m/s) = 240 s/km')
  assert.equal(r.avgHr, 150)
  assert.equal(r.maxHr, 175)
  assert.equal(r.avgCadence, 180)
  assert.equal(r.trainingEffect, 3.2)
})

test('toActivityRecord: distance 字段名兼容（distance / distanceMeters）', () => {
  const r1 = toActivityRecord({ activityId: '1', distance: 5000 })
  const r2 = toActivityRecord({ activityId: '1', distanceMeters: 5000 })
  assert.equal(r1?.distanceMeters, 5000, 'distance 字段')
  assert.equal(r2?.distanceMeters, 5000, 'distanceMeters 字段（兼容）')
})

test('toActivityRecord: sport fallback（无 activityType 时取 sport 字段）', () => {
  const r = toActivityRecord({ activityId: '1', sport: 'cycling' })
  assert.equal(r?.sport, 'cycling', '无 activityType.typeKey 时用 sport 字段')
})

test('toActivityRecord: 平均速度缺失时 avgPaceSecPerKm 为 undefined', () => {
  const r = toActivityRecord({ activityId: '1', distance: 5000, duration: 1500 })
  assert.equal(
    r?.avgPaceSecPerKm,
    undefined,
    '无 averageSpeed 时不应算配速（避免假装计算）',
  )
})

// ─────────────────────────────────────────────
// toDailyRecord（CN 顶层字段）
// ─────────────────────────────────────────────

test('toDailyRecord: CN 顶层字段映射', () => {
  const r = toDailyRecord('2026-08-20', {
    totalSteps: 12000,
    totalDistanceMeters: 8500,
    activeKilocalories: 500,
    restingHeartRate: 55,
    bodyBatteryMostRecentValue: 80,
    averageStressLevel: 30,
    maxStressLevel: 60,
    highlyActiveSeconds: 600,
    activeSeconds: 1800,
    sedentarySeconds: 28800,
    minHeartRate: 50,
    maxHeartRate: 130,
    minAvgHeartRate: 75,
    floorsAscendedInMeters: 50,
  })
  assert.equal(r.steps, 12000)
  assert.equal(r.distanceMeters, 8500)
  assert.equal(r.activeKilocalories, 500)
  assert.equal(r.restingHeartRate, 55)
  assert.equal(r.bodyBattery, 80)
  assert.equal(r.stressAvg, 30)
  // avgHeartRate 已移除（Garmin 没全天平均，minAvgHeartRate 是错的）
  assert.equal(r.floorsAscendedMeters, 50)
})

test('toDailyRecord: 睡眠从 dailySleepDTO 嵌套取', () => {
  const r = toDailyRecord('2026-08-20', {
    dailySleepDTO: {
      sleepTimeSeconds: 28800,
      sleepScores: { overall: { value: 85 } },
    },
  })
  assert.equal(r.sleepSeconds, 28800, '8h 睡眠 = 28800s')
  assert.equal(r.sleepScore, 85)
})

// HRV/readiness 字段已停用（用户决定不存这些数据）—— 相关测试删除
// test('toDailyRecord: HRV 嵌套取 weeklyAverage', () => { ... })
// test('toDailyRecord: readiness 兼容数组和单对象', () => { ... })

test('toDailyRecord: 空对象也合法（缺字段为 undefined）', () => {
  const r = toDailyRecord('2026-08-20', {})
  assert.equal(r.date, '2026-08-20')
  assert.equal(r.steps, undefined)
  assert.equal(r.sleepSeconds, undefined)
  // 不能因为缺字段抛错
})