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

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { withBoundary } from '../boundary.js'

/** 通用 render：把任意 JSON 值转成 text block（人类可读）*/
function jsonRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 定义一个工具，满足官方 defineTool 契约。
 *
 * @param def - 工具定义（parameters 用字段映射，output.schema 用 value schema）
 */
export function defineGarminTool(def: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  /** output 的 value schema（JSON Schema）*/
  outputSchema?: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}): ReturnType<typeof defineTool> {
  return defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      // ponytail: 默认放开 schema（任何 JSON 值都合法）；具体工具可用 outputSchema 收紧。
      // 原先默认 { type: 'string' }，但工具大多返回对象/数组，会触发框架
      // "value must be a string" 校验错误。
      schema: (def.outputSchema ?? {}) as never,
      render: jsonRender,
    },
    execute: withBoundary(
      { scope: `tools.${def.name}`, fallback: { error: true, message: '工具执行失败' } },
      (async (args: Record<string, unknown>) => def.execute(args)) as unknown as (
        args: Record<string, unknown>,
      ) => Promise<never>,
    ) as never,
  })
}
