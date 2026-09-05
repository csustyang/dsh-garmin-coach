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
 *   "syncDaysBack": 30
 * }
 *
 * 设计：
 *  - 原子写（临时文件 + rename），防崩溃损坏
 *  - activities 用对象以 activityId 为 key → 天然去重
 *  - 后期升级 PostgreSQL 时，只需替换本文件的读写实现，
 *    上层查询引擎接口不变。
 */
export interface ActivityRecord {
    activityId: string;
    activityName: string;
    sport: string;
    startTime: string;
    durationSec: number;
    distanceMeters: number;
    avgPaceSecPerKm?: number;
    avgSpeedMps?: number;
    avgHr?: number;
    maxHr?: number;
    calories?: number;
    elevationGainMeters?: number;
    /** 累计下降（米）*/
    elevationLossMeters?: number;
    avgCadence?: number;
    /** 最高步频（步/分）*/
    maxCadence?: number;
    trainingEffect?: number;
    /** 是否个人纪录（PR）*/
    isPR?: boolean;
    /** 最佳配速（秒/km，由 maxSpeed 换算）*/
    bestPaceSecPerKm?: number;
    /** 平均垂直摆动（cm）*/
    verticalOscillationCm?: number;
    /** 平均步长（cm）*/
    strideLengthCm?: number;
    /** 平均垂直步幅比（%）*/
    verticalRatioPct?: number;
    /** 平均坡度调整配速（m/s → 秒/km）*/
    gradeAdjustedPaceSecPerKm?: number;
    /** 最大摄氧量 VO2max（ml/kg/min）*/
    vO2Max?: number;
    /** 平均触地时间（ms）*/
    groundContactTimeMs?: number;
    /** 无氧训练效果（分数）*/
    anaerobicEffect?: number;
    /** 训练负荷 */
    trainingLoad?: number;
    /** 平均功率（W）*/
    avgPower?: number;
    /** 最大功率（W）*/
    maxPower?: number;
    /** 标准化功率（W）*/
    normPower?: number;
    /** 中等强度时长（分钟）*/
    moderateMinutes?: number;
    /** 高强度时长（分钟）*/
    vigorousMinutes?: number;
    /** 最低温度（℃）*/
    minTemperature?: number;
    /** 最高温度（℃）*/
    maxTemperature?: number;
    /** 最大速度（m/s）*/
    maxSpeed?: number;
    /** 移动时间（秒）*/
    movingDuration?: number;
    /** 全程耗时（秒）*/
    elapsedDuration?: number;
    /** 最低海拔（m）*/
    minElevation?: number;
    /** 最高海拔（m）*/
    maxElevation?: number;
    /** 基础代谢热量（千卡）*/
    bmrCalories?: number;
    /** 原始 Garmin 载荷，备用 */
    raw?: unknown;
}
export interface DailyRecord {
    date: string;
    steps?: number;
    distanceMeters?: number;
    activeKilocalories?: number;
    restingHeartRate?: number;
    bodyBattery?: number;
    stressAvg?: number;
    maxStressLevel?: number;
    stressQualifier?: string;
    highlyActiveSeconds?: number;
    activeSeconds?: number;
    sedentarySeconds?: number;
    minHeartRate?: number;
    maxHeartRate?: number;
    floorsAscendedMeters?: number;
    sleepSeconds?: number;
    sleepScore?: number;
    deepSleepSeconds?: number;
    lightSleepSeconds?: number;
    remSleepSeconds?: number;
    awakeSleepSeconds?: number;
    awakeCount?: number;
    napSeconds?: number;
    averageSpO2?: number;
    lowestSpO2?: number;
    sleepAvgHeartRate?: number;
    avgRespiration?: number;
    lowestRespiration?: number;
    avgOvernightHrv?: number;
    raw?: unknown;
}
export interface GarminStore {
    version: number;
    lastSyncAt: string;
    activities: Record<string, ActivityRecord>;
    daily: Record<string, DailyRecord>;
    sportFilter: string[];
    syncDaysBack: number;
    /** 全量同步断点游标（上次拉到的起始日期，空=无进行中）*/
    fullSyncCursor?: string;
}
/** 同步回看天数的硬上限（防 Garmin 服务器过载）*/
export declare const SYNC_DAYS_BACK_MAX = 30;
/** 全量同步默认起点：距今天数（防新用户点全量同步时直接拉 4+ 年把 Garmin 拉爆）*/
export declare const FULL_SYNC_DEFAULT_DAYS = 90;
export interface GarminStoreOptions {
    /** 数据目录；缺省用 <cwd>/data */
    dataDir?: string;
}
/**
 * GarminStoreFile —— JSON 文件实现。
 * 后期换 PostgreSQL 时实现同名接口即可。
 */
