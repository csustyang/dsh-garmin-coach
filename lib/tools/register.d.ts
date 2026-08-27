/**
 * 9 个 Garmin Tool —— 用官方 defineTool 注册。
 *
 * 每个工具：
 *   - parameters 用字段映射（官方 ParameterSchemaSpec）
 *   - output 声明 schema + render（官方要求，否则注册报错）
 *   - execute 用 withBoundary 容错
 */
import type { GarminQueries } from '../api/queries.js';
import { defineGarminTool } from './helpers.js';
/**
 * 构造 9 个 LLM 可见的 Garmin 工具。
 * 返回 defineTool 结果数组（registry-ready）。
 */
export declare function defineGarminTools(q: GarminQueries): ReturnType<typeof defineGarminTool>[];
