/**
 * Garmin 数据同步服务。
 *
 * 职责：
 *   - 从 Garmin API 拉活动 + 每日健康
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 按运动类型筛选
 *   - 记录同步游标（lastSyncAt）
 */

import type { GarminQueries } from './api/queries.js'

/** 本地日期格式 YYYY-MM-DD（不用 toISOString，否则会被 UTC 偏移到前一天/后一天）*/
function localDateStr(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** 本地日期构造（用 YYYY-MM-DD，避免 UTC 解析）*/
function localDate(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1) // 本地时间 0 点
}

/** 本地时间 ISO 字符串（YYYY-MM-DDTHH:mm:ss.sss+HH:MM）—— 与 logger.ts 保持一致 */
function tsLocal(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const HH = pad(d.getHours())
  const MM = pad(d.getMinutes())
  const SS = pad(d.getSeconds())
  const mss = pad(d.getMilliseconds(), 3)
  const offMin = -d.getTimezoneOffset()
  const offSign = offMin >= 0 ? '+' : '-'
  const offAbs = Math.abs(offMin)
  const offHH = pad(Math.floor(offAbs / 60))
  const offMM = pad(offAbs % 60)
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}.${mss}${offSign}${offHH}:${offMM}`
}
import type {
  ActivityRecord,
  DailyRecord,
  GarminStoreFile,
} from './storage.js'
import { dataFilePath, SYNC_DAYS_BACK_MAX } from './storage.js'
import { logger } from './logger.js'

/** 支持的常见运动类型（Garmin typeKey）*/
export const SUPPORTED_SPORTS = [
  'running',
  'cycling',
  'swimming',
  'hiking',
  'walking',
  'trail_running',
  'mountain_biking',
  'strength_training',
  'other',
] as const

export type SportKey = (typeof SUPPORTED_SPORTS)[number]

export interface SyncOptions {
  days?: number
  sportFilter?: string[]
  store: GarminStoreFile
  queries: GarminQueries
}

/** 全量同步进度 */
export interface FullSyncProgress {
  processed: number
  total: number
  status: 'idle' | 'running' | 'paused' | 'done' | 'error'
  cursor?: string
  error?: string
}

export interface SyncResult {
  synced: boolean
  activitiesAdded: number
  activitiesTotal: number
  dailiesAdded: number
  sportsSeen: string[]
  error?: string
}

/**
 * 把 Garmin 活动原始载荷转成 ActivityRecord。
 * 依据 ai-skill-garmin 返回的字段结构做映射。
 */
export function toActivityRecord(raw: unknown): ActivityRecord | null {
  const a = raw as Record<string, unknown>
  if (!a || typeof a !== 'object') return null
  const activityId = String(a.activityId ?? '')
  if (!activityId) return null

  const activityType = a.activityType as { typeKey?: string } | undefined
  const sport = String(activityType?.typeKey ?? a.sport ?? 'unknown')

  // 距离（米）
  const distanceMeters =
    typeof a.distance === 'number' ? a.distance : Number(a.distanceMeters ?? 0)

  // 时长（秒）
  const durationSec =
    typeof a.duration === 'number'
      ? a.duration
      : Number(a.durationInSeconds ?? 0)

  // 平均速度（m/s）→ 配速（秒/km）
  const avgSpeedMps =
    typeof a.averageSpeed === 'number'
      ? a.averageSpeed
      : Number(a.averageSpeedInMetersPerSecond ?? NaN)
  const avgPaceSecPerKm = Number.isFinite(avgSpeedMps) && avgSpeedMps > 0
    ? Math.round(1000 / avgSpeedMps)
    : undefined

  return {
    activityId,
    activityName: String(a.activityName ?? ''),
    sport,
    startTime: String(a.startTimeLocal ?? a.startTimeGMT ?? ''),
    durationSec,
    distanceMeters,
    avgPaceSecPerKm,
    avgSpeedMps: Number.isFinite(avgSpeedMps) ? avgSpeedMps : undefined,
    avgHr: typeof a.averageHR === 'number' ? a.averageHR : undefined,
    maxHr: typeof a.maxHR === 'number' ? a.maxHR : undefined,
    calories: typeof a.calories === 'number' ? a.calories : undefined,
    elevationGainMeters:
      typeof a.elevationGain === 'number' ? a.elevationGain : undefined,
    avgCadence:
      typeof a.averageRunningCadenceInStepsPerMinute === 'number'
        ? a.averageRunningCadenceInStepsPerMinute
        : undefined,
    trainingEffect:
      typeof a.trainingEffect === 'number' ? a.trainingEffect : undefined,
    isPR: typeof a.isPR === 'boolean' ? a.isPR : undefined,
    elevationLossMeters:
      typeof a.elevationLoss === 'number' ? a.elevationLoss : undefined,
    maxCadence:
      typeof a.maxRunningCadenceInStepsPerMinute === 'number'
        ? a.maxRunningCadenceInStepsPerMinute
        : undefined,
    verticalOscillationCm:
      typeof a.avgVerticalOscillation === 'number'
        ? a.avgVerticalOscillation
        : undefined,
    strideLengthCm:
      typeof a.avgStrideLength === 'number' ? a.avgStrideLength : undefined,
    verticalRatioPct:
      typeof a.avgVerticalRatio === 'number' ? a.avgVerticalRatio : undefined,
    // 平均坡度调整配速：avgGradeAdjustedSpeed (m/s) → 秒/km
    gradeAdjustedPaceSecPerKm:
      typeof a.avgGradeAdjustedSpeed === 'number' && a.avgGradeAdjustedSpeed > 0
        ? Math.round(1000 / a.avgGradeAdjustedSpeed)
        : undefined,
    // 最佳配速：maxSpeed (m/s) → 秒/km
    bestPaceSecPerKm:
      typeof a.maxSpeed === 'number' && a.maxSpeed > 0
        ? Math.round(1000 / a.maxSpeed)
        : undefined,
    raw: a,
  }
}

/**
 * 把 Garmin 每日健康原始载荷转成 DailyRecord。
 */
/**
 * 判断 daily 原始载荷是否是"无意义响应"（API 200 但当天没有真实健康数据）。
 * 用于过滤"整天没戴表 / 表完全没工作 / 静息整天 / 啥都没记录"等情况——
 * 这些数据入库只会污染统计（虚增天数、拖累均值），不入库。
 *
 * 判定规则：所有可能的"真实健康指标"都是空/null/0/-1 时，才算无意义。
 * 例外：activeKilocalories/highlyActiveSeconds/activeSeconds/floorsAscendedMeters
 *       这几个即使=0 也算"无意义"，因为"整天0活动"和"没记录"对用户没区别。
 */
export function isEmptyDailyPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true
  const s = raw as Record<string, unknown>
  // 各个字段"有意义值"的判定函数
  const num = (v: unknown) => typeof v === 'number' && v > 0
  const truthy = (v: unknown) => v != null && v !== '' && v !== false
  // 心率真采样：min ≠ max（真采样的心率一定有波动，min=75 max=75 是 Garmin 默认值/未采样）
  const hasRealHeartRate =
    typeof s.minHeartRate === 'number' &&
    typeof s.maxHeartRate === 'number' &&
    s.minHeartRate > 0 &&
    s.maxHeartRate > 0 &&
    s.minHeartRate !== s.maxHeartRate
  // 整天没动 = activeSeconds=0 && highlyActiveSeconds=0 && activeKilocalories=0
  // 这种情况下 bodyBattery 等手表自算字段不能反映用户健康状态
  const allDayInactive =
    (s.activeSeconds === 0 || s.activeSeconds == null) &&
    (s.highlyActiveSeconds === 0 || s.highlyActiveSeconds == null) &&
    (s.activeKilocalories === 0 || s.activeKilocalories == null) &&
    !num(s.totalSteps)  // 步数也是 0/null（确认没动）
  // 整天没动时，要求"非手表自算"的健康指标至少一个有意义
  if (allDayInactive) {
    return !(
      hasRealHeartRate ||
      num(s.averageStressLevel) ||
      num(s.maxStressLevel) ||
      num(s.restingHeartRate) ||
      truthy(s.dailySleepDTO) ||
      truthy(s.hrv) ||
      truthy(s.readiness) ||
      truthy(s.stressQualifier && s.stressQualifier !== 'UNKNOWN')
    )
  }
  // 任一字段有"真值" → 不算空
  return !(
    num(s.totalSteps) ||
    num(s.totalDistanceMeters) ||
    num(s.activeKilocalories) ||
    num(s.highlyActiveSeconds) ||
    num(s.activeSeconds) ||
    num(s.floorsAscendedInMeters) ||
    num(s.restingHeartRate) ||
    num(s.bodyBatteryMostRecentValue) ||
    num(s.averageStressLevel) ||      // > 0 才算（-1/0 是 UNKNOWN 占位）
    num(s.maxStressLevel) ||
    hasRealHeartRate ||               // 心率必须 min ≠ max 才算真采样
    truthy(s.dailySleepDTO) ||
    truthy(s.hrv) ||
    truthy(s.readiness) ||
    truthy(s.stressQualifier && s.stressQualifier !== 'UNKNOWN')
  )
}

/**
 * 合并 5 个单日端点的响应到一个 raw 对象，模拟 Garmin 完整 daily 的嵌套结构。
 * 这样 toDailyRecord 可以不用改 —— sleep/hrv/readiness/training 端点返回的字段
 * 会被嵌入到 daily 响应的 dailySleepDTO/hrv/readiness 嵌套里。
 */
function mergeDailyRaws(
  dailyRaw: unknown,
  hrvRaw: unknown,
  readinessRaw: unknown,
  trainingRaw: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  // daily 端点返回顶层字段 + 内嵌 dailySleepDTO（步数/心率/BB/压力/睡眠分层/睡眠分等）
  // 实测 CN 账号 daily 端点已经返回完整 dailySleepDTO，不需要再调独立 sleep 端点
  if (dailyRaw && typeof dailyRaw === 'object') {
    Object.assign(merged, dailyRaw as Record<string, unknown>)
  }
  // HRV/readiness 端点**已停用**（用户决定不存这些数据）—— 参数 hrvRaw/readinessRaw 保留但不使用
  // training 字段可能跟 daily 顶层有重叠，保留原始 daily 字段优先，不强制合并
  return merged
}

export function toDailyRecord(date: string, raw: unknown): DailyRecord {
  const s = raw as Record<string, unknown>
  // CN daily 健康数据字段在顶层（不是 userSummary 里）
  const sleepDto = s.dailySleepDTO as
    | {
        sleepTimeSeconds?: number
        sleepScores?: { overall?: { value?: number } }
        // 睡眠分期（Garmin 返回的字段名是 camelCase）
        deepSleepSeconds?: number
        lightSleepSeconds?: number
        remSleepSeconds?: number
        awakeSleepSeconds?: number
        awakeCount?: number
        napTimeSeconds?: number
        // 睡眠血氧（如果设备支持）
        averageSpO2?: number
        lowestSpO2?: number
      }
    | undefined
  // HRV/readiness 字段已停用（用户决定不存这些数据）—— 类型不再引用 s.hrv / s.readiness
  // const hrv = s.hrv as { status?: string; weeklyAverage?: number } | undefined
  // const readiness = Array.isArray(s.readiness)
  //   ? (s.readiness[0] as { score?: number } | undefined)
  //   : (s.readiness as { score?: number } | undefined)

  return {
    date,
    // 健康数据（CN 顶层字段）
    steps: s.totalSteps as number | undefined,
    distanceMeters: s.totalDistanceMeters as number | undefined,
    activeKilocalories: s.activeKilocalories as number | undefined,
    restingHeartRate: s.restingHeartRate as number | undefined,
    bodyBattery: s.bodyBatteryMostRecentValue as number | undefined,
    stressAvg: s.averageStressLevel as number | undefined,
    maxStressLevel: s.maxStressLevel as number | undefined,
    stressQualifier: s.stressQualifier as string | undefined,
    // 活动强度
    highlyActiveSeconds: s.highlyActiveSeconds as number | undefined,
    activeSeconds: s.activeSeconds as number | undefined,
    sedentarySeconds: s.sedentarySeconds as number | undefined,
    // 心率（不存 avgHeartRate：Garmin 没直接给全天平均，旧代码用 minAvgHeartRate 是错的——
    // 它是"最低活动段"平均，不是全天均值）
    minHeartRate: s.minHeartRate as number | undefined,
    maxHeartRate: s.maxHeartRate as number | undefined,
    // 楼层
    floorsAscendedMeters: s.floorsAscendedInMeters as number | undefined,
    // 睡眠
    // daily 端点顶层有 sleepingSeconds（CN 端点），sleep 端点 dailySleepDTO 嵌套有 sleepTimeSeconds
    // 两个值通常一致，优先取 sleep 端点（更准，含完整分期信息）
    sleepSeconds: sleepDto?.sleepTimeSeconds ?? (s.sleepingSeconds as number | undefined),
    sleepScore: sleepDto?.sleepScores?.overall?.value,
    // 睡眠分期
    deepSleepSeconds: sleepDto?.deepSleepSeconds,
    lightSleepSeconds: sleepDto?.lightSleepSeconds,
    remSleepSeconds: sleepDto?.remSleepSeconds,
    awakeSleepSeconds: sleepDto?.awakeSleepSeconds,
    awakeCount: sleepDto?.awakeCount,
    napSeconds: sleepDto?.napTimeSeconds,
    // 睡眠血氧
    averageSpO2: sleepDto?.averageSpO2,
    lowestSpO2: sleepDto?.lowestSpO2,
    // HRV
    // HRV/readiness 字段已停用（用户决定不存这些数据）
    // 原始载荷
    raw: s,
  }
}

/**
 * 执行一次同步。
 *
 * 流程：
 *  1. 拉最近 N 天活动列表
 *  2. 过滤运动类型
 *  3. 转 ActivityRecord → 去重落库
 *  4. 拉每日健康 → 落库
 *  5. 更新 lastSyncAt
 */
export async function syncGarmin(opts: SyncOptions): Promise<SyncResult> {
  const { sportFilter, store, queries } = opts
  // 防御性截断（L3）：days 超出硬上限（SYNC_DAYS_BACK_MAX=30）一律夹到上限并 warn，
  // 防止 settings 文件被改坏、或外部绕过 schema 时把 Garmin 服务器拉爆。
  // （活动端点支持区间一次拉取，健康端点每天一次调用，是 N 次循环 —— N 必须有上限）
  const rawDays = opts.days ?? SYNC_DAYS_BACK_MAX
  const days = Math.min(Math.max(1, rawDays), SYNC_DAYS_BACK_MAX)
  if (rawDays !== days) {
    logger.warn('sync', `days=${rawDays} 超出上限 ${SYNC_DAYS_BACK_MAX}，已截断为 ${days}`)
  }
  // 增量同步：按 activityId 去重 upsert，天然幂等，无需备份。
  // 全量同步才需要备份（覆盖大量数据时存在中间态风险）。
  try {
    // ⚠️ 用本地日期：toISOString() 返回 UTC，对中国时区会"少 8 小时"，导致跨 0 点时算错日期
    const to = localDateStr(new Date())

    // 增量同步：从上次同步日期（含）之后开始
    //  - 首次同步（无 lastSyncAt）→ 拉最近 days 天
    //  - 后续同步 → 从 lastSyncAt 日期开始到今日（避免重复拉全量）
    // 用 readMetaOnly 不加载 activities（sync 只关心 meta + daily）
    const storeData = await store.readMetaOnly()
    let from: string
    let effectiveDays: number
    const lastSync = storeData.lastSyncAt ? storeData.lastSyncAt.slice(0, 10) : ''
    if (lastSync) {
      // 从上次同步日期的前一天开始（留余量，防止边界漏数据），但不早于 days 天前
      // ⚠️ 用 localDate() 避免 UTC 解析
      const lastSyncDate = localDate(lastSync)
      const dayBefore = new Date(lastSyncDate)
      dayBefore.setDate(lastSyncDate.getDate() - 1)
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days + 1)
      // 取较晚者：dayBefore 或 days 天前的 cutoff（保证至少回看 days 天）
      const fromDate = dayBefore > cutoff ? dayBefore : cutoff
      from = localDateStr(fromDate)
      effectiveDays = Math.ceil((localDate(to).getTime() - localDate(from).getTime()) / 86400000) + 1
      // 详细 debug 日志（包含所有决定因素）
      logger.info('sync', `增量同步 ${from} ~ ${to}（lastSync=${lastSync}, days=${days}, effectiveDays=${effectiveDays}, dayBefore=${localDateStr(dayBefore)}, cutoff=${localDateStr(cutoff)}）`)
    } else {
      // 首次：拉最近 days 天（用本地日期）
      const start = new Date()
      start.setDate(start.getDate() - days + 1)
      from = localDateStr(start)
      effectiveDays = days
      logger.info('sync', `首次同步 ${from} ~ ${to}（最近 ${days} 天）`)
    }

    // 1. 拉活动
    const rawActivities = (await queries.activities({ from, to, limit: 200 })) as unknown[]
    const activities = rawActivities
      .map((a) => toActivityRecord(a))
      .filter((a): a is ActivityRecord => a !== null)

    // 2. 运动类型筛选
    const effectiveFilter =
      sportFilter && sportFilter.length > 0 ? sportFilter : null
    const filtered = effectiveFilter
      ? activities.filter((a) => effectiveFilter.includes(a.sport))
      : activities

    // 3. 去重落库
    const added = await store.upsertActivities(filtered)
    logger.info('sync', `活动：共 ${activities.length} 条，筛选后 ${filtered.length} 条，新增 ${added} 条`)

    // 4. 拉每日健康（遍历增量窗口）
    let dailiesAdded = 0
    const dailies: DailyRecord[] = []
    // 用本地日期循环（不用 toISOString，否则会 UTC 偏移到前一天/后一天）
    const startD = localDate(from)
    for (let i = 0; i < effectiveDays; i++) {
      const d = new Date(startD)
      d.setDate(startD.getDate() + i)
      const dateStr = localDateStr(d)
      if (dateStr > to) break
      try {
        // daily 是核心数据（必等入库）；training 是"加分项"，异步拉取后入库
        // HRV/readiness 端点**不再调用**——用户主动选择不要这些数据
        // 之前 Promise.all 等 4 个端点 = 总耗时 = max(所有端点)
        // 现在 daily 立刻用，training 后台入库 = 同步耗时 ≈ daily 耗时
        const dailyRaw = await queries.daily(dateStr).catch(() => null)
        // 异步补全 training（不阻塞主流程，UI 不等）
        // 注：HRV/readiness 端点**已不调用**（用户决定不存这些数据）
        const extrasPromise = Promise.all([
          queries.training(dateStr).catch(() => null),
        ]).then(async ([trainingRaw]) => {
          // 读已入库的 daily（可能没入库，isEmpty=true 时就没入）
          const existing = await store.readMetaOnly()
          const prev = existing.daily[dateStr]
          if (!prev) return // 当天没入库，跳过补全
          const merged = mergeDailyRaws(dailyRaw, null, null, trainingRaw)
          // 保持原有 daily 字段，只补 training 字段
          await store.upsertDaily({
            ...prev,
          })
          logger.debug('sync', `${dateStr} training 补全完成`)
        }).catch((e) => {
          logger.warn('sync', `${dateStr} training 补全失败: ${(e as Error).message}`)
        })
        void extrasPromise // fire-and-forget，不 await
        // daily 单独入库（不等 training）
        const mergedDaily = mergeDailyRaws(dailyRaw, null, null, null) // 只用 daily 字段
        // 调试日志
        logger.debug('sync', `${dateStr} 端点返回: daily=${dailyRaw ? '✓' : '✗'} (hrv/readiness/training 异步补全)`)
        // 过滤空 payload
        const isEmpty = isEmptyDailyPayload(mergedDaily)
        if (isEmpty) {
          logger.info('sync', `${dateStr} daily 被过滤（isEmpty=true）`)
        }
        if (!isEmpty) {
          dailies.push(toDailyRecord(dateStr, mergedDaily))
        }
      } catch {
        // 某天 API 整体报错，跳过
      }
    }
    if (dailies.length > 0) {
      await store.upsertDailies(dailies)
      dailiesAdded = dailies.length
    }
    logger.info('sync', `每日健康：落库 ${dailiesAdded} 条`)

    // 5. 更新游标（记录本次同步日期）—— 用本地时间 ISO（避免 UTC 偏移）
    await store.setSyncMeta(tsLocal(new Date()), effectiveDays)

    // 用 readActivities 拿活动总数（不读 daily）
    const activitiesMap = await store.readActivities()
    const sportsSeen = [...new Set(filtered.map((a) => a.sport))]

    return {
      synced: true,
      activitiesAdded: added,
      activitiesTotal: Object.keys(activitiesMap).length,
      dailiesAdded,
      sportsSeen,
    }
  } catch (e) {
    logger.error('sync', '同步失败', e)
    return {
      synced: false,
      activitiesAdded: 0,
      activitiesTotal: 0,
      dailiesAdded: 0,
      sportsSeen: [],
      error: e instanceof Error ? e.message : String(e),
    }
  }
}


/**
 * 全量同步活动（不拉健康数据）。
 *
 * 从用户指定起始日期到今日，按 WINDOW_DAYS（100 天）为一个窗口分批拉取：
 *   - 每窗口拉一次 activities（limit 200）
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 窗口间固定间隔 sleepMs（默认 1200ms）防 Garmin 429 风控
 *   - 遇 429 立即停止并返回已处理进度（断点续传）
 */
export async function syncAllActivities(
  store: GarminStoreFile,
  queries: GarminQueries,
  opts: {
    from: string
    windowDays?: number
    sleepMs?: number
    resume?: boolean
    /** 进度回调（后台任务用） */
    onProgress?: (p: FullSyncProgress) => void
  },
): Promise<{
  synced: boolean
  activitiesAdded: number
  activitiesTotal: number
  processedWindows: number
  totalWindows: number
  cursor: string
  error?: string
}> {
  const WINDOW_DAYS = opts.windowDays ?? 100
  const SLEEP_MS = opts.sleepMs ?? 2000

  const fromDate = localDate(opts.from)
  if (Number.isNaN(fromDate.getTime())) {
    return { synced: false, activitiesAdded: 0, activitiesTotal: 0, processedWindows: 0, totalWindows: 0, cursor: opts.from, error: '无效的起始日期' }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const totalDays = Math.max(1, Math.ceil((today.getTime() - fromDate.getTime()) / 86400000))
  const totalWindows = Math.ceil(totalDays / WINDOW_DAYS)

  const prevCursor = opts.resume ? (await store.loadSyncCursor?.() ?? opts.from) : opts.from
  let curDate = localDate(prevCursor)

  let added = 0
  let processed = 0
  let lastCursor = prevCursor

  // 随机 1~3 秒间隔（避免固定节奏触发 Garmin 行为指纹检测）
  const randomSleep = () => new Promise((res) => {
    const ms = 1000 + Math.floor(Math.random() * 2001)
    setTimeout(res, ms)
  })

  // 安全网：全量同步前备份 garmin.json（成功删备份，失败/异常恢复）
  // 增量同步按 activityId 去重 upsert，无需备份；全量覆盖大量数据才有中间态风险。
  let backupPath = ''
  if (!opts.resume) {
    try {
      const dataPath = dataFilePath()
      backupPath = dataPath + '.bak.' + Date.now()
      const { copyFile } = await import('node:fs/promises')
      await copyFile(dataPath, backupPath)
      logger.info('syncAll', '已备份数据到 ' + backupPath)
    } catch (e) {
      logger.warn('syncAll', '备份失败（继续同步）: ' + (e as Error).message)
    }
  }

  const cleanupBackup = async () => {
    if (backupPath) {
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(backupPath)
        logger.info('syncAll', '同步成功，已清理备份 ' + backupPath)
      } catch (e) {
        logger.error('syncAll', '清理备份失败: ' + (e as Error).message)
      }
    }
  }

  const restoreBackup = async () => {
    if (backupPath) {
      try {
        const { copyFile, unlink } = await import('node:fs/promises')
        const dataPath = dataFilePath()
        await copyFile(backupPath, dataPath)
        await unlink(backupPath)
        logger.error('syncAll', '同步失败，已从备份恢复 ' + backupPath)
      } catch (be) {
        logger.error('syncAll', '恢复备份失败: ' + (be as Error).message)
      }
    }
  }

  try {
    for (let w = 0; w < totalWindows; w++) {
      if (curDate.getTime() > today.getTime()) break
      const winStart = localDateStr(curDate)
      const winEndDate = new Date(curDate)
      winEndDate.setDate(curDate.getDate() + WINDOW_DAYS - 1)
      if (winEndDate.getTime() > today.getTime()) winEndDate.setTime(today.getTime())
      const winEnd = localDateStr(winEndDate)

      // 进度回调（供后台任务 + 前端轮询）
      if (opts.onProgress) {
        opts.onProgress({ processed: w, total: totalWindows, status: 'running', cursor: winStart })
      }

      try {
        const raw = (await queries.activities({ from: winStart, to: winEnd, limit: 200 })) as unknown[]
        const acts = raw
          .map((a) => toActivityRecord(a))
          .filter((a): a is ActivityRecord => a !== null)
        const n = await store.upsertActivities(acts)
        added += n
      } catch (e) {
        if (String((e as Error).message).includes('429')) {
          await store.saveSyncCursor?.(lastCursor)
          await cleanupBackup()
          if (opts.onProgress) opts.onProgress({ processed: w, total: totalWindows, status: 'paused', cursor: lastCursor, error: '触发 Garmin 429 限流，已保存进度，请 30 分钟后从断点续拉' })
          return {
            synced: false, activitiesAdded: added,
            activitiesTotal: Object.keys((await store.readActivities())).length,
            processedWindows: processed, totalWindows,
            cursor: lastCursor,
            error: '触发 Garmin 429 限流，已保存进度，请 30 分钟后从断点续拉',
          }
        }
        logger.warn('syncAll', '窗口拉取失败: ' + (e as Error).message)
      }

      processed++
      lastCursor = winStart
      if (w < totalWindows - 1) {
        await randomSleep()
      }
      await store.saveSyncCursor?.(winStart)
      // 推进到下一个窗口起点
      curDate.setDate(curDate.getDate() + WINDOW_DAYS)
    }

    await store.saveSyncCursor?.('')
    const total = Object.keys((await store.readActivities())).length
    await cleanupBackup()
    if (opts.onProgress) opts.onProgress({ processed: totalWindows, total: totalWindows, status: 'done', cursor: lastCursor })
    return { synced: true, activitiesAdded: added, activitiesTotal: total, processedWindows: processed, totalWindows, cursor: lastCursor }
  } catch (e) {
    await restoreBackup()
    if (opts.onProgress) opts.onProgress({ processed: processed, total: totalWindows, status: 'error', cursor: lastCursor, error: (e as Error).message })
    return { synced: false, activitiesAdded: added, activitiesTotal: 0, processedWindows: processed, totalWindows, cursor: lastCursor, error: (e as Error).message }
  }
}
