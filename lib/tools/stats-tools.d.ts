/**
 * 统计查询工具 —— 基于已落库的 JSON 数据，JS 计算引擎返回精炼结果。
 *
 * 这些工具不实时调 Garmin API，只读本地 garmin.json，秒回。
 * 数据由同步工具（garmin_sync）填充。
 * 用官方 defineTool 注册。
 */
import type { GarminStoreFile } from '../storage.js';
import { defineGarminTool } from './helpers.js';
export interface StatsToolContext {
    store: GarminStoreFile;
}
/**
 * 构建统计工具集（registry-ready defineTool 结果）。
 */
export declare function defineStatsTools(ctx: StatsToolContext): ReturnType<typeof defineGarminTool>[];
