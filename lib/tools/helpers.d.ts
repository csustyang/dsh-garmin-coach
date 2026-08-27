/**
 * 工具注册 helper —— 对齐官方 defineTool 用法。
 *
 * 官方要求：
 *   - parameters 用字段映射（{ field: {type, required, description} }）
 *   - 必须有 output: { schema, render }
 *   - render 返回 text block: [{ type: 'text', text }]
 *
 * 我们封装一层，让工具定义更简洁，同时满足 defineTool 契约。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
/**
 * 定义一个工具，满足官方 defineTool 契约。
 *
 * @param def - 工具定义（parameters 用字段映射，output.schema 用 value schema）
 */
export declare function defineGarminTool(def: {
    name: string;
    description: string;
    parameters: ParameterSchemaSpec;
    /** output 的 value schema（JSON Schema）*/
    outputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
}): ReturnType<typeof defineTool>;