export declare class GarminStoreFile {
    private readonly dataDir;
    private readonly metaPath;
    private readonly activitiesPath;
    private cache;
    private activitiesCache;
    /** 缓存权限检查结果（一次检查后所有写操作都用）*/
    private _permChecked;
    private _permOk;
    /**
     * 写锁（meta/activities 共享同一把锁）
     * 串行化所有 mutate 操作，避免并发 read-modify-write 竞争：
     *  - sync.ts 主循环批量 upsertDailies（串行 await，已安全）
     *  - sync.ts 训练补全 fire-and-forget 的 upsertDaily（**异步触发**，会和主循环 mutateMeta 撞车）
     *  - syncOnConnect 末尾的 lastSyncAt 更新
     * 串行后所有 mutateMeta 按顺序执行，read 永远看到上一个写完的状态。
     */
    private writeLock;
    constructor(opts?: GarminStoreOptions);
    /**
     * 检查写权限（一次性，缓存结果）
     *
     * DSH 沙箱默认没 full access 权限时，写入会失败但错误信息不明确。
     * 这里用写一个临时文件来探测，失败时抛友好错误告诉用户怎么修。
     */
    checkPermission(): Promise<void>;
    private permissionErrorMessage;
    /**
     * 读（兼容旧 API：返回完整 store，包括 activities）。
     * 如果存在旧单一 garmin.json，自动迁移到拆 3 文件结构。
     *
     * ⚠️ 注意：为了向后兼容 stats.ts 大量使用 `data.activities`，本方法会同时加载 activities。
     * 如果只要 meta + daily（启动快），用 readMetaOnly()。
     */
    read(): Promise<GarminStore>;
    /**
     * 只读 meta + daily（不加载 activities）。
     * 适合 syncGarmin / dashboardSummary 等只需要元数据的场景。
     * 启动成本从 ~2.5 MB 降到 ~300 KB（实际数据量决定）。
     */
    readMetaOnly(): Promise<GarminStore>;
    /** 内部：读 meta 文件原始内容（含 daily）*/
    private readMetaRaw;
    /**
     * 加载 activities（懒加载，缓存）。
     * 任何用 activities 的函数（dashboard/recentActivities/sportBreakdown）都要先调这个。
     */
    readActivities(): Promise<Record<string, ActivityRecord>>;
    /** 缓存的 activities 是否已加载（read() 时 activities 永远是空对象）*/
    hasActivitiesLoaded(): boolean;
    /** 失效 activities 缓存（写后） */
    private invalidateActivitiesCache;
    /**
     * 迁移：旧版单一 garmin.json → meta + activities 两个文件
     * 只在第一次 read()/readActivities() 时跑一次（用文件存在性作 marker）
     */
    private migrateFromLegacyIfNeeded;
    private get legacyFilePath();
    private fileExists;
    /**
     * 把异步操作串行化（防止并发 mutate 撞车导致 ENOENT/数据丢失）
     * 用法：return this.withLock(async () => { ... await mutate ... })
     */
    private withLock;
    /**
     * 原子写 meta（version/lastSyncAt/daily/sportFilter/syncDaysBack/fullSyncCursor）
     * 不含 activities（见 writeActivitiesAtomic）。
     * 走 writeLock 串行化（避免并发写入 tmp 文件导致 rename ENOENT）
     */
    private writeMetaAtomic;
    /** 原子写 activities（独立文件），也走 writeLock */
    private writeActivitiesAtomic;
    /** 原子写 */
    write(store: GarminStore): Promise<void>;
    /**
     * 更新：读→改→写（带重试，避免并发冲突）
     * 重要：传入的 fn 应该只动 meta + daily（activities 走专门路径）。
     * fn 改 store.activities 不影响最终落盘（write 走 store.activities 当前缓存）。
     */
    mutate<T>(fn: (store: GarminStore) => T | Promise<T>): Promise<T>;
    /**
     * 只更新 meta + daily（不读不写 activities）—— 大多数 mutate 路径走这个。
     * 比 mutate() 快（不需要加载 activities 文件）。
     */
    mutateMeta<T>(fn: (store: GarminStore) => T | Promise<T>): Promise<T>;
    /** 落库一条活动（按 activityId 去重）*/
    upsertActivity(activity: ActivityRecord): Promise<boolean>;
    /** 批量落库活动，返回新增数量 */
    upsertActivities(activities: ActivityRecord[]): Promise<number>;
    /** 落库每日健康 */
    upsertDaily(daily: DailyRecord): Promise<void>;
    /** 批量落库每日健康 */
    upsertDailies(dailies: DailyRecord[]): Promise<void>;
    /** 更新同步游标 */
    setSyncMeta(lastSyncAt: string, syncDaysBack: number): Promise<void>;
    /** 全量同步断点游标：读取 */
    loadSyncCursor(): Promise<string>;
    /** 全量同步断点游标：保存（空串=清除）*/
    saveSyncCursor(cursor: string): Promise<void>;
    /** 设置运动类型筛选 */
    setSportFilter(sports: string[]): Promise<void>;
    /** 清空（用于测试或用户重置）*/
    clear(): Promise<void>;
    private get planPath();
    /** 读取训练计划缓存 */
    loadTrainingPlan(): Promise<TrainingPlanCache | null>;
    /** 保存训练计划缓存 */
    saveTrainingPlan(plan: TrainingPlanCache): Promise<void>;
    /** 备份旧计划到 history 目录（带时间戳）*/
    private backupPlan;
    /** 列出计划历史 */
    listPlanHistory(): Promise<Array<{
        file: string;
        time: string;
        goal: string;
        tasks: number;
        done: number;
    }>>;
    /** 从历史恢复一个计划 */
    restorePlan(file: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** 打卡：切换某个训练任务的完成状态 */
    toggleTask(taskId: string): Promise<{
        ok: boolean;
        task?: TrainingTask;
        message?: string;
    }>;
    /** 统计打卡进度 */
    planProgress(): Promise<{
        done: number;
        total: number;
    }>;
    /** 清除训练计划缓存 */
    clearTrainingPlan(): Promise<void>;
    private get diaryPath();
    /** 读取全部日记（按日期倒序）*/
    loadDiary(): Promise<DiaryEntry[]>;
    /** 添加一条日记 */
    addDiaryEntry(entry: DiaryEntry): Promise<DiaryEntry>;
    /** 删除一条日记 */
    removeDiaryEntry(id: string): Promise<{
        ok: boolean;
    }>;
    /** 写日记到磁盘 */
    private writeDiary;
}
/** 训练日记条目 */
export interface DiaryEntry {
    id: string;
    date: string;
    /** 关联训练任务 id（可选）*/
    taskId?: string;
    /** 任务描述快照（如"有氧慢跑 6km"）*/
    taskLabel?: string;
    /** 训练感受 */
    feeling: string;
    /** 1-5 星 */
    rating?: number;
    createdAt: string;
}
/** 训练计划缓存结构 */
export interface TrainingTask {
    id: string;
    week: number;
    day: string;
    type: string;
    detail: string;
    done: boolean;
}
export interface TrainingPlanCache {
    goal: string;
    baselineFingerprint: string;
    generatedAt: string;
    weeks: number;
    daysPerWeek: number;
    plan: string;
    tips: string[];
    /** 结构化训练任务（供打卡）*/
    tasks: TrainingTask[];
}
/** 数据文件路径（给用户/日志看）*/
export declare function dataFilePath(dataDir?: string): string;
