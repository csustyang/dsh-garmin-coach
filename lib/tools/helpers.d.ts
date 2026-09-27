/**
 * 工具注册 helper —— 对齐 dsh-tools 0.1.7 defineTool 用法。
 *
 * 官方契约（[deepseek-harness/docs/subsystems/tools.md]）：
 *   - parameters 用字段映射（{ field: { type, description, required? } }）
 *   - output: { schema, render } 必填
 *     - schema 是 ValueSchemaSpec 字面量 —— 用 { type: 'json' } 表示"任意 lossless JSON"
 *     - render(args, value) 返回 ContentBlock[]（dsh-llm 定义的文本/图像/工具结果块）
 *   - execute(args, exec) 接受 ToolRunContext（含 AbortSignal），返回 JsonValue
 *
 * 改动（适配 0.1.7）：
 *   - render 用 ContentBlock 类型替代内联 { type: 'text'; text: string }
 *   - withBoundary 包装保持透传 exec（含 signal）+ 兜底
 *   - execute 返回类型由 unknown 收紧为 JsonValue（dsh-tools 强类型推导）
 *
 * 实现策略：dsh-tools 0.1.7 的 defineTool<O> 要求 execute 返回 InferValue<O>。
 * 本 helper 固定 outputSchema 默认 { type: 'json' }，对应 InferValue = JsonValue。
 * callers 自定义 outputSchema 时，execute 返回类型需自己保证与 schema 兼容。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue, ParameterSchemaSpec, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
/**
 * 定义一个工具，满足 dsh-tools 0.1.7 defineTool 契约。
 *
 * @param def - 工具定义
 *   - parameters 用字段映射（官方 ParameterSchemaSpec）
 *   - outputSchema 用 ValueSchemaSpec，默认 { type: 'json' } 透传任意 JSON
 *   - execute(args, exec) 返回任意 JsonValue（透传到 render）
 */
export declare function defineGarminTool(def: {
    name: string;
    description: string;
    parameters: ParameterSchemaSpec;
    /** output 的 value schema（ValueSchemaSpec，默认 { type: 'json' } 透传任意 JSON）*/
    outputSchema?: ValueSchemaSpec;
    execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<JsonValue>;
}): ReturnType<typeof defineTool>;
