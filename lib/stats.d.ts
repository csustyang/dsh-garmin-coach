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
import type { ActivityRecord, GarminStoreFile } from './storage.js';
/** 配速格式化：秒/km → "4:15/km" */
export declare function formatPace(secPerKm: number | undefined): string;
/**
 * 格式化时长（秒 → 可读）：
 *  - 不足 1 小时 → 分钟（如 24m，四舍五入）
 *  - 超过 1 小时 → 小时+分钟（如 96 分钟 → 1h36m）
 *  - 不足 1 分钟 → 秒（如 45s）
 */
export declare function formatDuration(sec: number | undefined): string;
export interface RecentActivitiesArgs {
    sport?: string;
    limit?: number;
    days?: number;
}
/** 最近 N 次活动 */
export declare function recentActivities(store: GarminStoreFile, args: RecentActivitiesArgs): Promise<ActivityRecord[]>;
export interface BestPaceArgs {
    /** 目标距离（米）*/
    distanceMeters: number;
    /** 距离容差（米），默认 ±10% */
    toleranceMeters?: number;
    sport?: string;
}
/** 某距离的最佳配速成绩 */
export declare function bestPace(store: GarminStoreFile, args: BestPaceArgs): Promise<ActivityRecord | null>;
export interface DistanceStatsArgs {
    days?: number;
    sport?: string;
}
/** 距离统计（总距离、次数、平均配速）*/
export declare function distanceStats(store: GarminStoreFile, args: DistanceStatsArgs): Promise<{
    count: number;
    totalKm: number;
    avgKm: number;
    avgPace: string;
    bestPace: string;
    firstDate: string;
    lastDate: string;
}>;
export interface DailyStatsArgs {
    days?: number;
}
/** 每日健康统计（平均步数/静息心率/睡眠/HRV）*/
export declare function dailyStats(store: GarminStoreFile, args: DailyStatsArgs): Promise<{
    days: number;
    avgSteps: number;
    avgRestingHr: number;
    avgSleepHours: number;
    avgStress: number;
    avgHrv: number;
    lastHrvStatus: string;
}>;
/** 运动类型分布 */
export declare function sportBreakdown(store: GarminStoreFile, days?: number): Promise<Array<{
    sport: string;
    count: number;
    totalKm: number;
}>>;
/**
 * 看板聚合数据：总览 + 趋势 + 成绩 + 健康。
 * 供 /garmin-dashboard-data 端点返回，前端 React 看板渲染。
 */
