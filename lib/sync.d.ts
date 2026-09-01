/**
 * Garmin 数据同步服务。
 *
 * 职责：
 *   - 从 Garmin API 拉活动 + 每日健康
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 按运动类型筛选
 *   - 记录同步游标（lastSyncAt）
 */
import type { GarminQueries } from './api/queries.js';
import type { ActivityRecord, DailyRecord, GarminStoreFile } from './storage.js';
/** 支持的常见运动类型（Garmin typeKey）*/
export declare const SUPPORTED_SPORTS: readonly ["running", "cycling", "swimming", "hiking", "walking", "trail_running", "mountain_biking", "strength_training", "other"];
export type SportKey = (typeof SUPPORTED_SPORTS)[number];
export interface SyncOptions {
    days?: number;
    sportFilter?: string[];
    store: GarminStoreFile;
    queries: GarminQueries;
}
/** 全量同步进度 */
export interface FullSyncProgress {
    processed: number;
    total: number;
    status: 'idle' | 'running' | 'paused' | 'done' | 'error';
    cursor?: string;
    error?: string;
}
export interface SyncResult {
    synced: boolean;
    activitiesAdded: number;
    activitiesTotal: number;
    dailiesAdded: number;
    sportsSeen: string[];
    error?: string;
}
/**
 * 把 Garmin 活动原始载荷转成 ActivityRecord。
 * 依据 ai-skill-garmin 返回的字段结构做映射。
 */
export declare function toActivityRecord(raw: unknown): ActivityRecord | null;
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
export declare function isEmptyDailyPayload(raw: unknown): boolean;
export declare function toDailyRecord(date: string, raw: unknown): DailyRecord;
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
export declare function syncGarmin(opts: SyncOptions): Promise<SyncResult>;
/**
 * 全量同步活动（不拉健康数据）。
 *
 * 从用户指定起始日期到今日，按 WINDOW_DAYS（100 天）为一个窗口分批拉取：
 *   - 每窗口拉一次 activities（limit 200）
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 窗口间固定间隔 sleepMs（默认 1200ms）防 Garmin 429 风控
 *   - 遇 429 立即停止并返回已处理进度（断点续传）
 */
export declare function syncAllActivities(store: GarminStoreFile, queries: GarminQueries, opts: {
    from: string;
    windowDays?: number;
    sleepMs?: number;
    resume?: boolean;
    /** 进度回调（后台任务用） */
    onProgress?: (p: FullSyncProgress) => void;
}): Promise<{
    synced: boolean;
    activitiesAdded: number;
    activitiesTotal: number;
    processedWindows: number;
    totalWindows: number;
    cursor: string;
    error?: string;
}>;
