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
    avgHeartRate?: number;
    floorsAscendedMeters?: number;
    sleepSeconds?: number;
    sleepScore?: number;
    hrvStatus?: string;
    hrvWeeklyAvg?: number;
    readinessScore?: number;
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
export interface GarminStoreOptions {
    /** 数据目录；缺省用 <cwd>/data */
    dataDir?: string;
}
/**
 * GarminStoreFile —— JSON 文件实现。
 * 后期换 PostgreSQL 时实现同名接口即可。
 */
export declare class GarminStoreFile {
    private readonly filePath;
    private cache;
    /** 缓存权限检查结果（一次检查后所有写操作都用）*/
    private _permChecked;
    private _permOk;
    constructor(opts?: GarminStoreOptions);
    /**
     * 检查写权限（一次性，缓存结果）
     *
     * DSH 沙箱默认没 full access 权限时，写入会失败但错误信息不明确。
     * 这里用写一个临时文件来探测，失败时抛友好错误告诉用户怎么修。
     */
    checkPermission(): Promise<void>;
    private permissionErrorMessage;
    /** 读（带内存缓存，避免频繁磁盘 IO）*/
    read(): Promise<GarminStore>;
    /** 原子写 */
    write(store: GarminStore): Promise<void>;
    /**
     * 更新：读→改→写（带重试，避免并发冲突）
     */
    mutate<T>(fn: (store: GarminStore) => T | Promise<T>): Promise<T>;
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
