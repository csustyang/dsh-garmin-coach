/**
 * 统计查询工具 —— 基于已落库的 JSON 数据，JS 计算引擎返回精炼结果。
 *
 * 这些工具不实时调 Garmin API，只读本地 garmin.json，秒回。
 * 数据由同步工具（garmin_sync）填充。
 * 用官方 defineTool 注册。
 */
import * as stats from '../stats.js';
import { defineGarminTool } from './helpers.js';
/**
 * 构建统计工具集（registry-ready defineTool 结果）。
 */
export function defineStatsTools(ctx) {
    const store = ctx.store;
    return [
        defineGarminTool({
            name: 'garmin_sync',
            description: '从 Garmin 拉取最近 N 天活动与每日健康数据并落库（按 activityId 去重，重复同步不会产生重复数据）。返回新增数量与运动类型。',
            parameters: {
                days: { type: 'integer', description: '拉取最近多少天（默认 14）' },
                sport: { type: 'string', description: '只同步指定运动类型，如 running / cycling / swimming / hiking' },
            },
            execute: async (args) => {
                const { days, sport } = args;
                const { syncGarmin } = await import('../sync.js');
                const { GarminClient } = await import('../auth/client.js');
                const { FileTokenStore } = await import('../auth/file-store.js');
                const { makeQueries } = await import('../api/queries.js');
                const client = new GarminClient({ store: FileTokenStore.default() });
                const queries = makeQueries(client);
                return syncGarmin({
                    days: days ?? 14,
                    sportFilter: sport ? [sport] : undefined,
                    store,
                    queries,
                });
            },
        }),
        defineGarminTool({
            name: 'garmin_recent_activities',
            description: '查看最近 N 次活动（可按运动类型筛选）。返回活动列表含距离、配速、心率、时间。',
            parameters: {
                sport: { type: 'string', description: '运动类型，如 running / cycling' },
                limit: { type: 'integer', description: '最多返回多少条，默认 10' },
            },
            execute: async (args) => {
                const { sport, limit } = args;
                return stats.recentActivities(store, { sport, limit });
            },
        }),
        defineGarminTool({
            name: 'garmin_best_pace',
            description: '查询指定距离的最好成绩（配速最快）。例如"十公里最好成绩"传 distanceMeters=10000。',
            parameters: {
                distanceMeters: { type: 'integer', required: true, description: '目标距离（米），如 10000 = 10 公里，21097 = 半马' },
                toleranceMeters: { type: 'integer', description: '距离容差（米），默认目标距离的 10%' },
                sport: { type: 'string', description: '运动类型，默认 running' },
            },
            execute: async (args) => {
                const { distanceMeters, toleranceMeters, sport } = args;
                const best = await stats.bestPace(store, {
                    distanceMeters,
                    toleranceMeters,
                    sport: sport ?? 'running',
                });
                if (!best) {
                    return {
                        error: true,
                        message: `没有找到约 ${distanceMeters / 1000} 公里的${sport ?? '跑步'}记录`,
                    };
                }
                return {
                    activityId: best.activityId,
                    date: best.startTime?.slice(0, 10),
                    distanceKm: Math.round((best.distanceMeters / 1000) * 100) / 100,
                    pace: stats.formatPace(best.avgPaceSecPerKm),
                    avgHr: best.avgHr,
                    avgCadence: best.avgCadence,
                    trainingEffect: best.trainingEffect,
                };
            },
        }),
        defineGarminTool({
            name: 'garmin_report',
            description: '生成运动报告：周报/月报/季度/年度/自定义日期范围。返回聚合数据（活动、健康、对比），' +
                'AI 据此输出 Markdown 报告。' +
                '报告结构：概览、每周分解、最佳成绩、健康数据、活动明细、AI点评。' +
                '活动明细的 durationDisplay 是格式化好的时长（如 24m/1h36m），直接展示，不要返回原始秒数。' +
                '注意：小节标题直接用简洁名称（如"活动明细""每周跑量"），不要在标题里加"含时长"这类说明性标注，' +
                '时长/距离/配速这些字段本来就应该正常展示。',
            parameters: {
                period: {
                    type: 'string',
                    description: '报告周期：week=周报, month=月报, quarter=季报, year=年报, custom=自定义',
                },
                from: { type: 'string', description: '自定义起期 YYYY-MM-DD（period=custom 时用）' },
                to: { type: 'string', description: '自定义止期 YYYY-MM-DD（缺省=今天）' },
            },
            execute: async (args) => {
                const { period, from, to } = args;
                const { reportStats } = await import('../stats.js');
                return reportStats(store, {
                    period: period || 'week',
                    from,
                    to,
                });
            },
        }),
        defineGarminTool({
            name: 'garmin_training_plan',
            description: '训练计划（带缓存与打卡）。' +
                '用户查看/询问训练计划时传 goal（如"10km进5:30"）；目标相同则返回已保存的计划（含打卡，不重新生成）。' +
                '用户明确要重新生成/换目标时传 force=true（同目标保留打卡，换目标清空）；' +
                '无缓存时返回基线数据，AI 生成新计划后可调用 garmin_save_training_plan 保存。' +
                '注意：不要因为数据更新就自动重新生成——数据变化时优先返回已保存的计划，除非用户明确要求。',
            parameters: {
                goal: { type: 'string', description: '训练目标，如"10公里进5:30"、"备战半马"' },
                weeks: { type: 'integer', description: '计划周数，默认 4' },
                daysPerWeek: { type: 'integer', description: '每周训练天数，默认 3' },
                force: { type: 'boolean', description: 'true=强制重新生成（忽略缓存），缺省=优先用缓存' },
            },
            execute: async (args) => {
                const { goal, weeks, daysPerWeek, force } = args;
                const { trainingPlanData } = await import('../stats.js');
                const data = await trainingPlanData(store);
                // 尝试读缓存
                const cached = await store.loadTrainingPlan();
                const goalKey = (goal || '').trim();
                if (!force && cached) {
                    // 同目标判断：
                    //  - 用户传了 goal → 按字符串比较（同目标保留打卡，换目标清空）
                    //  - 用户没传 goal（查看计划）→ 视为同目标（保留计划 + 打卡）
                    const sameGoal = !goalKey || (cached.goal || '').trim() === goalKey;
                    const sameFingerprint = cached.baselineFingerprint === data.fingerprint;
                    if (sameGoal && sameFingerprint) {
                        // 目标相同 + 数据未变 → 直接用缓存（含打卡状态）
                        return {
                            fromCache: true,
                            cachedAt: cached.generatedAt,
                            goal: cached.goal,
                            baseline: data.baseline,
                            assessment: data.assessment,
                            plan: cached.plan,
                            tasks: cached.tasks || [],
                            progress: await store.planProgress(),
                            tips: cached.tips,
                        };
                    }
                    if (sameGoal) {
                        // 目标相同但数据变化（如同步了新数据）→ 保留旧计划 + 打卡
                        // 不清空打卡！提示数据更新，用户可明确要求重新生成
                        return {
                            fromCache: true,
                            dataUpdated: true,
                            cachedAt: cached.generatedAt,
                            goal: cached.goal,
                            baseline: data.baseline,
                            assessment: data.assessment,
                            plan: cached.plan,
                            tasks: cached.tasks || [],
                            progress: await store.planProgress(),
                            tips: cached.tips,
                            message: '数据有更新（同步了新训练），当前计划保留。如需重新生成请输入"重新生成训练计划"。',
                        };
                    }
                }
                // 无缓存/失效 → 返回基线数据，让 AI 生成
                return {
                    fromCache: false,
                    requestedGoal: goalKey,
                    weeks: weeks ?? 4,
                    daysPerWeek: daysPerWeek ?? 3,
                    baseline: data.baseline,
                    assessment: data.assessment,
                    goalSuggestions: data.goalSuggestions,
                    fingerprint: data.fingerprint,
                    // 提示 AI：生成计划后调 garmin_save_training_plan 保存
                    saveInstruction: '生成完整训练计划后，调用 garmin_save_training_plan 保存（传 goal/weeks/daysPerWeek/plan/tips/fingerprint）',
                };
            },
        }),
        defineGarminTool({
            name: 'garmin_save_training_plan',
            description: '保存 AI 生成的训练计划到缓存（data/training-plan.json）。' +
                '配合 garmin_training_plan 使用：AI 生成计划后调用本工具保存，下次查询直接返回。' +
                '注意：必须同时提供 tasks（结构化训练任务数组，供看板打卡用），' +
                '每个任务含 week(第几周)、day(周几)、type(训练类型如"有氧慢跑"/"间歇")、detail(具体内容如"6km 配速6:30")。',
            parameters: {
                goal: { type: 'string', description: '训练目标' },
                plan: { type: 'string', description: '生成的完整计划（markdown）' },
                tasks: {
                    type: 'array',
                    description: '结构化训练任务（供打卡）',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: '任务唯一id，如 w1-d1' },
                            week: { type: 'integer', description: '第几周' },
                            day: { type: 'string', description: '周几，如"周一"' },
                            type: { type: 'string', description: '训练类型，如"有氧慢跑"/"间歇"/"节奏跑"' },
                            detail: { type: 'string', description: '具体内容，如"6km 配速6:30 心率Z2"' },
                        },
                        additionalProperties: false,
                    },
                },
                tips: { type: 'array', items: { type: 'string' }, description: '附加建议列表' },
                weeks: { type: 'integer', description: '计划周数' },
                daysPerWeek: { type: 'integer', description: '每周训练天数' },
                fingerprint: { type: 'string', description: '数据指纹（来自 garmin_training_plan 返回）' },
            },
            execute: async (args) => {
                const { goal, plan, tasks, tips, weeks, daysPerWeek, fingerprint } = args;
                if (!goal || !plan) {
                    return { ok: false, message: '需要 goal 和 plan' };
                }
                // 规范化 tasks：补 id/done
                const normalizedTasks = (tasks || []).map(function (t, idx) {
                    return {
                        id: t.id || 'task-' + idx,
                        week: t.week ?? 1,
                        day: t.day || '',
                        type: t.type || '训练',
                        detail: t.detail || '',
                        done: false,
                    };
                });
                await store.saveTrainingPlan({
                    goal: goal,
                    baselineFingerprint: fingerprint || '',
                    generatedAt: new Date().toISOString(),
                    weeks: weeks ?? 4,
                    daysPerWeek: daysPerWeek ?? 3,
                    plan: plan,
                    tips: tips || [],
                    tasks: normalizedTasks,
                });
                return { ok: true, message: '训练计划已保存（含 ' + normalizedTasks.length + ' 个训练任务，可打卡）' };
            },
        }),
        defineGarminTool({
            name: 'garmin_toggle_task',
            description: '打卡/取消打卡一个训练任务。传入 taskId（如 w1-d1），切换该任务的完成状态。' +
                '用于用户完成某次训练后在看板或对话里标记完成。',
            parameters: {
                taskId: { type: 'string', required: true, description: '训练任务 id' },
            },
            execute: async (args) => {
                const { taskId } = args;
                if (!taskId)
                    return { ok: false, message: '需要 taskId' };
                return store.toggleTask(taskId);
            },
        }),
        defineGarminTool({
            name: 'garmin_plan_progress',
            description: '查看当前训练计划的打卡进度（已完成/总任务数）。',
            parameters: {},
            execute: async () => {
                const progress = await store.planProgress();
                const plan = await store.loadTrainingPlan();
                return {
                    ok: true,
                    progress,
                    goal: plan ? plan.goal : null,
                    hasPlan: !!plan,
                };
            },
        }),
        defineGarminTool({
            name: 'garmin_restore_plan',
            description: '从历史版本恢复训练计划。传入 garmin_plan_history 返回的 file 文件名，' +
                '恢复到该历史版本（含当时的打卡状态）。用于 AI 误判覆盖后找回旧计划。',
            parameters: {
                file: { type: 'string', required: true, description: '历史文件名（来自 garmin_plan_history）' },
            },
            execute: async (args) => {
                const { file } = args;
                if (!file)
                    return { ok: false, message: '需要 file（历史文件名）' };
                return store.restorePlan(file);
            },
        }),
        defineGarminTool({
            name: 'garmin_log_diary',
            description: '记录一条训练日记。用户完成一次训练后可记录感受/评分，可关联某个训练任务。' +
                'date 缺省今天，taskId 可选（关联计划任务），feeling 是感受，rating 是 1-5 星。',
            parameters: {
                feeling: { type: 'string', required: true, description: '训练感受，如"今天跑得很累，配速一般"' },
                date: { type: 'string', description: '日期 YYYY-MM-DD，缺省今天' },
                rating: { type: 'integer', description: '评分 1-5 星（可选）' },
                taskId: { type: 'string', description: '关联的训练任务 id（可选）' },
                taskLabel: { type: 'string', description: '任务描述（可选，如"有氧慢跑 6km"）' },
            },
            execute: async (args) => {
                const { feeling, date, rating, taskId, taskLabel } = args;
                if (!feeling)
                    return { ok: false, message: '需要 feeling（训练感受）' };
                const now = new Date();
                const entry = {
                    id: 'diary-' + Date.now(),
                    date: date || now.toISOString().slice(0, 10),
                    taskId,
                    taskLabel,
                    feeling: feeling,
                    rating: rating,
                    createdAt: now.toISOString(),
                };
                await store.addDiaryEntry(entry);
                return { ok: true, message: '训练日记已记录', entry: entry };
            },
        }),
        defineGarminTool({
            name: 'garmin_diary',
            description: '查看训练日记。可按日期范围或最近 N 条。返回日记条目（含日期、感受、评分、关联任务）。',
            parameters: {
                days: { type: 'integer', description: '最近 N 天（缺省全部）' },
                limit: { type: 'integer', description: '最多返回条数，默认 20' },
            },
            execute: async (args) => {
                const { days, limit } = args;
                const entries = await store.loadDiary();
                let result = entries;
                if (days) {
                    const cutoff = Date.now() - days * 86400000;
                    result = result.filter(function (e) {
                        return new Date(e.date + 'T00:00:00').getTime() >= cutoff;
                    });
                }
                return { ok: true, entries: result.slice(0, limit ?? 20) };
            },
        }),
    ];
}
