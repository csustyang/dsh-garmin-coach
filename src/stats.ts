/**
 * Garmin 统计查询引擎 —— JS 计算层，AI 调工具拿精炼结果。
 *
 * 为什么不用"AI 全量读 JSON"：
 *  - 数据量大时全量塞 context 会爆、费 token、AI 算不准
 *  - JS 做 filter/sort/aggregate 更快更准
 *
 * 为什么不用 Python 脚本：
 *  - 每次启动进程慢，DSH 插件是 Node/TS，同进程 JS 最快
 *
 * 后期升级 PostgreSQL：替换 storage.ts 的数据源，本引擎接口不变。
 */

import type { ActivityRecord, GarminStoreFile } from './storage.js'

/** 配速格式化：秒/km → "4:15/km" */
export function formatPace(secPerKm: number | undefined): string {
  if (secPerKm === undefined || secPerKm <= 0) return '—'
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s).padStart(2, '0')}/km`
}

/**
 * 格式化时长（秒 → 可读）：
 *  - 不足 1 小时 → 分钟（如 24m，四舍五入）
 *  - 超过 1 小时 → 小时+分钟（如 96 分钟 → 1h36m）
 *  - 不足 1 分钟 → 秒（如 45s）
 */
export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || sec === null || isNaN(sec) || sec <= 0) return '—'
  const totalMin = Math.round(sec / 60)
  if (totalMin < 1) return Math.round(sec) + 's'
  if (totalMin < 60) return totalMin + 'm'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h + 'h' + (m > 0 ? m + 'm' : '')
}

/** 活动列表（按 startTime 降序）*/
async function sortedActivities(store: GarminStoreFile): Promise<ActivityRecord[]> {
  const data = await store.read()
  return Object.values(data.activities).sort((a, b) =>
    b.startTime.localeCompare(a.startTime),
  )
}

/** 按运动类型过滤 */
function filterBySport(
  activities: ActivityRecord[],
  sport?: string,
  sports?: string[],
): ActivityRecord[] {
  if (sport) return activities.filter((a) => a.sport === sport)
  if (sports && sports.length > 0) {
    return activities.filter((a) => sports.includes(a.sport))
  }
  return activities
}

/** 按距离范围过滤（米）*/
function filterByDistance(
  activities: ActivityRecord[],
  minMeters?: number,
  maxMeters?: number,
): ActivityRecord[] {
  return activities.filter((a) => {
    if (minMeters !== undefined && (a.distanceMeters ?? 0) < minMeters) return false
    if (maxMeters !== undefined && (a.distanceMeters ?? 0) > maxMeters) return false
    return true
  })
}

// ─────────────────────────────────────────────────────────────
//  统计查询
// ─────────────────────────────────────────────────────────────

export interface RecentActivitiesArgs {
  sport?: string
  limit?: number
  days?: number
}

/** 最近 N 次活动 */
export async function recentActivities(
  store: GarminStoreFile,
  args: RecentActivitiesArgs,
): Promise<ActivityRecord[]> {
  const activities = await sortedActivities(store)
  const sportFiltered = filterBySport(activities, args.sport)
  const limit = args.limit ?? 10
  let result = sportFiltered.slice(0, limit)
  if (args.days) {
    const cutoff = Date.now() - args.days * 24 * 3600 * 1000
    result = result.filter(
      (a) => new Date(a.startTime).getTime() >= cutoff,
    )
  }
  return result
}

export interface BestPaceArgs {
  /** 目标距离（米）*/
  distanceMeters: number
  /** 距离容差（米），默认 ±10% */
  toleranceMeters?: number
  sport?: string
}

/** 某距离的最佳配速成绩 */
export async function bestPace(
  store: GarminStoreFile,
  args: BestPaceArgs,
): Promise<ActivityRecord | null> {
  const activities = await sortedActivities(store)
  const tol = args.toleranceMeters ?? Math.round(args.distanceMeters * 0.1)
  const matches = filterBySport(activities, args.sport).filter((a) => {
    const d = a.distanceMeters ?? 0
    return Math.abs(d - args.distanceMeters) <= tol
  })
  // 配速越小越好
  matches.sort((a, b) => (a.avgPaceSecPerKm ?? Infinity) - (b.avgPaceSecPerKm ?? Infinity))
  return matches[0] ?? null
}

export interface DistanceStatsArgs {
  days?: number
  sport?: string
}

/** 距离统计（总距离、次数、平均配速）*/
export async function distanceStats(
  store: GarminStoreFile,
  args: DistanceStatsArgs,
): Promise<{
  count: number
  totalKm: number
  avgKm: number
  avgPace: string
  bestPace: string
  firstDate: string
  lastDate: string
}> {
  const activities = await sortedActivities(store)
  const filtered = filterBySport(activities, args.sport)
  let window = filtered
  if (args.days) {
    const cutoff = Date.now() - args.days * 24 * 3600 * 1000
    window = filtered.filter((a) => new Date(a.startTime).getTime() >= cutoff)
  }
  if (window.length === 0) {
    return { count: 0, totalKm: 0, avgKm: 0, avgPace: '—', bestPace: '—', firstDate: '', lastDate: '' }
  }
  const totalKm = window.reduce((s, a) => s + (a.distanceMeters ?? 0), 0) / 1000
  const paces = window
    .map((a) => a.avgPaceSecPerKm)
    .filter((p): p is number => p !== undefined && p > 0)
  const bestP = paces.length ? Math.min(...paces) : undefined
  const avgP = paces.length ? paces.reduce((s, p) => s + p, 0) / paces.length : undefined
  return {
    count: window.length,
    totalKm: Math.round(totalKm * 10) / 10,
    avgKm: Math.round((totalKm / window.length) * 10) / 10,
    avgPace: formatPace(avgP),
    bestPace: formatPace(bestP),
    firstDate: window[window.length - 1]?.startTime?.slice(0, 10) ?? '',
    lastDate: window[0]?.startTime?.slice(0, 10) ?? '',
  }
}

export interface DailyStatsArgs {
  days?: number
}

/** 每日健康统计（平均步数/静息心率/睡眠/HRV）*/
export async function dailyStats(
  store: GarminStoreFile,
  args: DailyStatsArgs,
): Promise<{
  days: number
  avgSteps: number
  avgRestingHr: number
  avgSleepHours: number
  avgStress: number
  avgHrv: number
  lastHrvStatus: string
}> {
  const data = await store.read()
  let dailies = Object.values(data.daily).sort((a, b) =>
    b.date.localeCompare(a.date),
  )
  if (args.days) {
    dailies = dailies.slice(0, args.days)
  }
  if (dailies.length === 0) {
    return { days: 0, avgSteps: 0, avgRestingHr: 0, avgSleepHours: 0, avgStress: 0, avgHrv: 0, lastHrvStatus: '' }
  }
  const avg = (arr: (number | undefined)[]) => {
    const nums = arr.filter((x): x is number => x !== undefined)
    return nums.length ? Math.round((nums.reduce((s, x) => s + x, 0) / nums.length) * 10) / 10 : 0
  }
  return {
    days: dailies.length,
    avgSteps: avg(dailies.map((d) => d.steps)),
    avgRestingHr: avg(dailies.map((d) => d.restingHeartRate)),
    avgSleepHours: Math.round((avg(dailies.map((d) => d.sleepSeconds)) / 3600) * 10) / 10,
    avgStress: avg(dailies.map((d) => d.stressAvg)),
    avgHrv: avg(dailies.map((d) => d.hrvWeeklyAvg)),
    lastHrvStatus: dailies[0]?.hrvStatus ?? '',
  }
}

/** 运动类型分布 */
export async function sportBreakdown(
  store: GarminStoreFile,
  days?: number,
): Promise<Array<{ sport: string; count: number; totalKm: number }>> {
  const activities = await sortedActivities(store)
  let window = activities
  if (days) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    window = activities.filter((a) => new Date(a.startTime).getTime() >= cutoff)
  }
  const bySport = new Map<string, { count: number; totalKm: number }>()
  for (const a of window) {
    const sport = a.sport || 'unknown'
    const cur = bySport.get(sport) ?? { count: 0, totalKm: 0 }
    cur.count++
    cur.totalKm += (a.distanceMeters ?? 0) / 1000
    bySport.set(sport, cur)
  }
  return [...bySport.entries()]
    .map(([sport, v]) => ({
      sport,
      count: v.count,
      totalKm: Math.round(v.totalKm * 10) / 10,
    }))
    .sort((a, b) => b.count - a.count)
}

/**
 * 看板聚合数据：总览 + 趋势 + 成绩 + 健康。
 * 供 /garmin-dashboard-data 端点返回，前端 React 看板渲染。
 */
export async function dashboardSummary(
  store: GarminStoreFile,
): Promise<{
  overview: {
    totalActivities: number
    totalKm: number
    totalRuns: number
    totalTimeSec: number
    avgPace: string
    bestPace: string
    longestKm: number
    lastSyncAt: string
  }
  recent: ActivityRecord[]
  weekly: Array<{ week: string; km: number; runs: number }>
  bestPaces: Record<string, ActivityRecord | null>
  health: {
    days: number
    avgSteps: number
    avgRestingHr: number
    avgSleepHours: number
    avgHrv: number
  }
  sportBreakdown: Array<{ sport: string; count: number; totalKm: number }>
  dailyRecent: Array<{
    date: string; steps?: number; restingHeartRate?: number
    stressAvg?: number; bodyBattery?: number; totalDistanceMeters?: number; activeKilocalories?: number
  }>
  // 全部运动分析
  paceByDistance: Array<{ label: string; distanceMeters: number; bestPaceSecPerKm: number | null; bestDate: string | null; avgPaceSecPerKm: number | null; count: number }>
  paceDistribution: Array<{ range: string; count: number; avgHr: number | null }>
  hrPaceRelationship: Array<{ paceRange: string; avgHr: number | null; count: number }>
  trainingLoad: { totalLoad: number; weeklyLoad: Array<{ week: string; load: number; durationMin: number }>; avgWeeklyLoad: number }
  distanceDistribution: Array<{ range: string; count: number; totalKm: number }>
  weekOverWeek: { thisWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }; lastWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }; kmChange: number; runsChange: number }
  cadence: { avgCadence: number | null; byPace: Array<{ paceRange: string; avgCadence: number; count: number }>; distribution: Array<{ range: string; count: number }>; trend: Array<{ month: string; avgCadence: number }> }
  elevation: { totalElevation: number; byElevation: Array<{ range: string; count: number; km: number; avgPace: number | null }>; paceImpact: { flatPace: number | null; hillyPace: number | null; impact: string } }
  calories: { totalCalories: number; avgCalPerKm: number | null; trend: Array<{ month: string; calPerKm: number | null }> }
  consistency: { weeklyFrequency: Array<{ week: string; runs: number }>; longestStreak: number; timeOfDay: Array<{ period: string; count: number }>; weekdayDistribution: Array<{ day: string; count: number }> }
  hrZoneBreakdown: {
    totals: { zone1: number; zone2: number; zone3: number; zone4: number; zone5: number }
    totalSec: number
    details: Array<{
      activityId: string
      activityName: string
      startTime: string
      sport: string
      totalSec: number
      zones: { zone1: number; zone2: number; zone3: number; zone4: number; zone5: number }
    }>
  }
  trainingPlan: {
    goal: string
    plan: string
    tasks: Array<{ id: string; week: number; day: string; type: string; detail: string; done: boolean }>
    tips: string[]
    progress: { done: number; total: number }
  } | null
  diary: Array<{
    id: string
    date: string
    taskId?: string
    taskLabel?: string
    feeling: string
    rating?: number
    createdAt: string
  }>
}> {
  const data = await store.read()
  const activities = Object.values(data.activities).sort((a, b) =>
    b.startTime.localeCompare(a.startTime),
  )
  const runs = activities.filter((a) => a.sport === 'running')

  // 总览
  const totalKm = activities.reduce((s, a) => s + (a.distanceMeters ?? 0), 0) / 1000
  const totalTimeSec = activities.reduce((s, a) => s + (a.durationSec ?? 0), 0)
  const paces = runs
    .map((a) => a.avgPaceSecPerKm)
    .filter((p): p is number => p !== undefined && p > 0)
  const bestP = paces.length ? Math.min(...paces) : undefined
  const avgP = paces.length ? paces.reduce((s, p) => s + p, 0) / paces.length : undefined
  const longest = runs.length
    ? Math.max(...runs.map((a) => (a.distanceMeters ?? 0) / 1000))
    : 0

  // 最近 7 天（本周）
  const weekStart = Date.now() - 7 * 24 * 3600 * 1000
  const recent = activities.slice(0, 10)
  const weekly = [
    {
      week: '本周',
      km: Math.round(
        (activities.filter((a) => new Date(a.startTime).getTime() >= weekStart)
          .reduce((s, a) => s + (a.distanceMeters ?? 0), 0) / 1000) * 10,
      ) / 10,
      runs: activities.filter(
        (a) =>
          a.sport === 'running' &&
          new Date(a.startTime).getTime() >= weekStart,
      ).length,
    },
  ]

  // 各距离 PB
  const bestPaces: Record<string, ActivityRecord | null> = {
    '5k': await bestPace(store, { distanceMeters: 5000, sport: 'running' }),
    '10k': await bestPace(store, { distanceMeters: 10000, sport: 'running' }),
    half: await bestPace(store, { distanceMeters: 21097, sport: 'running' }),
  }

  // 健康
  const health = await dailyStats(store, { days: 7 })
  const breakdown = await sportBreakdown(store)

  // 最近 30 天每日数据（用于趋势展示）
  const data30 = await store.read()
  const dailyRecent: Array<{
    date: string; steps?: number; restingHeartRate?: number
    stressAvg?: number; bodyBattery?: number; totalDistanceMeters?: number; activeKilocalories?: number
  }> = []
  const today30 = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today30.getTime() - i * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const dd = data30.daily[d]
    if (dd && (dd.steps || dd.restingHeartRate || dd.stressAvg || dd.bodyBattery)) {
      dailyRecent.push({
        date: d,
        steps: dd.steps,
        restingHeartRate: dd.restingHeartRate,
        stressAvg: dd.stressAvg,
        bodyBattery: dd.bodyBattery,
        totalDistanceMeters: dd.distanceMeters,
        activeKilocalories: dd.activeKilocalories,
      })
    }
  }

  // 全部运动分析
  const fullStats = await fullDashboardStats(store)
  // 心率区间时长（按真实 hrTimeInZone_1~5）
  const hrBreakdown = await hrZoneBreakdown(store)

  // 训练计划（供看板展示 + 打卡）
  const trainingPlan = await store.loadTrainingPlan()
  const planProgress = await store.planProgress()
  const diary = await store.loadDiary()

  return {
    overview: {
      totalActivities: activities.length,
      totalKm: Math.round(totalKm * 10) / 10,
      totalRuns: runs.length,
      totalTimeSec,
      avgPace: formatPace(avgP),
      bestPace: formatPace(bestP),
      longestKm: Math.round(longest * 10) / 10,
      lastSyncAt: data.lastSyncAt ?? '',
    },
    recent,
    weekly,
    bestPaces,
    dailyRecent,
    health,
    sportBreakdown: breakdown,
    paceByDistance: fullStats.paceByDistance,
    paceDistribution: fullStats.paceDistribution,
    hrPaceRelationship: fullStats.hrPaceRelationship,
    trainingLoad: fullStats.trainingLoad,
    distanceDistribution: fullStats.distanceDistribution,
    weekOverWeek: fullStats.weekOverWeek,
    cadence: fullStats.cadence,
    elevation: fullStats.elevation,
    calories: fullStats.calories,
    consistency: fullStats.consistency,
    hrZoneBreakdown: hrBreakdown,
    trainingPlan: trainingPlan ? {
      goal: trainingPlan.goal,
      plan: trainingPlan.plan,
      tasks: trainingPlan.tasks || [],
      tips: trainingPlan.tips || [],
      progress: planProgress,
    } : null,
    diary: diary,
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  全部运动分析（基于已有活动数据）
// ═══════════════════════════════════════════════════════════════════════

/** 距离分段配速（1k/3k/5k/10k/15k/半马/全马）*/
export async function paceByDistance(store: GarminStoreFile): Promise<Array<{
  label: string
  distanceMeters: number
  bestPaceSecPerKm: number | null
  bestDate: string | null
  avgPaceSecPerKm: number | null
  count: number
}>> {
  const data = await store.read()
  const acts = Object.values(data.activities)
  const segments: Array<{ label: string; distanceMeters: number; tolerance: number }> = [
    { label: '1 公里', distanceMeters: 1000, tolerance: 200 },
    { label: '3 公里', distanceMeters: 3000, tolerance: 300 },
    { label: '5 公里', distanceMeters: 5000, tolerance: 500 },
    { label: '10 公里', distanceMeters: 10000, tolerance: 1000 },
    { label: '15 公里', distanceMeters: 15000, tolerance: 1500 },
    { label: '半马', distanceMeters: 21097, tolerance: 1500 },
    { label: '全马', distanceMeters: 42195, tolerance: 1500 },
  ]
  return segments.map(function (seg) {
    const matches = acts.filter(function (a) {
      const d = a.distanceMeters ?? 0
      return Math.abs(d - seg.distanceMeters) <= seg.tolerance
    })
    const paces = matches.map(function (a) { return a.avgPaceSecPerKm }).filter(function (p) { return p && p > 0 }) as number[]
    if (paces.length === 0) {
      return { label: seg.label, distanceMeters: seg.distanceMeters, bestPaceSecPerKm: null, bestDate: null, avgPaceSecPerKm: null, count: 0 }
    }
    const bestPace = Math.min.apply(null, paces)
    const avgPace = paces.reduce(function (s, p) { return s + p }, 0) / paces.length
    const bestAct = matches.find(function (a) { return a.avgPaceSecPerKm === bestPace })
    return {
      label: seg.label,
      distanceMeters: seg.distanceMeters,
      bestPaceSecPerKm: bestPace,
      bestDate: bestAct ? (bestAct.startTime || '').slice(0, 10) : null,
      avgPaceSecPerKm: Math.round(avgPace),
      count: matches.length,
    }
  })
}

/** 配速分布（按时间区间统计次数）*/
export async function paceDistribution(store: GarminStoreFile): Promise<Array<{
  range: string
  count: number
  avgHr: number | null
}>> {
  const data = await store.read()
  const runs = Object.values(data.activities).filter(function (a) {
    return a.sport === 'running' && a.avgPaceSecPerKm && a.avgPaceSecPerKm > 0
  })
  const buckets = [
    { range: '< 4:30', min: 0, max: 270 },
    { range: '4:30 - 5:00', min: 270, max: 300 },
    { range: '5:00 - 5:30', min: 300, max: 330 },
    { range: '5:30 - 6:00', min: 330, max: 360 },
    { range: '6:00 - 6:30', min: 360, max: 390 },
    { range: '6:30 - 7:00', min: 390, max: 420 },
    { range: '> 7:00', min: 420, max: 99999 },
  ]
  return buckets.map(function (b) {
    const matches = runs.filter(function (a) { return a.avgPaceSecPerKm! >= b.min && a.avgPaceSecPerKm! < b.max })
    const hrs = matches.map(function (a) { return a.avgHr }).filter(function (h) { return h !== undefined }) as number[]
    return {
      range: b.range,
      count: matches.length,
      avgHr: hrs.length ? Math.round(hrs.reduce(function (s, x) { return s + x }, 0) / hrs.length) : null,
    }
  })
}

/** 心率-配速关系（相同配速区间的平均心率，反映有氧效率）*/
export async function hrPaceRelationship(store: GarminStoreFile): Promise<Array<{
  paceRange: string
  avgHr: number | null
  count: number
}>> {
  const data = await store.read()
  const runs = Object.values(data.activities).filter(function (a) {
    return a.sport === 'running' && a.avgPaceSecPerKm && a.avgPaceSecPerKm > 0 && a.avgHr
  })
  const buckets = [
    { paceRange: '< 5:00', min: 0, max: 300 },
    { paceRange: '5:00 - 5:30', min: 300, max: 330 },
    { paceRange: '5:30 - 6:00', min: 330, max: 360 },
    { paceRange: '6:00 - 6:30', min: 360, max: 390 },
    { paceRange: '6:30 - 7:00', min: 390, max: 420 },
    { paceRange: '> 7:00', min: 420, max: 99999 },
  ]
  return buckets.map(function (b) {
    const matches = runs.filter(function (a) { return a.avgPaceSecPerKm! >= b.min && a.avgPaceSecPerKm! < b.max })
    const hrs = matches.map(function (a) { return a.avgHr! })
    return {
      paceRange: b.paceRange,
      avgHr: hrs.length ? Math.round(hrs.reduce(function (s, x) { return s + x }, 0) / hrs.length) : null,
      count: matches.length,
    }
  })
}

/** TRIMP 训练负荷（基于心率的训练负荷）*/
export async function trainingLoad(store: GarminStoreFile): Promise<{
  totalLoad: number
  weeklyLoad: Array<{ week: string; load: number; durationMin: number }>
  avgWeeklyLoad: number
}> {
  const data = await store.read()
  const acts = Object.values(data.activities).filter(function (a) { return a.avgHr && a.durationSec })
  // 简化 TRIMP：duration_min × (HR/HRmax - 0.5) × 0.86，假设 HRmax = 190
  const HR_MAX = 190
  const items = acts.map(function (a) {
    const minutes = (a.durationSec ?? 0) / 60
    const intensity = ((a.avgHr ?? 0) / HR_MAX) - 0.5
    return { startTime: a.startTime, load: minutes * intensity * 0.86 }
  })
  const totalLoad = Math.round(items.reduce(function (s, i) { return s + i.load }, 0))
  // 按周聚合
  const byWeek: Record<string, { load: number; durationMin: number }> = {}
  items.forEach(function (i) {
    const d = new Date(i.startTime || '')
    const monday = new Date(d)
    monday.setDate(d.getDate() - d.getDay() + 1)
    const wk = monday.toISOString().slice(0, 10)
    if (!byWeek[wk]) byWeek[wk] = { load: 0, durationMin: 0 }
    byWeek[wk]!.load += i.load
  })
  acts.forEach(function (a) {
    const d = new Date(a.startTime || '')
    const monday = new Date(d)
    monday.setDate(d.getDate() - d.getDay() + 1)
    const wk = monday.toISOString().slice(0, 10)
    if (byWeek[wk]) byWeek[wk]!.durationMin += (a.durationSec ?? 0) / 60
  })
  const weeklyLoad = Object.entries(byWeek).sort().map(function (e) {
    return { week: e[0], load: Math.round(e[1].load), durationMin: Math.round(e[1].durationMin) }
  })
  return {
    totalLoad,
    weeklyLoad,
    avgWeeklyLoad: weeklyLoad.length ? Math.round(totalLoad / weeklyLoad.length) : 0,
  }
}

/** 距离分布（按距离区间统计次数）*/
export async function distanceDistribution(store: GarminStoreFile): Promise<Array<{
  range: string
  count: number
  totalKm: number
}>> {
  const data = await store.read()
  const acts = Object.values(data.activities).filter(function (a) { return a.distanceMeters && a.distanceMeters > 0 })
  const buckets = [
    { range: '< 3km', min: 0, max: 3000 },
    { range: '3-5km', min: 3000, max: 5000 },
    { range: '5-10km', min: 5000, max: 10000 },
    { range: '10-15km', min: 10000, max: 15000 },
    { range: '15-21km', min: 15000, max: 21000 },
    { range: '21-42km', min: 21000, max: 42000 },
    { range: '> 42km', min: 42000, max: 999999 },
  ]
  return buckets.map(function (b) {
    const matches = acts.filter(function (a) { return a.distanceMeters! >= b.min && a.distanceMeters! < b.max })
    return {
      range: b.range,
      count: matches.length,
      totalKm: Math.round(matches.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 100) / 10,
    }
  })
}

/** 周环比（本周 vs 上周）*/
export async function weekOverWeek(store: GarminStoreFile): Promise<{
  thisWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }
  lastWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }
  kmChange: number
  runsChange: number
}> {
  const data = await store.read()
  const now = new Date()
  const thisMon = new Date(now); thisMon.setDate(now.getDate() - now.getDay() + 1)
  const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7)
  const preLastMon = new Date(lastMon); preLastMon.setDate(lastMon.getDate() - 7)
  const acts = Object.values(data.activities)
  function slice(from: Date, to: Date) {
    return acts.filter(function (a) {
      const d = new Date(a.startTime || '')
      return d >= from && d < to
    })
  }
  function stats(arr: typeof acts) {
    if (arr.length === 0) return { km: 0, runs: 0, avgPace: null, avgHr: null, load: 0 }
    const km = arr.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000
    const runs = arr
    const paces = arr.map(function (a) { return a.avgPaceSecPerKm }).filter(function (p) { return p && p > 0 }) as number[]
    const hrs = arr.map(function (a) { return a.avgHr }).filter(function (h) { return h }) as number[]
    const load = arr.reduce(function (s, a) {
      const min = (a.durationSec || 0) / 60
      const i = ((a.avgHr || 0) / 190) - 0.5
      return s + min * i * 0.86
    }, 0)
    return {
      km: Math.round(km * 10) / 10,
      runs: runs.length,
      avgPace: paces.length ? Math.round(paces.reduce(function (s, p) { return s + p }, 0) / paces.length) : null,
      avgHr: hrs.length ? Math.round(hrs.reduce(function (s, h) { return s + h }, 0) / hrs.length) : null,
      load: Math.round(load),
    }
  }
  const thisWeek = stats(slice(thisMon, now))
  const lastWeek = stats(slice(lastMon, thisMon))
  return {
    thisWeek,
    lastWeek,
    kmChange: lastWeek.km > 0 ? Math.round((thisWeek.km - lastWeek.km) / lastWeek.km * 100) : 0,
    runsChange: lastWeek.runs > 0 ? thisWeek.runs - lastWeek.runs : 0,
  }
}

/** 步频分析（平均 + 步频-配速关系 + 分布）*/
export async function cadenceAnalysis(store: GarminStoreFile): Promise<{
  avgCadence: number | null
  byPace: Array<{ paceRange: string; avgCadence: number; count: number }>
  distribution: Array<{ range: string; count: number }>
  trend: Array<{ month: string; avgCadence: number }>
}> {
  const data = await store.read()
  const runs = Object.values(data.activities).filter(function (a) { return a.avgCadence && a.sport === 'running' })
  if (runs.length === 0) {
    return { avgCadence: null, byPace: [], distribution: [], trend: [] }
  }
  const cads = runs.map(function (a) { return a.avgCadence! })
  const avgCadence = Math.round(cads.reduce(function (s, x) { return s + x }, 0) / cads.length)

  // 步频-配速
  const paceBuckets = [
    { paceRange: '< 5:00', min: 0, max: 300 },
    { paceRange: '5:00-5:30', min: 300, max: 330 },
    { paceRange: '5:30-6:00', min: 330, max: 360 },
    { paceRange: '6:00-6:30', min: 360, max: 390 },
    { paceRange: '> 6:30', min: 390, max: 99999 },
  ]
  const byPace = paceBuckets.map(function (b) {
    const m = runs.filter(function (a) { return a.avgPaceSecPerKm! >= b.min && a.avgPaceSecPerKm! < b.max })
    const c = m.map(function (a) { return a.avgCadence! })
    return { paceRange: b.paceRange, avgCadence: c.length ? Math.round(c.reduce(function (s, x) { return s + x }, 0) / c.length) : 0, count: m.length }
  })

  // 步频分布
  const distBuckets = [
    { range: '< 170', min: 0, max: 170 },
    { range: '170-180', min: 170, max: 180 },
    { range: '180-190', min: 180, max: 190 },
    { range: '190+', min: 190, max: 99999 },
  ]
  const distribution = distBuckets.map(function (b) {
    return { range: b.range, count: runs.filter(function (a) { return a.avgCadence! >= b.min && a.avgCadence! < b.max }).length }
  })

  // 月趋势
  const byMonth: Record<string, { sum: number; n: number }> = {}
  runs.forEach(function (a) {
    const m = (a.startTime || '').slice(0, 7)
    if (m) {
      if (!byMonth[m]) byMonth[m] = { sum: 0, n: 0 }
      byMonth[m]!.sum += a.avgCadence!
      byMonth[m]!.n++
    }
  })
  const trend = Object.entries(byMonth).sort().map(function (e) {
    return { month: e[0], avgCadence: Math.round(e[1].sum / e[1].n) }
  })

  return { avgCadence, byPace, distribution, trend }
}

/** 爬升分析（爬升-配速影响 + 爬升分布）*/
export async function elevationAnalysis(store: GarminStoreFile): Promise<{
  totalElevation: number
  byElevation: Array<{ range: string; count: number; km: number; avgPace: number | null }>
  paceImpact: { flatPace: number | null; hillyPace: number | null; impact: string }
}> {
  const data = await store.read()
  const acts = Object.values(data.activities).filter(function (a) { return a.elevationGainMeters !== undefined && a.distanceMeters })
  const totalElevation = Math.round(acts.reduce(function (s, a) { return s + (a.elevationGainMeters || 0) }, 0))
  // 爬升分布
  const buckets = [
    { range: '< 50m', min: 0, max: 50 },
    { range: '50-150m', min: 50, max: 150 },
    { range: '150-300m', min: 150, max: 300 },
    { range: '300-500m', min: 300, max: 500 },
    { range: '> 500m', min: 500, max: 99999 },
  ]
  const byElevation = buckets.map(function (b) {
    const m = acts.filter(function (a) { return (a.elevationGainMeters || 0) >= b.min && (a.elevationGainMeters || 0) < b.max && a.avgPaceSecPerKm })
    const paces = m.map(function (a) { return a.avgPaceSecPerKm! })
    return {
      range: b.range,
      count: m.length,
      km: Math.round(m.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 100) / 10,
      avgPace: paces.length ? Math.round(paces.reduce(function (s, p) { return s + p }, 0) / paces.length) : null,
    }
  })
  // 爬升 vs 平地对配速影响
  const flat = acts.filter(function (a) { return (a.elevationGainMeters || 0) < 50 && a.distanceMeters! > 3000 && a.avgPaceSecPerKm })
  const hilly = acts.filter(function (a) { return (a.elevationGainMeters || 0) >= 100 && a.distanceMeters! > 3000 && a.avgPaceSecPerKm })
  const flatPace = flat.length ? Math.round(flat.map(function (a) { return a.avgPaceSecPerKm! }).reduce(function (s, p) { return s + p }, 0) / flat.length) : null
  const hillyPace = hilly.length ? Math.round(hilly.map(function (a) { return a.avgPaceSecPerKm! }).reduce(function (s, p) { return s + p }, 0) / hilly.length) : null
  let impact = '样本不足'
  if (flatPace !== null && hillyPace !== null) {
    const diff = ((hillyPace - flatPace) / flatPace * 100).toFixed(1)
    impact = '爬升使配速慢 ' + diff + '%（平地' + flatPace + 's/km vs 爬升' + hillyPace + 's/km）'
  }
  return { totalElevation, byElevation, paceImpact: { flatPace, hillyPace, impact } }
}

/** 卡路里效率（每公里卡路里 + 月趋势）*/
export async function calorieEfficiency(store: GarminStoreFile): Promise<{
  totalCalories: number
  avgCalPerKm: number | null
  trend: Array<{ month: string; calPerKm: number | null }>
}> {
  const data = await store.read()
  const acts = Object.values(data.activities).filter(function (a) { return a.calories && a.distanceMeters && a.distanceMeters > 0 })
  const totalCalories = acts.reduce(function (s, a) { return s + (a.calories || 0) }, 0)
  const totalKm = acts.reduce(function (s, a) { return s + (a.distanceMeters || 0) / 1000 }, 0)
  const avgCalPerKm = totalKm > 0 ? Math.round(totalCalories / totalKm) : null
  const byMonth: Record<string, { cal: number; km: number }> = {}
  acts.forEach(function (a) {
    const m = (a.startTime || '').slice(0, 7)
    if (m) {
      if (!byMonth[m]) byMonth[m] = { cal: 0, km: 0 }
      byMonth[m]!.cal += a.calories || 0
      byMonth[m]!.km += (a.distanceMeters || 0) / 1000
    }
  })
  const trend = Object.entries(byMonth).sort().map(function (e) {
    return { month: e[0], calPerKm: e[1].km > 0 ? Math.round(e[1].cal / e[1].km) : null }
  })
  return { totalCalories, avgCalPerKm, trend }
}

/** 训练频率与一致性（周次数、连续训练日、时间分布）*/
export async function trainingConsistency(store: GarminStoreFile): Promise<{
  weeklyFrequency: Array<{ week: string; runs: number }>
  longestStreak: number
  timeOfDay: Array<{ period: string; count: number }>
  weekdayDistribution: Array<{ day: string; count: number }>
}> {
  const data = await store.read()
  const acts = Object.values(data.activities).slice().sort(function (a, b) {
    return (a.startTime || '').localeCompare(b.startTime || '')
  })
  // 周次数
  const byWeek: Record<string, number> = {}
  acts.forEach(function (a) {
    const d = new Date(a.startTime || '')
    const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1)
    const wk = mon.toISOString().slice(0, 10)
    byWeek[wk] = (byWeek[wk] || 0) + 1
  })
  const weeklyFrequency = Object.entries(byWeek).sort().map(function (e) {
    return { week: e[0], runs: e[1] }
  })
  // 连续训练日
  let longestStreak = 0, cur = 0, prevDate: string | null = null
  acts.forEach(function (a) {
    const d = (a.startTime || '').slice(0, 10)
    if (prevDate === null) { cur = 1 }
    else {
      const diff = (new Date(d).getTime() - new Date(prevDate).getTime()) / 86400000
      cur = diff <= 1.5 ? cur + 1 : 1
    }
    if (cur > longestStreak) longestStreak = cur
    prevDate = d
  })
  // 时段
  const periods = { '清晨 (5-9)': 0, '上午 (9-12)': 0, '中午 (12-14)': 0, '下午 (14-18)': 0, '晚上 (18-22)': 0, '深夜 (22-5)': 0 }
  acts.forEach(function (a) {
    const h = new Date(a.startTime || '').getHours()
    if (h >= 5 && h < 9) periods['清晨 (5-9)']++
    else if (h >= 9 && h < 12) periods['上午 (9-12)']++
    else if (h >= 12 && h < 14) periods['中午 (12-14)']++
    else if (h >= 14 && h < 18) periods['下午 (14-18)']++
    else if (h >= 18 && h < 22) periods['晚上 (18-22)']++
    else periods['深夜 (22-5)']++
  })
  const timeOfDay = Object.entries(periods).map(function (e) { return { period: e[0], count: e[1] } })
  // 星期
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekdayCount = [0, 0, 0, 0, 0, 0, 0]
  acts.forEach(function (a) {
    weekdayCount[new Date(a.startTime || '').getDay()]++
  })
  const weekdayDistribution = weekdays.map(function (d, i) { return { day: d, count: weekdayCount[i]! } })
  return { weeklyFrequency, longestStreak, timeOfDay, weekdayDistribution }
}

/** 大看板聚合（包含所有分析）*/
export async function fullDashboardStats(store: GarminStoreFile): Promise<{
  paceByDistance: Array<{ label: string; distanceMeters: number; bestPaceSecPerKm: number | null; bestDate: string | null; avgPaceSecPerKm: number | null; count: number }>
  paceDistribution: Array<{ range: string; count: number; avgHr: number | null }>
  hrPaceRelationship: Array<{ paceRange: string; avgHr: number | null; count: number }>
  trainingLoad: { totalLoad: number; weeklyLoad: Array<{ week: string; load: number; durationMin: number }>; avgWeeklyLoad: number }
  distanceDistribution: Array<{ range: string; count: number; totalKm: number }>
  weekOverWeek: { thisWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }; lastWeek: { km: number; runs: number; avgPace: number | null; avgHr: number | null; load: number }; kmChange: number; runsChange: number }
  cadence: { avgCadence: number | null; byPace: Array<{ paceRange: string; avgCadence: number; count: number }>; distribution: Array<{ range: string; count: number }>; trend: Array<{ month: string; avgCadence: number }> }
  elevation: { totalElevation: number; byElevation: Array<{ range: string; count: number; km: number; avgPace: number | null }>; paceImpact: { flatPace: number | null; hillyPace: number | null; impact: string } }
  calories: { totalCalories: number; avgCalPerKm: number | null; trend: Array<{ month: string; calPerKm: number | null }> }
  consistency: { weeklyFrequency: Array<{ week: string; runs: number }>; longestStreak: number; timeOfDay: Array<{ period: string; count: number }>; weekdayDistribution: Array<{ day: string; count: number }> }
}> {
  const [
    paceByDistance,
    paceDistribution,
    hrPaceRelationship,
    trainingLoad,
    distanceDistribution,
    weekOverWeek,
    cadence,
    elevation,
    calories,
    consistency,
  ] = await Promise.all([
    paceByDistanceFn(store),
    paceDistributionFn(store),
    hrPaceRelationshipFn(store),
    trainingLoadFn(store),
    distanceDistributionFn(store),
    weekOverWeekFn(store),
    cadenceAnalysisFn(store),
    elevationAnalysisFn(store),
    calorieEfficiencyFn(store),
    trainingConsistencyFn(store),
  ])
  return {
    paceByDistance,
    paceDistribution,
    hrPaceRelationship,
    trainingLoad,
    distanceDistribution,
    weekOverWeek,
    cadence,
    elevation,
    calories,
    consistency,
  }
}

// 别名（避免循环依赖）
async function paceByDistanceFn(s: GarminStoreFile) { return paceByDistance(s) }
async function paceDistributionFn(s: GarminStoreFile) { return paceDistribution(s) }
async function hrPaceRelationshipFn(s: GarminStoreFile) { return hrPaceRelationship(s) }
async function trainingLoadFn(s: GarminStoreFile) { return trainingLoad(s) }
async function distanceDistributionFn(s: GarminStoreFile) { return distanceDistribution(s) }
async function weekOverWeekFn(s: GarminStoreFile) { return weekOverWeek(s) }
async function cadenceAnalysisFn(s: GarminStoreFile) { return cadenceAnalysis(s) }
async function elevationAnalysisFn(s: GarminStoreFile) { return elevationAnalysis(s) }
async function calorieEfficiencyFn(s: GarminStoreFile) { return calorieEfficiency(s) }
async function trainingConsistencyFn(s: GarminStoreFile) { return trainingConsistency(s) }

// ═══════════════════════════════════════════════════════════════════════
//  AI 训练建议：基于规则的洞察生成
// ═══════════════════════════════════════════════════════════════════════

export type InsightSeverity = 'tip' | 'suggestion' | 'warning'

export interface Insight {
  category: 'pace' | 'volume' | 'load' | 'cadence' | 'hr' | 'consistency' | 'pb' | 'general'
  severity: InsightSeverity
  title: string
  detail: string
  /** 关联的数据上下文（让 AI 能引用）*/
  data?: Record<string, unknown>
}

export async function generateInsights(store: GarminStoreFile): Promise<Insight[]> {
  const insights: Insight[] = []
  const data = await store.read()
  const acts = Object.values(data.activities).sort(function (a, b) {
    return (a.startTime || '').localeCompare(b.startTime || '')
  })
  const runs = acts.filter(function (a) { return a.sport === 'running' })
  if (runs.length === 0) return insights

  // ========== 1. PB 进步检测 ==========
  const by10k = runs.filter(function (a) {
    const d = a.distanceMeters ?? 0
    return d >= 9500 && d <= 10500 && a.avgPaceSecPerKm
  })
  if (by10k.length >= 2) {
    const sorted = by10k.slice().sort(function (a, b) {
      return (a.startTime || '').localeCompare(b.startTime || '')
    })
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const firstP = first.avgPaceSecPerKm!
    const lastP = last.avgPaceSecPerKm!
    const diff = firstP - lastP
    if (diff > 5) {
      insights.push({
        category: 'pb', severity: 'suggestion',
        title: '10 公里配速进步 ' + diff + ' 秒',
        detail: '从 ' + Math.round(firstP / 60) + ':' + String(Math.round(firstP % 60)).padStart(2, '0') + '/km 提升到 ' + Math.round(lastP / 60) + ':' + String(Math.round(lastP % 60)).padStart(2, '0') + '/km',
        data: { from: firstP, to: lastP, diff: diff },
      })
    } else if (diff < -5) {
      insights.push({
        category: 'pb', severity: 'tip',
        title: '10 公里配速下降 ' + Math.abs(diff) + ' 秒',
        detail: '可能训练强度不够或疲劳累积，建议增加 1 次轻松跑',
        data: { from: firstP, to: lastP, diff: diff },
      })
    }
  }

  // ========== 2. 跑量趋势 ==========
  const now = new Date()
  const thisMon = new Date(now); thisMon.setDate(now.getDate() - now.getDay() + 1)
  const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7)
  function inWeek(from: Date, to: Date) {
    return acts.filter(function (a) {
      const d = new Date(a.startTime || '')
      return d >= from && d < to
    })
  }
  function kmOf(arr: typeof acts) {
    return arr.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000
  }
  const thisWeek = inWeek(thisMon, now)
  const lastWeek = inWeek(lastMon, thisMon)
  const thisKm = kmOf(thisWeek)
  const lastKm = kmOf(lastWeek)
  if (lastKm > 5) {
    const change = ((thisKm - lastKm) / lastKm * 100)
    if (change < -50) {
      insights.push({
        category: 'volume', severity: 'warning',
        title: '本周跑量大幅下降 ' + Math.round(change) + '%',
        detail: '本周 ' + thisKm.toFixed(1) + 'km vs 上周 ' + lastKm.toFixed(1) + 'km，建议补充 1-2 次训练避免停训',
      })
    } else if (change > 50) {
      insights.push({
        category: 'volume', severity: 'tip',
        title: '本周跑量增加 ' + Math.round(change) + '%',
        detail: '本周 ' + thisKm.toFixed(1) + 'km vs 上周 ' + lastKm.toFixed(1) + 'km，注意恢复，避免突然增量超 20%/周',
      })
    }
  }

  // ========== 3. 训练频率 ==========
  if (runs.length >= 4) {
    const totalDays = 90
    const recentRuns = runs.filter(function (a) {
      return (new Date(a.startTime || '').getTime()) >= (Date.now() - totalDays * 86400000)
    })
    const freqPerWeek = recentRuns.length / (totalDays / 7)
    if (freqPerWeek < 1) {
      insights.push({
        category: 'consistency', severity: 'suggestion',
        title: '训练频率偏低（每周 ' + freqPerWeek.toFixed(1) + ' 次）',
        detail: '建议每周至少 2-3 次有氧慢跑，建立训练节奏',
      })
    } else if (freqPerWeek >= 4) {
      insights.push({
        category: 'consistency', severity: 'tip',
        title: '训练频率高（每周 ' + freqPerWeek.toFixed(1) + ' 次）',
        detail: '注意休息和恢复，避免过度训练',
      })
    }
  }

  // ========== 4. 步频建议 ==========
  const withCadence = runs.filter(function (a) { return a.avgCadence })
  if (withCadence.length >= 3) {
    const avgCad = withCadence.reduce(function (s, a) { return s + a.avgCadence! }, 0) / withCadence.length
    if (avgCad < 170) {
      insights.push({
        category: 'cadence', severity: 'suggestion',
        title: '平均步频 ' + Math.round(avgCad) + ' spm 偏低',
        detail: '建议通过提高步频到 175-180 spm 降低受伤风险（短距离加速跑可改善）',
      })
    } else if (avgCad >= 180 && avgCad < 200) {
      insights.push({
        category: 'cadence', severity: 'tip',
        title: '步频不错（' + Math.round(avgCad) + ' spm）',
        detail: '继续保持高效步频，可减少膝盖冲击',
      })
    }
  }

  // ========== 5. 心率 vs 配速（有氧效率） ==========
  const paceBuckets: Record<string, number[]> = {
    '5:00-5:30': [], '5:30-6:00': [], '6:00-6:30': [], '6:30-7:00': [], '7:00-7:30': []
  }
  runs.forEach(function (a) {
    if (!a.avgPaceSecPerKm || !a.avgHr) return
    const p = a.avgPaceSecPerKm
    const m = Math.floor(p / 30) * 30, s = p % 30
    const m_str = Math.floor(m/60) + ':' + String(m%60).padStart(2, '0')
    const e_str = Math.floor((m+30)/60) + ':' + String((m+30)%60).padStart(2, '0')
    const key = m_str + '-' + e_str
    if (paceBuckets[key]) (paceBuckets[key] as number[]).push(a.avgHr)
  })
  // 如果同配速区间心率高（>170），有氧基础待提升
  Object.entries(paceBuckets).forEach(function (e) {
    const k = e[0], hrs = e[1] as number[]
    if (hrs.length >= 2) {
      const avgHr = hrs.reduce(function (s, h) { return s + h }, 0) / hrs.length
      const parts = k.split('-').map(function (s) { var m = s.split(':'); return (parseInt(m[0]!)||0)*60 + (parseInt(m[1]!)||0) })
      const loSec = parts[0] || 0, hiSec = parts[1] || 0
      const avgSec = (loSec + hiSec) / 2
      if (avgSec <= 360 && avgHr >= 170) {
        insights.push({
          category: 'hr', severity: 'suggestion',
          title: k + '/km 配速下心率 ' + Math.round(avgHr) + ' bpm 偏高',
          detail: '同配速下心率高说明有氧基础待提升，建议多练 Zone 2 有氧慢跑（心率 < 150）',
        })
      }
    }
  })

  // ========== 6. 爬升对配速影响 ==========
  const flat = runs.filter(function (a) { return (a.elevationGainMeters || 0) < 50 && a.distanceMeters! > 3000 && a.avgPaceSecPerKm })
  const hilly = runs.filter(function (a) { return (a.elevationGainMeters || 0) >= 100 && a.distanceMeters! > 3000 && a.avgPaceSecPerKm })
  if (flat.length >= 2 && hilly.length >= 2) {
    const flatP = flat.reduce(function (s, a) { return s + a.avgPaceSecPerKm! }, 0) / flat.length
    const hillyP = hilly.reduce(function (s, a) { return s + a.avgPaceSecPerKm! }, 0) / hilly.length
    const slowPct = (hillyP - flatP) / flatP * 100
    if (slowPct > 15) {
      insights.push({
        category: 'general', severity: 'tip',
        title: '爬升训练让配速慢 ' + slowPct.toFixed(0) + '%',
        detail: '平地 ' + Math.round(flatP) + 's/km vs 爬升 ' + Math.round(hillyP) + 's/km。山地训练提升腿部力量和越野能力',
      })
    }
  }

  // ========== 7. 卡路里效率趋势 ==========
  const calActs = runs.filter(function (a) { return a.calories && a.distanceMeters && a.distanceMeters > 0 })
  if (calActs.length >= 4) {
    const sortedByDate = calActs.slice().sort(function (a, b) { return (a.startTime || '').localeCompare(b.startTime || '') })
    const recent = sortedByDate.slice(-Math.ceil(sortedByDate.length / 2))
    const older = sortedByDate.slice(0, Math.floor(sortedByDate.length / 2))
    const recentEff = recent.reduce(function (s, a) { return s + (a.calories || 0) / ((a.distanceMeters || 0) / 1000) }, 0) / recent.length
    const olderEff = older.reduce(function (s, a) { return s + (a.calories || 0) / ((a.distanceMeters || 0) / 1000) }, 0) / older.length
    if (olderEff > 0) {
      const change = (recentEff - olderEff) / olderEff * 100
      if (Math.abs(change) > 8) {
        insights.push({
          category: 'general', severity: 'tip',
          title: '卡路里效率 ' + (change < 0 ? '提升' : '下降') + ' ' + Math.abs(change).toFixed(0) + '%',
          detail: '近期 ' + Math.round(recentEff) + ' vs 早期 ' + Math.round(olderEff) + ' 千卡/km。效率下降可能是体能进步（同样配速耗能减少），或疲劳累积',
        })
      }
    }
  }

  // ========== 8. 配速波动稳定性 ==========
  if (runs.length >= 5) {
    const recent5 = runs.slice(0, 5)
    const paces = recent5.map(function (a) { return a.avgPaceSecPerKm }).filter(function (p) { return p !== undefined }) as number[]
    if (paces.length >= 3) {
      const avg = paces.reduce(function (s, p) { return s + p }, 0) / paces.length
      const variance = paces.reduce(function (s, p) { return s + Math.pow(p - avg, 2) }, 0) / paces.length
      const stdDev = Math.sqrt(variance)
      const cv = (stdDev / avg) * 100
      if (cv > 8) {
        insights.push({
          category: 'pace', severity: 'tip',
          title: '配速波动较大（CV ' + cv.toFixed(0) + '%）',
          detail: '最近 5 次跑步配速差异较大，建议多练固定配速的节奏跑提升稳定性',
        })
      } else if (cv < 4) {
        insights.push({
          category: 'pace', severity: 'tip',
          title: '配速稳定（CV ' + cv.toFixed(0) + '%）',
          detail: '继续保持节奏，可适当提升强度（如增加间歇训练）',
        })
      }
    }
  }

  return insights
}

// ═══════════════════════════════════════════════════════════════════════
//  报告聚合：周/月/季/年/自定义窗口
// ═══════════════════════════════════════════════════════════════════════

export type ReportPeriod = 'week' | 'month' | 'quarter' | 'year' | 'custom'

export interface ReportResult {
  period: string
  from: string
  to: string
  /** 运动概览 */
  overview: {
    totalActivities: number
    totalRuns: number
    totalKm: number
    totalTimeSec: number
    totalCalories: number
    avgPace: string
    bestPace: string
    longestKm: number
    avgHr: number | null
  }
  /** 按周分解（窗口内） */
  weekly: Array<{ week: string; km: number; runs: number }>
  /** 运动类型分布 */
  sportBreakdown: Array<{ sport: string; count: number; totalKm: number }>
  /** 各距离 PB（窗口内） */
  bestPaces: Array<{ label: string; bestPace: string; date: string | null }>
  /** 健康数据（窗口内有数据的日期） */
  health: {
    daysWithData: number
    avgSteps: number | null
    avgRestingHr: number | null
    avgStress: number | null
    avgBodyBattery: number | null
  }
  /** 活动明细（最近 10 条，含 durationDisplay 格式化时长） */
  recent: Array<ActivityRecord & { durationDisplay: string }>
  /** 上一窗口对比 */
  previous: {
    totalKm: number
    totalRuns: number
    kmChange: number
    runsChange: number
  }
}

/** 计算报告窗口 */
function reportWindow(period: ReportPeriod, from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to + 'T23:59:59') : new Date()
  let start: Date
  if (period === 'custom' && from) {
    start = new Date(from + 'T00:00:00')
  } else {
    start = new Date(end)
    if (period === 'week') start.setDate(end.getDate() - 6)
    else if (period === 'month') start.setMonth(end.getMonth() - 1)
    else if (period === 'quarter') start.setMonth(end.getMonth() - 3)
    else if (period === 'year') start.setFullYear(end.getFullYear() - 1)
    else start.setDate(end.getDate() - 6) // default week
  }
  return { from: start, to: end }
}

/** 生成报告聚合数据 */
export async function reportStats(
  store: GarminStoreFile,
  opts: { period?: ReportPeriod; from?: string; to?: string } = {},
): Promise<ReportResult> {
  const period = opts.period ?? 'week'
  const { from, to } = reportWindow(period, opts.from, opts.to)
  const data = await store.read()
  const acts = Object.values(data.activities).filter(function (a) {
    const t = new Date(a.startTime || '').getTime()
    return t >= from.getTime() && t <= to.getTime()
  })
  const runs = acts.filter(function (a) { return a.sport === 'running' })
  const prevFrom = new Date(from)
  const span = to.getTime() - from.getTime()
  prevFrom.setTime(prevFrom.getTime() - span - 86400000)
  const prevTo = new Date(from)
  prevTo.setTime(prevTo.getTime() - 86400000)
  const prevActs = Object.values(data.activities).filter(function (a) {
    const t = new Date(a.startTime || '').getTime()
    return t >= prevFrom.getTime() && t <= prevTo.getTime()
  })

  const totalKm = acts.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000
  const totalTimeSec = acts.reduce(function (s, a) { return s + (a.durationSec || 0) }, 0)
  const totalCalories = acts.reduce(function (s, a) { return s + (a.calories || 0) }, 0)
  const paces = runs.map(function (a) { return a.avgPaceSecPerKm }).filter(function (p) { return p !== undefined && p > 0 }) as number[]
  const avgPace = paces.length ? paces.reduce(function (s, p) { return s + p }, 0) / paces.length : undefined
  const bestPace = paces.length ? Math.min.apply(null, paces) : undefined
  const longest = runs.length ? Math.max.apply(null, runs.map(function (a) { return a.distanceMeters || 0 })) / 1000 : 0
  const hrs = runs.map(function (a) { return a.avgHr }).filter(function (h) { return h !== undefined }) as number[]
  const avgHr = hrs.length ? Math.round(hrs.reduce(function (s, h) { return s + h }, 0) / hrs.length) : null

  // 按周分解
  const byWeek: Record<string, { km: number; runs: number }> = {}
  acts.forEach(function (a) {
    const d = new Date(a.startTime || '')
    const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1)
    const wk = mon.toISOString().slice(0, 10)
    if (!byWeek[wk]) byWeek[wk] = { km: 0, runs: 0 }
    byWeek[wk]!.km += (a.distanceMeters || 0) / 1000
    byWeek[wk]!.runs++
  })
  const weekly = Object.entries(byWeek).sort().map(function (e) {
    const w = e[1]!
    return { week: e[0], km: Math.round(w.km * 10) / 10, runs: w.runs }
  })

  // 运动类型
  const bySport: Record<string, { count: number; km: number }> = {}
  acts.forEach(function (a) {
    const s = a.sport || 'unknown'
    if (!bySport[s]) bySport[s] = { count: 0, km: 0 }
    bySport[s]!.count++
    bySport[s]!.km += (a.distanceMeters || 0) / 1000
  })
  const sportBreakdown = Object.entries(bySport).map(function (e) {
    const s = e[1]!
    return { sport: e[0], count: s.count, totalKm: Math.round(s.km * 10) / 10 }
  }).sort(function (a, b) { return b.count - a.count })

  // 窗口内 PB
  const segDefs = [
    { label: '5 公里', d: 5000, tol: 500 },
    { label: '10 公里', d: 10000, tol: 1000 },
    { label: '半马', d: 21097, tol: 1500 },
    { label: '全马', d: 42195, tol: 1500 },
  ]
  const bestPaces = segDefs.map(function (seg) {
    const matches = runs.filter(function (a) { return Math.abs((a.distanceMeters || 0) - seg.d) <= seg.tol })
    if (!matches.length) return { label: seg.label, bestPace: '—', date: null }
    const sorted = matches.sort(function (a, b) { return (a.avgPaceSecPerKm || 9999) - (b.avgPaceSecPerKm || 9999) })
    const best = sorted[0] ?? null
    const p = best ? best.avgPaceSecPerKm : null
    return {
      label: seg.label,
      bestPace: p ? Math.floor(p / 60) + ':' + String(Math.round(p % 60)).padStart(2, '0') + '/km' : '—',
      date: best ? (best.startTime || '').slice(0, 10) || null : null,
    }
  })

  // 健康（窗口内）
  const daily = data.daily
  const healthDates: string[] = []
  let stepsSum = 0, stepsN = 0, rhrSum = 0, rhrN = 0, stressSum = 0, stressN = 0, bbSum = 0, bbN = 0
  const cur = new Date(from)
  while (cur <= to) {
    const ds = cur.toISOString().slice(0, 10)
    const dd = daily[ds]
    if (dd) {
      healthDates.push(ds)
      if (dd.steps) { stepsSum += dd.steps; stepsN++ }
      if (dd.restingHeartRate) { rhrSum += dd.restingHeartRate; rhrN++ }
      if (dd.stressAvg && dd.stressAvg > 0) { stressSum += dd.stressAvg; stressN++ }
      if (dd.bodyBattery != null) { bbSum += dd.bodyBattery; bbN++ }
    }
    cur.setDate(cur.getDate() + 1)
  }
  const health = {
    daysWithData: healthDates.length,
    avgSteps: stepsN ? Math.round(stepsSum / stepsN) : null,
    avgRestingHr: rhrN ? Math.round(rhrSum / rhrN) : null,
    avgStress: stressN ? Math.round(stressSum / stressN) : null,
    avgBodyBattery: bbN ? Math.round(bbSum / bbN) : null,
  }

  // 对比上期
  const prevKm = prevActs.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000
  const prevRuns = prevActs.length
  const kmChange = prevKm > 0 ? Math.round(((totalKm - prevKm) / prevKm) * 100) : 0
  const runsChange = prevRuns > 0 ? totalRuns() - prevRuns : 0
  function totalRuns() { return runs.length }

  return {
    period,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    overview: {
      totalActivities: acts.length,
      totalRuns: runs.length,
      totalKm: Math.round(totalKm * 10) / 10,
      totalTimeSec,
      totalCalories: Math.round(totalCalories),
      avgPace: formatPace(avgPace),
      bestPace: formatPace(bestPace),
      longestKm: Math.round(longest * 10) / 10,
      avgHr,
    },
    weekly,
    sportBreakdown,
    bestPaces,
    health,
    recent: acts.sort(function (a, b) { return b.startTime.localeCompare(a.startTime) }).slice(0, 10).map(function (a) {
      return { ...a, durationDisplay: formatDuration(a.durationSec) }
    }),
    previous: {
      totalKm: Math.round(prevKm * 10) / 10,
      totalRuns: prevRuns,
      kmChange,
      runsChange,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  训练计划数据：用户基线 + 建议
// ═══════════════════════════════════════════════════════════════════════

export interface TrainingPlanData {
  /** 用户当前水平基线 */
  baseline: {
    recentAvgPace: string
    bestPace: string
    weeklyFreq: number
    avgWeeklyKm: number
    avgHr: number | null
    avgCadence: number | null
    longestRunKm: number
    totalKm: number
    totalRuns: number
  }
  /** 目标建议（AI 用） */
  goalSuggestions: Array<{
    goal: string
    weeklyPlan: string
    tips: string[]
  }>
  /** 当前水平评估 */
  assessment: string
  /** 数据指纹（判断基线是否变化）*/
  fingerprint: string
}

/** 生成训练计划数据（供 AI 个性化建议）*/
export async function trainingPlanData(store: GarminStoreFile): Promise<TrainingPlanData> {
  const data = await store.read()
  const acts = Object.values(data.activities).sort(function (a, b) {
    return (a.startTime || '').localeCompare(b.startTime || '')
  })
  const runs = acts.filter(function (a) { return a.sport === 'running' })

  // 基线
  const allPaces = runs.map(function (a) { return a.avgPaceSecPerKm }).filter(function (p) { return p && p > 0 }) as number[]
  const bestPace = allPaces.length ? Math.min.apply(null, allPaces) : null
  const avgPace = allPaces.length ? allPaces.reduce(function (s, p) { return s + p }, 0) / allPaces.length : null
  const totalKm = acts.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000
  const totalRuns = runs.length
  const longest = runs.length ? Math.max.apply(null, runs.map(function (a) { return a.distanceMeters || 0 })) / 1000 : 0
  const hrs = runs.map(function (a) { return a.avgHr }).filter(function (h) { return h }) as number[]
  const avgHr = hrs.length ? Math.round(hrs.reduce(function (s, h) { return s + h }, 0) / hrs.length) : null
  const cads = runs.map(function (a) { return a.avgCadence }).filter(function (c) { return c }) as number[]
  const avgCadence = cads.length ? Math.round(cads.reduce(function (s, c) { return s + c }, 0) / cads.length) : null

  // 周频率（最近 90 天）
  const recent90 = runs.filter(function (a) {
    return (new Date(a.startTime || '').getTime()) >= (Date.now() - 90 * 86400000)
  })
  const weeklyFreq = recent90.length / (90 / 7)
  const avgWeeklyKm = recent90.length ? Math.round((recent90.reduce(function (s, a) { return s + (a.distanceMeters || 0) }, 0) / 1000) / (90 / 7) * 10) / 10 : 0

  // 目标建议（按当前水平给出 3 类目标）
  const goalSuggestions = [
    {
      goal: '提升 5 公里成绩',
      weeklyPlan: '建议每周 3 次：1 次间歇（6×800m，配速快于 5km 目标配速 15 秒），1 次节奏跑（20 分钟阈值配速），1 次有氧慢跑（45 分钟 Zone 2）',
      tips: [
        '间歇训练是提升 5km 最有效的方式',
        '节奏跑提升乳酸阈值，增强耐酸能力',
        '保持步频 180+ 减少受伤风险',
      ],
    },
    {
      goal: '提升 10 公里成绩',
      weeklyPlan: '建议每周 3 次：1 次长距离（12-15km，配速慢于目标 30 秒），1 次节奏跑（25 分钟阈值配速），1 次有氧（60 分钟 Zone 2）',
      tips: [
        '10km 是有氧耐力为主，长距离积累是关键',
        '节奏跑（比 10km 目标快 10 秒/km）提升阈值',
        '注意补给和恢复',
      ],
    },
    {
      goal: '备战半马/全马',
      weeklyPlan: '建议每周 4 次：1 次长距离（每周递增 10%，最长到 30km），1 次节奏跑，2 次有氧慢跑，配速心率控制在 Zone 2',
      tips: [
        '长距离是半马/全马的核心',
        '每周增量不超过 10%，防受伤',
        '赛前 2-3 周减量',
      ],
    },
  ]

  // 水平评估
  let assessment = '无法评估（数据不足）'
  if (runs.length >= 3) {
    if (bestPace && bestPace < 300) assessment = '速度型跑者（5km 可进 25 分），有氧耐力需加强'
    else if (bestPace && bestPace < 330) assessment = '中高级跑者（5km 25-30 分），基础良好，可专注专项训练'
    else if (bestPace && bestPace < 360) assessment = '中级跑者（配速 5:30-6:00/km），有氧基础不错，可逐步增加强度'
    else assessment = '入门级跑者，重点是建立有氧基础和训练习惯'
  }

  const fingerprint = [
    bestPace ? Math.round(bestPace) : 0,
    Math.round(weeklyFreq * 10),
    Math.round(avgWeeklyKm * 10),
    avgHr ?? 0,
    Math.round(longest * 10),
    Math.round(totalKm),
  ].join('|')

  return {
    baseline: {
      recentAvgPace: formatPace(avgPace ?? undefined),
      bestPace: formatPace(bestPace ?? undefined),
      weeklyFreq: Math.round(weeklyFreq * 10) / 10,
      avgWeeklyKm,
      avgHr,
      avgCadence,
      longestRunKm: Math.round(longest * 10) / 10,
      totalKm: Math.round(totalKm * 10) / 10,
      totalRuns,
    },
    goalSuggestions,
    assessment,
    fingerprint,
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  心率区间时长（基于 Garmin raw 的 hrTimeInZone_1~5 秒数）
// ═══════════════════════════════════════════════════════════════════════

export interface HrZoneDetail {
  activityId: string
  activityName: string
  startTime: string
  sport: string
  totalSec: number
  zones: { zone1: number; zone2: number; zone3: number; zone4: number; zone5: number }
}

export interface HrZoneBreakdown {
  /** 5 个心率区间的总时长（秒）*/
  totals: { zone1: number; zone2: number; zone3: number; zone4: number; zone5: number }
  /** 总时长（所有区间）*/
  totalSec: number
  /** 每次活动的区间详情（供前端 + 按钮展开）*/
  details: HrZoneDetail[]
}

export async function hrZoneBreakdown(store: GarminStoreFile): Promise<HrZoneBreakdown> {
  const data = await store.read()
  const activities = Object.values(data.activities)
  const totals = { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 }
  const details: HrZoneDetail[] = []
  for (const a of activities) {
    const raw = (a as ActivityRecord & { raw?: Record<string, unknown> }).raw || {}
    const z = {
      zone1: typeof raw.hrTimeInZone_1 === 'number' ? raw.hrTimeInZone_1 : 0,
      zone2: typeof raw.hrTimeInZone_2 === 'number' ? raw.hrTimeInZone_2 : 0,
      zone3: typeof raw.hrTimeInZone_3 === 'number' ? raw.hrTimeInZone_3 : 0,
      zone4: typeof raw.hrTimeInZone_4 === 'number' ? raw.hrTimeInZone_4 : 0,
      zone5: typeof raw.hrTimeInZone_5 === 'number' ? raw.hrTimeInZone_5 : 0,
    }
    const totalSec = z.zone1 + z.zone2 + z.zone3 + z.zone4 + z.zone5
    if (totalSec > 0) {
      totals.zone1 += z.zone1
      totals.zone2 += z.zone2
      totals.zone3 += z.zone3
      totals.zone4 += z.zone4
      totals.zone5 += z.zone5
      details.push({
        activityId: a.activityId,
        activityName: a.activityName,
        startTime: a.startTime,
        sport: a.sport,
        totalSec,
        zones: z,
      })
    }
  }
  const totalSec = totals.zone1 + totals.zone2 + totals.zone3 + totals.zone4 + totals.zone5
  return { totals, totalSec, details }
}
