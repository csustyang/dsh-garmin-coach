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

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  JsonValue,
  ParameterSchemaSpec,
  ToolRunContext,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import { withBoundary } from '../boundary.js'

/** 通用 render：把任意 JSON 值转成单条 text block（人类可读）。*/
function jsonRender(_args: unknown, value: JsonValue): ContentBlock[] {
  // 纯字符串直接展示原文（否则 JSON.stringify 会加引号，如 "young_garmin"）；
  // 对象/数组走 JSON 美化展示。
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 定义一个工具，满足 dsh-tools 0.1.7 defineTool 契约。
 *
 * @param def - 工具定义
 *   - parameters 用字段映射（官方 ParameterSchemaSpec）
 *   - outputSchema 用 ValueSchemaSpec，默认 { type: 'json' } 透传任意 JSON
 *   - execute(args, exec) 返回任意 JsonValue（透传到 render）
 */
export function defineGarminTool(def: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  /** output 的 value schema（ValueSchemaSpec，默认 { type: 'json' } 透传任意 JSON）*/
  outputSchema?: ValueSchemaSpec
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<JsonValue>
}): ReturnType<typeof defineTool> {
  // fallback 占位（schema = json → 任何 JsonValue 合法）：错误返回 { error, message } 对象
  const fallback: JsonValue = { error: true, message: '工具执行失败' }
  // 包成 withBoundary 兜底（异常 → fallback）
  const safeExecute = withBoundary(
    { scope: `tools.${def.name}`, fallback },
    def.execute,
  )
  // withBoundary 返回 Promise<R | undefined>；defineTool 要求 Promise<JsonValue>。
  // 兜底函数保证 undefined 不会出现（异常已吞 + fallback 强制 JsonValue），
  // 但 TS 不知道，需要显式 cast。
  const safeExecuteTyped = safeExecute as unknown as (
    args: unknown,
    exec: ToolRunContext,
  ) => Promise<JsonValue>

  // 关键：直接定义两个分支 inline（callers 不写 outputSchema 时走 json 默认）
  // 避免把 schema 赋值给中间变量后被 TS 联合扩展成 ValueSchemaSpec（→ 推成 never）
  if (def.outputSchema) {
    // 自定义 schema：callers 必须保证 execute 返回值与 schema 兼容
    // （TS 在宽 ValueSchemaSpec 上推不出精确 InferValue → 这里使用 any cast）
    return defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: def.outputSchema,
        render: jsonRender as unknown as (args: unknown, value: unknown) => ContentBlock[],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: safeExecuteTyped as any,
    })
  }
  // 默认 schema = { type: 'json' }（字面量，const 修饰符推断 → 完美匹配 JsonValue）
  return defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: 'json' },
      render: jsonRender,
    },
    execute: safeExecuteTyped,
  })
}