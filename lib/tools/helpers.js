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
import { withBoundary } from '../boundary.js';
/** 通用 render：把任意 JSON 值转成 text block（人类可读）*/
function jsonRender(_args, value) {
    // 纯字符串直接展示原文（否则 JSON.stringify 会加引号，如 "young_garmin"）；
    // 对象/数组走 JSON 美化展示。
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text }];
}
/**
 * 定义一个工具，满足官方 defineTool 契约。
 *
 * @param def - 工具定义（parameters 用字段映射，output.schema 用 value schema）
 */
export function defineGarminTool(def) {
    return defineTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        output: {
            // ponytail: 默认放开 schema（任何 JSON 值都合法）；具体工具可用 outputSchema 收紧。
            // 用 { type: 'json' } 而非 {} —— dsh-tools 编译器不接受空对象，
            // 会报 "unsupported JSON schema: schema.type must be ... or use oneOf"。
            schema: (def.outputSchema ?? { type: 'json' }),
            render: jsonRender,
        },
        execute: withBoundary({ scope: `tools.${def.name}`, fallback: { error: true, message: '工具执行失败' } }, (async (args) => def.execute(args))),
    });
}
