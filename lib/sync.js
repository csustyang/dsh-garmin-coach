/**
 * Garmin 数据同步服务。
 *
 * 职责：
 *   - 从 Garmin API 拉活动 + 每日健康
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 按运动类型筛选
 *   - 记录同步游标（lastSyncAt）
 */
import { dataFilePath } from './storage.js';
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
        isPR: typeof a.isPR === 'boolean' ? a.isPR : undefined,
        elevationLossMeters: typeof a.elevationLoss === 'number' ? a.elevationLoss : undefined,
        maxCadence: typeof a.maxRunningCadenceInStepsPerMinute === 'number'
            ? a.maxRunningCadenceInStepsPerMinute
            : undefined,
        verticalOscillationCm: typeof a.avgVerticalOscillation === 'number'
            ? a.avgVerticalOscillation
            : undefined,
        strideLengthCm: typeof a.avgStrideLength === 'number' ? a.avgStrideLength : undefined,
        verticalRatioPct: typeof a.avgVerticalRatio === 'number' ? a.avgVerticalRatio : undefined,
        // 平均坡度调整配速：avgGradeAdjustedSpeed (m/s) → 秒/km
        gradeAdjustedPaceSecPerKm: typeof a.avgGradeAdjustedSpeed === 'number' && a.avgGradeAdjustedSpeed > 0
            ? Math.round(1000 / a.avgGradeAdjustedSpeed)
            : undefined,
        // 最佳配速：maxSpeed (m/s) → 秒/km
        bestPaceSecPerKm: typeof a.maxSpeed === 'number' && a.maxSpeed > 0
            ? Math.round(1000 / a.maxSpeed)
            : undefined,
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
    // 安全网：同步前备份 garmin.json（成功删备份，失败恢复）
    let backupPath = '';
    try {
        const dataPath = dataFilePath();
        backupPath = dataPath + '.bak.' + Date.now();
        const { copyFile } = await import('node:fs/promises');
        await copyFile(dataPath, backupPath);
        logger.info('sync', '已备份数据到 ' + backupPath);
    }
    catch (e) {
        logger.warn('sync', '备份失败（继续同步）: ' + e.message);
    }
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
        // 同步成功：清理备份
        if (backupPath) {
            try {
                const { unlink } = await import('node:fs/promises');
                await unlink(backupPath);
                logger.info('sync', '同步成功，已清理备份 ' + backupPath);
            }
            catch (e) {
                logger.error('sync', '清理备份失败: ' + e.message);
            }
        }
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
        // 同步失败：恢复备份（防止数据损坏）
        if (backupPath) {
            try {
                const { copyFile, unlink } = await import('node:fs/promises');
                const dataPath = dataFilePath();
                await copyFile(backupPath, dataPath);
                await unlink(backupPath);
                logger.error('sync', '同步失败，已从备份恢复 ' + backupPath);
            }
            catch (be) {
                logger.error('sync', '恢复备份失败: ' + be.message);
            }
        }
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
/**
 * 全量同步活动（不拉健康数据）。
 *
 * 从用户指定起始日期到今日，按 WINDOW_DAYS（100 天）为一个窗口分批拉取：
 *   - 每窗口拉一次 activities（limit 200）
 *   - 按 activityId 去重落库（重复同步不产生重复数据）
 *   - 窗口间固定间隔 sleepMs（默认 1200ms）防 Garmin 429 风控
 *   - 遇 429 立即停止并返回已处理进度（断点续传）
 */
export async function syncAllActivities(store, queries, opts) {
    const WINDOW_DAYS = opts.windowDays ?? 100;
    const SLEEP_MS = opts.sleepMs ?? 2000;
    const fromDate = new Date(opts.from + 'T00:00:00');
    if (Number.isNaN(fromDate.getTime())) {
        return { synced: false, activitiesAdded: 0, activitiesTotal: 0, processedWindows: 0, totalWindows: 0, cursor: opts.from, error: '无效的起始日期' };
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDays = Math.max(1, Math.ceil((today.getTime() - fromDate.getTime()) / 86400000));
    const totalWindows = Math.ceil(totalDays / WINDOW_DAYS);
    const prevCursor = opts.resume ? (await store.loadSyncCursor?.() ?? opts.from) : opts.from;
    let curDate = new Date(prevCursor + 'T00:00:00');
    let added = 0;
    let processed = 0;
    let lastCursor = prevCursor;
    // 随机 1~3 秒间隔（避免固定节奏触发 Garmin 行为指纹检测）
    const randomSleep = () => new Promise((res) => {
        const ms = 1000 + Math.floor(Math.random() * 2001);
        setTimeout(res, ms);
    });
    try {
        for (let w = 0; w < totalWindows; w++) {
            if (curDate.getTime() > today.getTime())
                break;
            const winStart = curDate.toISOString().slice(0, 10);
            const winEndDate = new Date(curDate);
            winEndDate.setDate(curDate.getDate() + WINDOW_DAYS - 1);
            if (winEndDate.getTime() > today.getTime())
                winEndDate.setTime(today.getTime());
            const winEnd = winEndDate.toISOString().slice(0, 10);
            // 进度回调（供后台任务 + 前端轮询）
            if (opts.onProgress) {
                opts.onProgress({ processed: w, total: totalWindows, status: 'running', cursor: winStart });
            }
            try {
                const raw = (await queries.activities({ from: winStart, to: winEnd, limit: 200 }));
                const acts = raw
                    .map((a) => toActivityRecord(a))
                    .filter((a) => a !== null);
                const n = await store.upsertActivities(acts);
                added += n;
            }
            catch (e) {
                if (String(e.message).includes('429')) {
                    await store.saveSyncCursor?.(lastCursor);
                    if (opts.onProgress)
                        opts.onProgress({ processed: w, total: totalWindows, status: 'paused', cursor: lastCursor, error: '触发 Garmin 429 限流，已保存进度，请 30 分钟后从断点续拉' });
                    return {
                        synced: false, activitiesAdded: added,
                        activitiesTotal: Object.keys((await store.read()).activities).length,
                        processedWindows: processed, totalWindows,
                        cursor: lastCursor,
                        error: '触发 Garmin 429 限流，已保存进度，请 30 分钟后从断点续拉',
                    };
                }
                logger.warn('syncAll', '窗口拉取失败: ' + e.message);
            }
            processed++;
            lastCursor = winStart;
            if (w < totalWindows - 1) {
                await randomSleep();
            }
            await store.saveSyncCursor?.(winStart);
            // 推进到下一个窗口起点
            curDate.setDate(curDate.getDate() + WINDOW_DAYS);
        }
        await store.saveSyncCursor?.('');
        const total = Object.keys((await store.read()).activities).length;
        if (opts.onProgress)
            opts.onProgress({ processed: totalWindows, total: totalWindows, status: 'done', cursor: lastCursor });
        return { synced: true, activitiesAdded: added, activitiesTotal: total, processedWindows: processed, totalWindows, cursor: lastCursor };
    }
    catch (e) {
        if (opts.onProgress)
            opts.onProgress({ processed: processed, total: totalWindows, status: 'error', cursor: lastCursor, error: e.message });
        return { synced: false, activitiesAdded: added, activitiesTotal: 0, processedWindows: processed, totalWindows, cursor: lastCursor, error: e.message };
    }
}
