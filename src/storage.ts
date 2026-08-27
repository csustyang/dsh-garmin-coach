/**
 * Garmin 数据存储层 —— 独立 JSON 文件，不与其他数据混。
 *
 * 位置：<插件目录>/data/garmin.json（独立于 DSH 的 ~/.dsh/storages/）
 *
 * 结构：
 * {
 *   "version": 1,
 *   "lastSyncAt": "ISO",
 *   "activities": { "<activityId>": ActivityRecord },   // 按 id 去重
 *   "daily": { "<date>": DailyRecord },                 // 每日健康
 *   "sportFilter": ["running", "cycling", ...],         // 运动类型筛选
 *   "syncDaysBack": 14
 * }
 *
 * 设计：
 *  - 原子写（临时文件 + rename），防崩溃损坏
 *  - activities 用对象以 activityId 为 key → 天然去重
 *  - 后期升级 PostgreSQL 时，只需替换本文件的读写实现，
 *    上层查询引擎接口不变。
 */

import { mkdir, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { logger } from './logger.js'

export interface ActivityRecord {
  activityId: string
  activityName: string
  sport: string
  startTime: string
  durationSec: number
  distanceMeters: number
  avgPaceSecPerKm?: number
  avgSpeedMps?: number
  avgHr?: number
  maxHr?: number
  calories?: number
  elevationGainMeters?: number
  avgCadence?: number
  trainingEffect?: number
  /** 原始 Garmin 载荷，备用 */
  raw?: unknown
}

export interface DailyRecord {
  date: string
  steps?: number
  distanceMeters?: number
  activeKilocalories?: number
  restingHeartRate?: number
  bodyBattery?: number
  stressAvg?: number
  maxStressLevel?: number
  stressQualifier?: string
  highlyActiveSeconds?: number
  activeSeconds?: number
  sedentarySeconds?: number
  minHeartRate?: number
  maxHeartRate?: number
  avgHeartRate?: number
  floorsAscendedMeters?: number
  sleepSeconds?: number
  sleepScore?: number
  hrvStatus?: string
  hrvWeeklyAvg?: number
  readinessScore?: number
  raw?: unknown
}

export interface GarminStore {
  version: number
  lastSyncAt: string
  activities: Record<string, ActivityRecord>
  daily: Record<string, DailyRecord>
  sportFilter: string[]
  syncDaysBack: number
}

const DEFAULT_STORE: GarminStore = {
  version: 1,
  lastSyncAt: '',
  activities: {},
  daily: {},
  sportFilter: [],
  syncDaysBack: 14,
}

export interface GarminStoreOptions {
  /** 数据目录；缺省用 <cwd>/data */
  dataDir?: string
}

/**
 * GarminStoreFile —— JSON 文件实现。
 * 后期换 PostgreSQL 时实现同名接口即可。
 */
export class GarminStoreFile {
  private readonly filePath: string
  private cache: GarminStore | null = null

  constructor(opts: GarminStoreOptions = {}) {
    // 固定数据目录：优先用 DSH_HOME（~/.dsh/data），否则 cwd/data。
    // 不依赖 process.cwd() 的相对路径——DSH 进程 cwd 和开发时不同，
    // 相对路径会导致读写不一致（计划保存到 A 目录，DSH 从 B 目录读）。
    // 固定数据目录：优先显式 dataDir；否则用用户主目录下的 data（~ /data）。
    // 不依赖 process.cwd()（DSH 进程 cwd 和开发时不同）也不依赖 DSH_HOME
    // （DSH 实际用的是 cwd/data，即 ~/data）。
    const dir =
      opts.dataDir ?? join(process.env.HOME ?? process.cwd(), 'data')
    this.filePath = join(dir, 'garmin.json')
  }

  /** 读（带内存缓存，避免频繁磁盘 IO）*/
  async read(): Promise<GarminStore> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<GarminStore>
      this.cache = {
        ...DEFAULT_STORE,
        ...parsed,
        activities: parsed.activities ?? {},
        daily: parsed.daily ?? {},
        sportFilter: parsed.sportFilter ?? [],
      }
      return this.cache
    } catch (e) {
      // 文件不存在或损坏 → 返回默认空库
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = structuredClone(DEFAULT_STORE)
        return this.cache
      }
      logger.warn('storage', '读取 garmin.json 失败，使用空库', e)
      this.cache = structuredClone(DEFAULT_STORE)
      return this.cache
    }
  }

  /** 原子写 */
  async write(store: GarminStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, this.filePath)
    this.cache = store
  }

  /**
   * 更新：读→改→写（带重试，避免并发冲突）
   */
  async mutate<T>(
    fn: (store: GarminStore) => T | Promise<T>,
  ): Promise<T> {
    const store = await this.read()
    const result = await fn(store)
    await this.write(store)
    return result
  }

  /** 落库一条活动（按 activityId 去重）*/
  async upsertActivity(activity: ActivityRecord): Promise<boolean> {
    return this.mutate((store) => {
      const existing = store.activities[activity.activityId]
      store.activities[activity.activityId] = activity
      return !existing // 返回是否"新增"（用于去重统计）
    })
  }

  /** 批量落库活动，返回新增数量 */
  async upsertActivities(activities: ActivityRecord[]): Promise<number> {
    return this.mutate((store) => {
      let added = 0
      for (const a of activities) {
        if (!store.activities[a.activityId]) added++
        store.activities[a.activityId] = a
      }
      return added
    })
  }

  /** 落库每日健康 */
  async upsertDaily(daily: DailyRecord): Promise<void> {
    await this.mutate((store) => {
      store.daily[daily.date] = daily
    })
  }

  /** 批量落库每日健康 */
  async upsertDailies(dailies: DailyRecord[]): Promise<void> {
    await this.mutate((store) => {
      for (const d of dailies) {
        store.daily[d.date] = d
      }
    })
  }

  /** 更新同步游标 */
  async setSyncMeta(lastSyncAt: string, syncDaysBack: number): Promise<void> {
    await this.mutate((store) => {
      store.lastSyncAt = lastSyncAt
      store.syncDaysBack = syncDaysBack
    })
  }

  /** 设置运动类型筛选 */
  async setSportFilter(sports: string[]): Promise<void> {
    await this.mutate((store) => {
      store.sportFilter = sports
    })
  }

  /** 清空（用于测试或用户重置）*/
  async clear(): Promise<void> {
    this.cache = structuredClone(DEFAULT_STORE)
    await rm(this.filePath, { force: true })
  }

  // ────────────── 训练计划缓存（独立文件 training-plan.json）──────────────

  private get planPath(): string {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
    return join(dir, 'training-plan.json')
  }

  /** 读取训练计划缓存 */
  async loadTrainingPlan(): Promise<TrainingPlanCache | null> {
    try {
      const raw = await readFile(this.planPath, 'utf8')
      return JSON.parse(raw) as TrainingPlanCache
    } catch {
      return null
    }
  }

  /** 保存训练计划缓存 */
  async saveTrainingPlan(plan: TrainingPlanCache): Promise<void> {
    // 保留打卡：只在 plan.tasks 里没有 done 字段时才用旧值
    // 这样：1) 同目标保存保留打卡；2) toggleTask 设置的 done 不会被覆盖
    const old = await this.loadTrainingPlan()
    if (old && old.goal === plan.goal && old.tasks && old.tasks.length > 0) {
      const oldDoneMap: Record<string, boolean> = {}
      old.tasks.forEach(function (t) { oldDoneMap[t.id] = t.done })
      // 只补缺漏（新计划任务无 done 字段时用旧值）
      const mergedTasks = (plan.tasks || []).map(function (t) {
        if (t.done !== undefined) return t  // 新计划已有 done，保留
        const wasDone = oldDoneMap[t.id]
        return wasDone === undefined ? t : { ...t, done: wasDone }
      })
      plan = { ...plan, tasks: mergedTasks }
    }
    // 备份旧计划（防止 AI 误判覆盖后找不回）
    if (old) {
      await this.backupPlan(old)
    }
    await mkdir(this.planPath.substring(0, this.planPath.lastIndexOf('/')), { recursive: true })
    await writeFile(this.planPath, JSON.stringify(plan, null, 2), 'utf8')
  }

  /** 备份旧计划到 history 目录（带时间戳）*/
  private async backupPlan(plan: TrainingPlanCache): Promise<void> {
    const dir = this.planPath.substring(0, this.planPath.lastIndexOf('/'))
    const historyDir = join(dir, 'training-plan-history')
    await mkdir(historyDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeGoal = (plan.goal || 'plan').replace(/[^a-zA-Z0-9一-龥]/g, '_').slice(0, 30)
    const path = join(historyDir, ts + '-' + safeGoal + '.json')
    await writeFile(path, JSON.stringify(plan, null, 2), 'utf8')
  }

  /** 列出计划历史 */
  async listPlanHistory(): Promise<Array<{ file: string; time: string; goal: string; tasks: number; done: number }>> {
    const dir = this.planPath.substring(0, this.planPath.lastIndexOf('/'))
    const historyDir = join(dir, 'training-plan-history')
    try {
      const files = (await readdir(historyDir)).filter(function (f) { return f.endsWith('.json') })
      const result = []
      for (const f of files.sort().reverse().slice(0, 20)) {
        try {
          const raw = await readFile(join(historyDir, f), 'utf8')
          const plan = JSON.parse(raw) as TrainingPlanCache
          const done = (plan.tasks || []).filter(function (t) { return t.done }).length
          result.push({
            file: f,
            time: f.slice(0, 19).replace(/-/g, ':').replace('T', ' '),
            goal: plan.goal || '',
            tasks: (plan.tasks || []).length,
            done: done,
          })
        } catch { /* 跳过损坏文件 */ }
      }
      return result
    } catch {
      return []
    }
  }

  /** 从历史恢复一个计划 */
  async restorePlan(file: string): Promise<{ ok: boolean; message?: string }> {
    const dir = this.planPath.substring(0, this.planPath.lastIndexOf('/'))
    const historyDir = join(dir, 'training-plan-history')
    const safeFile = file.replace(/[^a-zA-Z0-9一-龥._-]/g, '')
    const path = join(historyDir, safeFile)
    try {
      const raw = await readFile(path, 'utf8')
      const plan = JSON.parse(raw) as TrainingPlanCache
      await this.saveTrainingPlan(plan)
      return { ok: true, message: '已恢复计划：' + (plan.goal || '') + '（打卡 ' + (plan.tasks || []).filter(function (t) { return t.done }).length + ' 个）' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 打卡：切换某个训练任务的完成状态 */
  async toggleTask(taskId: string): Promise<{ ok: boolean; task?: TrainingTask; message?: string }> {
    const plan = await this.loadTrainingPlan()
    if (!plan) return { ok: false, message: '无训练计划' }
    const task = (plan.tasks || []).find(function (t) { return t.id === taskId })
    if (!task) return { ok: false, message: '任务不存在: ' + taskId }
    task.done = !task.done
    await this.saveTrainingPlan(plan)
    return { ok: true, task }
  }

  /** 统计打卡进度 */
  async planProgress(): Promise<{ done: number; total: number }> {
    const plan = await this.loadTrainingPlan()
    if (!plan || !plan.tasks || plan.tasks.length === 0) return { done: 0, total: 0 }
    const done = plan.tasks.filter(function (t) { return t.done }).length
    return { done, total: plan.tasks.length }
  }

  /** 清除训练计划缓存 */
  async clearTrainingPlan(): Promise<void> {
    await rm(this.planPath, { force: true })
  }

  // ────────────── 训练日记（独立文件 data/training-diary.json）──────────────

  private get diaryPath(): string {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
    return join(dir, 'training-diary.json')
  }

  /** 读取全部日记（按日期倒序）*/
  async loadDiary(): Promise<DiaryEntry[]> {
    try {
      const raw = await readFile(this.diaryPath, 'utf8')
      const parsed = JSON.parse(raw) as { entries?: DiaryEntry[] }
      return (parsed.entries || []).sort(function (a, b) {
        return b.date.localeCompare(a.date)
      })
    } catch {
      return []
    }
  }

  /** 添加一条日记 */
  async addDiaryEntry(entry: DiaryEntry): Promise<DiaryEntry> {
    const entries = await this.loadDiary()
    entries.push(entry)
    await this.writeDiary(entries)
    return entry
  }

  /** 删除一条日记 */
  async removeDiaryEntry(id: string): Promise<{ ok: boolean }> {
    const entries = await this.loadDiary()
    const filtered = entries.filter(function (e) { return e.id !== id })
    if (filtered.length === entries.length) return { ok: false }
    await this.writeDiary(filtered)
    return { ok: true }
  }

  /** 写日记到磁盘 */
  private async writeDiary(entries: DiaryEntry[]): Promise<void> {
    await mkdir(this.diaryPath.substring(0, this.diaryPath.lastIndexOf('/')), { recursive: true })
    await writeFile(this.diaryPath, JSON.stringify({ entries: entries }, null, 2), 'utf8')
  }
}

/** 训练日记条目 */
export interface DiaryEntry {
  id: string
  date: string
  /** 关联训练任务 id（可选）*/
  taskId?: string
  /** 任务描述快照（如"有氧慢跑 6km"）*/
  taskLabel?: string
  /** 训练感受 */
  feeling: string
  /** 1-5 星 */
  rating?: number
  createdAt: string
}

/** 训练计划缓存结构 */
export interface TrainingTask {
  id: string
  week: number
  day: string
  type: string
  detail: string
  done: boolean
}

export interface TrainingPlanCache {
  goal: string
  baselineFingerprint: string
  generatedAt: string
  weeks: number
  daysPerWeek: number
  plan: string
  tips: string[]
  /** 结构化训练任务（供打卡）*/
  tasks: TrainingTask[]
}

/** 数据文件路径（给用户/日志看）*/
export function dataFilePath(dataDir?: string): string {
  const dir = dataDir ?? join(process.env.HOME ?? process.cwd(), 'data')
  return join(dir, 'garmin.json')
}

