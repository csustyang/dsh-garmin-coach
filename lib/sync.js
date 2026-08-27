/**
 * Garmin 数据同步服务。
 *
 * 职责：
 *   - 从 Garmin API 拉活动 + 每日健康
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 按运动类型筛选
 *   - 记录同步游标（lastSyncAt）
 */
import { logger } from './logger.js';
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
];
/**
 * 把 Garmin 活动原始载荷转成 ActivityRecord。
 * 依据 ai-skill-garmin 返回的字段结构做映射。
 */
export function toActivityRecord(raw) {
    const a = raw;
    if (!a || typeof a !== 'object')
        return null;
    const activityId = String(a.activityId ?? '');
    if (!activityId)
        return null;
    const activityType = a.activityType;
    const sport = String(activityType?.typeKey ?? a.sport ?? 'unknown');
    // 距离（米）
    const distanceMeters = typeof a.distance === 'number' ? a.distance : Number(a.distanceMeters ?? 0);
    // 时长（秒）
    const durationSec = typeof a.duration === 'number'
        ? a.duration
        : Number(a.durationInSeconds ?? 0);
    // 平均速度（m/s）→ 配速（秒/km）
    const avgSpeedMps = typeof a.averageSpeed === 'number'
        ? a.averageSpeed
        : Number(a.averageSpeedInMetersPerSecond ?? NaN);
    const avgPaceSecPerKm = Number.isFinite(avgSpeedMps) && avgSpeedMps > 0
        ? Math.round(1000 / avgSpeedMps)
        : undefined;
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
        elevationGainMeters: typeof a.elevationGain === 'number' ? a.elevationGain : undefined,
        avgCadence: typeof a.averageRunningCadenceInStepsPerMinute === 'number'
            ? a.averageRunningCadenceInStepsPerMinute
            : undefined,
        trainingEffect: typeof a.trainingEffect === 'number' ? a.trainingEffect : undefined,
        raw: a,
    };
}
/**
 * 把 Garmin 每日健康原始载荷转成 DailyRecord。
 */
export function toDailyRecord(date, raw) {
    const s = raw;
    // CN daily 健康数据字段在顶层（不是 userSummary 里）
    const sleepDto = s.dailySleepDTO;
    const hrv = s.hrv;
    const readiness = Array.isArray(s.readiness)
        ? s.readiness[0]
        : s.readiness;
    return {
        date,
        // 健康数据（CN 顶层字段）
        steps: s.totalSteps,
        distanceMeters: s.totalDistanceMeters,
        activeKilocalories: s.activeKilocalories,
        restingHeartRate: s.restingHeartRate,
        bodyBattery: s.bodyBatteryMostRecentValue,
        stressAvg: s.averageStressLevel,
        maxStressLevel: s.maxStressLevel,
        stressQualifier: s.stressQualifier,
        // 活动强度
        highlyActiveSeconds: s.highlyActiveSeconds,
        activeSeconds: s.activeSeconds,
        sedentarySeconds: s.sedentarySeconds,
        // 心率
        minHeartRate: s.minHeartRate,
        maxHeartRate: s.maxHeartRate,
        avgHeartRate: s.minAvgHeartRate, // CN 用 minAvgHeartRate 作平均
        // 楼层
        floorsAscendedMeters: s.floorsAscendedInMeters,
        // 睡眠
        sleepSeconds: sleepDto?.sleepTimeSeconds,
        sleepScore: sleepDto?.sleepScores?.overall?.value,
        // HRV
        hrvStatus: hrv?.status,
        hrvWeeklyAvg: hrv?.weeklyAverage,
        readinessScore: readiness?.score,
        // 原始载荷
        raw: s,
    };
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
export async function syncGarmin(opts) {
    const { days = 14, sportFilter, store, queries } = opts;
    try {
        const endDate = new Date();
        const to = endDate.toISOString().slice(0, 10);
        // 增量同步：从上次同步日期（含）之后开始
        //  - 首次同步（无 lastSyncAt）→ 拉最近 days 天
        //  - 后续同步 → 从 lastSyncAt 日期开始到今日（避免重复拉全量）
        const storeData = await store.read();
        let from;
        let effectiveDays;
        const lastSync = storeData.lastSyncAt ? storeData.lastSyncAt.slice(0, 10) : '';
        if (lastSync) {
            // 从上次同步日期的前一天开始（留余量，防止边界漏数据），但不早于 days 天前
            const lastSyncDate = new Date(lastSync + 'T00:00:00');
            const dayBefore = new Date(lastSyncDate);
            dayBefore.setDate(lastSyncDate.getDate() - 1);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days + 1);
            // 取较晚者：dayBefore 或 days 天前的 cutoff（保证至少回看 days 天）
            from = (dayBefore > cutoff ? dayBefore : cutoff).toISOString().slice(0, 10);
            effectiveDays = Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
            logger.info('sync', `增量同步 ${from} ~ ${to}（上次同步 ${lastSync}）`);
        }
        else {
            // 首次：拉最近 days 天
            const start = new Date(endDate);
            start.setDate(endDate.getDate() - days + 1);
            from = start.toISOString().slice(0, 10);
            effectiveDays = days;
            logger.info('sync', `首次同步 ${from} ~ ${to}（最近 ${days} 天）`);
        }
        // 1. 拉活动
        const rawActivities = (await queries.activities({ from, to, limit: 200 }));
        const activities = rawActivities
            .map((a) => toActivityRecord(a))
            .filter((a) => a !== null);
        // 2. 运动类型筛选
        const effectiveFilter = sportFilter && sportFilter.length > 0 ? sportFilter : null;
        const filtered = effectiveFilter
            ? activities.filter((a) => effectiveFilter.includes(a.sport))
            : activities;
        // 3. 去重落库
        const added = await store.upsertActivities(filtered);
        logger.info('sync', `活动：共 ${activities.length} 条，筛选后 ${filtered.length} 条，新增 ${added} 条`);
        // 4. 拉每日健康（遍历增量窗口）
        let dailiesAdded = 0;
        const dailies = [];
        const startD = new Date(from + 'T00:00:00');
        for (let i = 0; i < effectiveDays; i++) {
            const d = new Date(startD);
            d.setDate(startD.getDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            if (dateStr > to)
                break;
            try {
                const dailyRaw = await queries.daily(dateStr);
                dailies.push(toDailyRecord(dateStr, dailyRaw));
            }
            catch {
                // 某天无数据，跳过
            }
        }
        if (dailies.length > 0) {
            await store.upsertDailies(dailies);
            dailiesAdded = dailies.length;
        }
        logger.info('sync', `每日健康：落库 ${dailiesAdded} 条`);
        // 5. 更新游标（记录本次同步日期）
        await store.setSyncMeta(new Date().toISOString(), effectiveDays);
        const data = await store.read();
        const sportsSeen = [...new Set(filtered.map((a) => a.sport))];
        return {
            synced: true,
            activitiesAdded: added,
            activitiesTotal: Object.keys(data.activities).length,
            dailiesAdded,
            sportsSeen,
        };
    }
    catch (e) {
        logger.error('sync', '同步失败', e);
        return {
            synced: false,
            activitiesAdded: 0,
            activitiesTotal: 0,
            dailiesAdded: 0,
            sportsSeen: [],
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
