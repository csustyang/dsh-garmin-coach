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
    avgCadence?: number;
    trainingEffect?: number;
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
    constructor(opts?: GarminStoreOptions);
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
