/**
 * Garmin Connect 数据查询的 LLM-facing 接口。
 *
 * 这 9 个函数对应 ai-skill-garmin 的 9 个 CLI 子命令：
 *   whoami / daily / sleep / hrv / readiness / training / activities / summary / weekly
 *
 * 每个函数返回 unknown（透传 Garmin JSON）。上层包装成 ctx.tools 时再做 schema 化。
 */
import { GarminClient } from '../auth/client.js';
export interface GarminQueries {
    whoami(): Promise<string>;
    daily(date?: string): Promise<unknown>;
    sleep(date?: string): Promise<unknown>;
    hrv(date?: string): Promise<unknown>;
    readiness(date?: string): Promise<unknown>;
    training(date?: string): Promise<unknown>;
    activities(args: {
        from?: string;
        to?: string;
        limit?: number;
    }): Promise<unknown[]>;
    summary(date?: string): Promise<{
        date: string;
        daily: unknown;
        sleep: unknown;
        hrv: unknown;
        readiness: unknown;
        training: unknown;
        activities: unknown[];
    }>;
    weekly(endDate?: string): Promise<{
        from: string;
        to: string;
        days: {
            date: string;
            daily: unknown;
            sleep: unknown;
        }[];
        activities: unknown[];
    }>;
}
export declare function makeQueries(client: GarminClient): GarminQueries;
