/**
 * 统计引擎离线测试（不连 Garmin API）。
 * 验证：落库、去重、运动筛选、best_pace、distance_stats、daily_stats。
 *
 * 跑法：npx tsx scripts/stats-test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GarminStoreFile } from '../src/storage.js'
import * as stats from '../src/stats.js'
import { toActivityRecord, toDailyRecord } from '../src/sync.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

async function main(): Promise<void> {
  console.log('=== 统计引擎测试 ===\n')

  // 临时数据目录
  const dir = await mkdtemp(join(tmpdir(), 'garmin-test-'))
  const store = new GarminStoreFile({ dataDir: dir })

  // 1. 落库测试（用 mock 的 Garmin 活动载荷）
  console.log('[1] 落库 + 去重')
  const mockActivity = (id: string, sport: string, km: number, paceSec: number, date: string) => ({
    activityId: id,
    activityName: `${sport} ${id}`,
    activityType: { typeKey: sport },
    startTimeLocal: `${date}T07:00:00`,
    distance: km * 1000,
    duration: km * 1000 * paceSec / 1000, // 简化
    averageSpeed: 1000 / paceSec,
    averageHR: 150,
    maxHR: 175,
    calories: 500,
    elevationGain: 100,
  })

  const a1 = toActivityRecord(mockActivity('act-1', 'running', 10, 240, '2026-08-20'))
  const a2 = toActivityRecord(mockActivity('act-2', 'running', 10, 255, '2026-08-18'))
  const a3 = toActivityRecord(mockActivity('act-3', 'cycling', 50, 90, '2026-08-15'))
  const a4 = toActivityRecord(mockActivity('act-4', 'hiking', 15, 360, '2026-08-10'))

  check('a1 转换成功', !!a1 && a1.distanceMeters === 10000)
  check('a1 配速 240s/km', !!a1 && a1.avgPaceSecPerKm === 240)

  const added1 = await store.upsertActivities([a1!, a2!, a3!, a4!])
  check('首次落库新增 4', added1 === 4)

  // 重复落库（去重）
  const added2 = await store.upsertActivities([a1!, a2!])
  check('重复落库新增 0', added2 === 0, `got ${added2}`)

  const data = await store.read()
  check('库内活动总数 4', Object.keys(data.activities).length === 4)

  // 2. 运动筛选
  console.log('\n[2] 运动筛选 + recent')
  const recent = await stats.recentActivities(store, { sport: 'running', limit: 2 })
  check('跑步最近 2 条', recent.length === 2 && recent[0]!.activityId === 'act-1')

  // 3. best_pace
  console.log('\n[3] best_pace（十公里最好成绩）')
  const best = await stats.bestPace(store, { distanceMeters: 10000, sport: 'running' })
  check('最好成绩是 act-1 (配速 240)', !!best && best.activityId === 'act-1')
  check('配速格式 4:00/km', stats.formatPace(240) === '4:00/km')

  // 4. distance_stats
  console.log('\n[4] distance_stats')
  const dist = await stats.distanceStats(store, { sport: 'running' })
  check('跑步 2 次', dist.count === 2)
  check('跑步总距离 20km', dist.totalKm === 20, `got ${dist.totalKm}`)
  check('最好配速 4:00/km', dist.bestPace === '4:00/km')

  // 5. sport_breakdown
  console.log('\n[5] sport_breakdown')
  const breakdown = await stats.sportBreakdown(store)
  check('3 种运动', breakdown.length === 3)
  check('running 排第一 (2次)', breakdown[0]!.sport === 'running' && breakdown[0]!.count === 2)

  // 6. daily
  console.log('\n[6] daily 落库 + 统计')
  const d1 = toDailyRecord('2026-08-20', {
    userSummary: { totalSteps: 12000, restingHeartRateInBeatsPerMinute: 55, averageStressLevel: 30 },
    dailySleepDTO: { sleepTimeSeconds: 28800, sleepScores: { overall: { value: 85 } } },
    hrv: { status: 'BALANCED', weeklyAverage: 65 },
    readiness: [{ score: 80 }],
  })
  const d2 = toDailyRecord('2026-08-19', {
    userSummary: { totalSteps: 8000, restingHeartRateInBeatsPerMinute: 57 },
  })
  await store.upsertDailies([d1, d2])
  const daily = await stats.dailyStats(store, { days: 7 })
  check('平均步数 10000', daily.avgSteps === 10000, `got ${daily.avgSteps}`)
  check('平均静息心率 56', daily.avgRestingHr === 56, `got ${daily.avgRestingHr}`)
  check('平均睡眠 8h', daily.avgSleepHours === 8, `got ${daily.avgSleepHours}`)
  check('HRV 状态 BALANCED', daily.lastHrvStatus === 'BALANCED')

  // 清理
  await rm(dir, { recursive: true, force: true })

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试崩溃:', e)
  process.exit(1)
})