export declare function dashboardSummary(store: GarminStoreFile): Promise<{
    overview: {
        totalActivities: number;
        totalKm: number;
        totalRuns: number;
        totalTimeSec: number;
        avgPace: string;
        bestPace: string;
        longestKm: number;
        lastSyncAt: string;
    };
    recent: ActivityRecord[];
    weekly: Array<{
        week: string;
        km: number;
        runs: number;
    }>;
    bestPaces: Record<string, ActivityRecord | null>;
    health: {
        days: number;
        avgSteps: number;
        avgRestingHr: number;
        avgSleepHours: number;
        avgHrv: number;
    };
    sportBreakdown: Array<{
        sport: string;
        count: number;
        totalKm: number;
    }>;
    dailyRecent: Array<{
        date: string;
        steps?: number;
        restingHeartRate?: number;
        stressAvg?: number;
        bodyBattery?: number;
        totalDistanceMeters?: number;
        activeKilocalories?: number;
    }>;
    paceByDistance: Array<{
        label: string;
        distanceMeters: number;
        bestPaceSecPerKm: number | null;
        bestDate: string | null;
        avgPaceSecPerKm: number | null;
        count: number;
    }>;
    paceDistribution: Array<{
        range: string;
        count: number;
        avgHr: number | null;
    }>;
    hrPaceRelationship: Array<{
        paceRange: string;
        avgHr: number | null;
        count: number;
    }>;
    trainingLoad: {
        totalLoad: number;
        weeklyLoad: Array<{
            week: string;
            load: number;
            durationMin: number;
        }>;
        avgWeeklyLoad: number;
    };
    distanceDistribution: Array<{
        range: string;
        count: number;
        totalKm: number;
    }>;
    weekOverWeek: {
        thisWeek: {
            km: number;
            runs: number;
            avgPace: number | null;
            avgHr: number | null;
            load: number;
        };
        lastWeek: {
            km: number;
            runs: number;
            avgPace: number | null;
            avgHr: number | null;
            load: number;
        };
        kmChange: number;
        runsChange: number;
    };
    cadence: {
        avgCadence: number | null;
        byPace: Array<{
            paceRange: string;
            avgCadence: number;
            count: number;
        }>;
        distribution: Array<{
            range: string;
            count: number;
        }>;
        trend: Array<{
            month: string;
            avgCadence: number;
        }>;
    };
    elevation: {
        totalElevation: number;
        byElevation: Array<{
            range: string;
            count: number;
            km: number;
            avgPace: number | null;
        }>;
        paceImpact: {
            flatPace: number | null;
            hillyPace: number | null;
            impact: string;
        };
    };
    calories: {
        totalCalories: number;
        avgCalPerKm: number | null;
        trend: Array<{
            month: string;
            calPerKm: number | null;
        }>;
    };
    consistency: {
        weeklyFrequency: Array<{
            week: string;
            runs: number;
        }>;
        longestStreak: number;
        timeOfDay: Array<{
            period: string;
            count: number;
        }>;
        weekdayDistribution: Array<{
            day: string;
            count: number;
        }>;
    };
    hrZoneBreakdown: {
        totals: {
            zone1: number;
            zone2: number;
            zone3: number;
            zone4: number;
            zone5: number;
        };
        totalSec: number;
        details: Array<{
            activityId: string;
            activityName: string;
            startTime: string;
            sport: string;
            totalSec: number;
            zones: {
                zone1: number;
                zone2: number;
                zone3: number;
                zone4: number;
                zone5: number;
            };
        }>;
    };
    trainingPlan: {
        goal: string;
        plan: string;
        tasks: Array<{
            id: string;
            week: number;
            day: string;
            type: string;
            detail: string;
            done: boolean;
        }>;
        tips: string[];
        progress: {
            done: number;
            total: number;
        };
    } | null;
    diary: Array<{
        id: string;
        date: string;
        taskId?: string;
        taskLabel?: string;
        feeling: string;
        rating?: number;
        createdAt: string;
    }>;
}>;
/** 距离分段配速（1k/3k/5k/10k/15k/半马/全马）*/
export declare function paceByDistance(store: GarminStoreFile): Promise<Array<{
    label: string;
    distanceMeters: number;
    bestPaceSecPerKm: number | null;
    bestDate: string | null;
    avgPaceSecPerKm: number | null;
    count: number;
}>>;
/** 配速分布（按时间区间统计次数）*/
export declare function paceDistribution(store: GarminStoreFile): Promise<Array<{
    range: string;
    count: number;
    avgHr: number | null;
}>>;
/** 心率-配速关系（相同配速区间的平均心率，反映有氧效率）*/
export declare function hrPaceRelationship(store: GarminStoreFile): Promise<Array<{
    paceRange: string;
    avgHr: number | null;
    count: number;
}>>;
/** TRIMP 训练负荷（基于心率的训练负荷）*/
export declare function trainingLoad(store: GarminStoreFile): Promise<{
    totalLoad: number;
    weeklyLoad: Array<{
        week: string;
        load: number;
        durationMin: number;
    }>;
    avgWeeklyLoad: number;
}>;
/** 距离分布（按距离区间统计次数）*/
export declare function distanceDistribution(store: GarminStoreFile): Promise<Array<{
    range: string;
    count: number;
    totalKm: number;
}>>;
/** 周环比（本周 vs 上周）*/
export declare function weekOverWeek(store: GarminStoreFile): Promise<{
    thisWeek: {
        km: number;
        runs: number;
        avgPace: number | null;
        avgHr: number | null;
        load: number;
    };
    lastWeek: {
        km: number;
        runs: number;
        avgPace: number | null;
        avgHr: number | null;
        load: number;
    };
    kmChange: number;
    runsChange: number;
}>;
/** 步频分析（平均 + 步频-配速关系 + 分布）*/
export declare function cadenceAnalysis(store: GarminStoreFile): Promise<{
    avgCadence: number | null;
    byPace: Array<{
        paceRange: string;
        avgCadence: number;
        count: number;
    }>;
    distribution: Array<{
        range: string;
        count: number;
    }>;
    trend: Array<{
        month: string;
        avgCadence: number;
    }>;
}>;
/** 爬升分析（爬升-配速影响 + 爬升分布）*/
export declare function elevationAnalysis(store: GarminStoreFile): Promise<{
    totalElevation: number;
    byElevation: Array<{
        range: string;
        count: number;
        km: number;
        avgPace: number | null;
    }>;
    paceImpact: {
        flatPace: number | null;
        hillyPace: number | null;
        impact: string;
    };
}>;
/** 卡路里效率（每公里卡路里 + 月趋势）*/
export declare function calorieEfficiency(store: GarminStoreFile): Promise<{
    totalCalories: number;
    avgCalPerKm: number | null;
    trend: Array<{
        month: string;
        calPerKm: number | null;
    }>;
}>;
/** 训练频率与一致性（周次数、连续训练日、时间分布）*/
export declare function trainingConsistency(store: GarminStoreFile): Promise<{
    weeklyFrequency: Array<{
        week: string;
        runs: number;
    }>;
    longestStreak: number;
    timeOfDay: Array<{
        period: string;
        count: number;
    }>;
    weekdayDistribution: Array<{
        day: string;
        count: number;
    }>;
}>;
/** 大看板聚合（包含所有分析）*/
export declare function fullDashboardStats(store: GarminStoreFile): Promise<{
    paceByDistance: Array<{
        label: string;
        distanceMeters: number;
        bestPaceSecPerKm: number | null;
        bestDate: string | null;
        avgPaceSecPerKm: number | null;
        count: number;
    }>;
    paceDistribution: Array<{
        range: string;
        count: number;
        avgHr: number | null;
    }>;
    hrPaceRelationship: Array<{
        paceRange: string;
        avgHr: number | null;
        count: number;
    }>;
    trainingLoad: {
        totalLoad: number;
        weeklyLoad: Array<{
            week: string;
            load: number;
            durationMin: number;
        }>;
        avgWeeklyLoad: number;
    };
    distanceDistribution: Array<{
        range: string;
        count: number;
        totalKm: number;
    }>;
    weekOverWeek: {
        thisWeek: {
            km: number;
            runs: number;
            avgPace: number | null;
            avgHr: number | null;
            load: number;
        };
        lastWeek: {
            km: number;
            runs: number;
            avgPace: number | null;
            avgHr: number | null;
            load: number;
        };
        kmChange: number;
        runsChange: number;
    };
    cadence: {
        avgCadence: number | null;
        byPace: Array<{
            paceRange: string;
            avgCadence: number;
            count: number;
        }>;
        distribution: Array<{
            range: string;
            count: number;
        }>;
        trend: Array<{
            month: string;
            avgCadence: number;
        }>;
    };
    elevation: {
        totalElevation: number;
        byElevation: Array<{
            range: string;
            count: number;
            km: number;
            avgPace: number | null;
        }>;
        paceImpact: {
            flatPace: number | null;
            hillyPace: number | null;
            impact: string;
        };
    };
    calories: {
        totalCalories: number;
        avgCalPerKm: number | null;
        trend: Array<{
            month: string;
            calPerKm: number | null;
        }>;
    };
    consistency: {
        weeklyFrequency: Array<{
            week: string;
            runs: number;
        }>;
        longestStreak: number;
        timeOfDay: Array<{
            period: string;
            count: number;
        }>;
        weekdayDistribution: Array<{
            day: string;
            count: number;
        }>;
    };
}>;
export type InsightSeverity = 'tip' | 'suggestion' | 'warning';
export interface Insight {
    category: 'pace' | 'volume' | 'load' | 'cadence' | 'hr' | 'consistency' | 'pb' | 'general';
    severity: InsightSeverity;
    title: string;
    detail: string;
    /** 关联的数据上下文（让 AI 能引用）*/
    data?: Record<string, unknown>;
}
export declare function generateInsights(store: GarminStoreFile): Promise<Insight[]>;
export type ReportPeriod = 'week' | 'month' | 'quarter' | 'year' | 'custom';
export interface ReportResult {
    period: string;
    from: string;
    to: string;
    /** 运动概览 */
    overview: {
        totalActivities: number;
        totalRuns: number;
        totalKm: number;
        totalTimeSec: number;
        totalCalories: number;
        avgPace: string;
        bestPace: string;
        longestKm: number;
        avgHr: number | null;
    };
    /** 按周分解（窗口内） */
    weekly: Array<{
        week: string;
        km: number;
        runs: number;
    }>;
    /** 运动类型分布 */
    sportBreakdown: Array<{
        sport: string;
        count: number;
        totalKm: number;
    }>;
    /** 各距离 PB（窗口内） */
    bestPaces: Array<{
        label: string;
        bestPace: string;
        date: string | null;
    }>;
    /** 健康数据（窗口内有数据的日期） */
    health: {
        daysWithData: number;
        avgSteps: number | null;
        avgRestingHr: number | null;
        avgStress: number | null;
        avgBodyBattery: number | null;
    };
    /** 活动明细（最近 10 条，含 durationDisplay 格式化时长） */
    recent: Array<ActivityRecord & {
        durationDisplay: string;
    }>;
    /** 上一窗口对比 */
    previous: {
        totalKm: number;
        totalRuns: number;
        kmChange: number;
        runsChange: number;
    };
}
/** 生成报告聚合数据 */
export declare function reportStats(store: GarminStoreFile, opts?: {
    period?: ReportPeriod;
    from?: string;
    to?: string;
}): Promise<ReportResult>;
export interface TrainingPlanData {
    /** 用户当前水平基线 */
    baseline: {
        recentAvgPace: string;
        bestPace: string;
        weeklyFreq: number;
        avgWeeklyKm: number;
        avgHr: number | null;
        avgCadence: number | null;
        longestRunKm: number;
        totalKm: number;
        totalRuns: number;
    };
    /** 目标建议（AI 用） */
    goalSuggestions: Array<{
        goal: string;
        weeklyPlan: string;
        tips: string[];
    }>;
    /** 当前水平评估 */
    assessment: string;
    /** 数据指纹（判断基线是否变化）*/
    fingerprint: string;
}
/** 生成训练计划数据（供 AI 个性化建议）*/
export declare function trainingPlanData(store: GarminStoreFile): Promise<TrainingPlanData>;
export interface HrZoneDetail {
    activityId: string;
    activityName: string;
    startTime: string;
    sport: string;
    totalSec: number;
    zones: {
        zone1: number;
        zone2: number;
        zone3: number;
        zone4: number;
        zone5: number;
    };
}
export interface HrZoneBreakdown {
    /** 5 个心率区间的总时长（秒）*/
    totals: {
        zone1: number;
        zone2: number;
        zone3: number;
        zone4: number;
        zone5: number;
    };
    /** 总时长（所有区间）*/
    totalSec: number;
    /** 每次活动的区间详情（供前端 + 按钮展开）*/
    details: HrZoneDetail[];
}
export declare function hrZoneBreakdown(store: GarminStoreFile): Promise<HrZoneBreakdown>;
