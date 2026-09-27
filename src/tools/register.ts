/**
 * 9 个 Garmin Tool —— 用官方 defineTool 注册。
 *
 * 每个工具：
 *   - parameters 用字段映射（官方 ParameterSchemaSpec）
 *   - output 声明 schema + render（官方要求，否则注册报错）
 *   - execute 用 withBoundary 容错
 *
 * 0.1.7 适配：execute 返回 JsonValue（dsh-tools 强类型推导）。
 */

import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GarminQueries } from '../api/queries.js'
import { defineGarminTool } from './helpers.js'

/** 把任意 Garmin JSON 响应统一包成 JsonValue（透传 unknown → JsonValue）*/
function asJson<T>(p: Promise<T>): Promise<JsonValue> {
  return p as Promise<JsonValue>
}

/**
 * 构造 LLM 可见的 Garmin 工具。
 * 返回 defineTool 结果数组（registry-ready）。
 */
export function defineGarminTools(q: GarminQueries): ReturnType<typeof defineGarminTool>[] {
  const dateSpec = {
    type: 'string',
    description: '日期 YYYY-MM-DD；缺省 = 今天',
  } as const

  return [
    defineGarminTool({
      name: 'garmin_whoami',
      description: '返回当前登录的 Garmin 用户显示名。用于确认 token 有效。',
      parameters: {},
      execute: async (_args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(q.whoami()),
    }),
    defineGarminTool({
      name: 'garmin_daily',
      description: '返回指定日期的每日汇总：步数、距离、卡路里、楼层、中高强度分钟、压力、Body Battery、静息心率。',
      parameters: { date: dateSpec },
      execute: async (args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(q.daily(args.date as string | undefined)),
    }),
    defineGarminTool({
      name: 'garmin_sleep',
      description: '返回指定日期夜晚的睡眠数据：总睡眠时长、各阶段、睡眠分、睡眠期 HRV。',
      parameters: { date: dateSpec },
      execute: async (args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(q.sleep(args.date as string | undefined)),
    }),
    defineGarminTool({
      name: 'garmin_hrv',
      description: '返回指定日期的 HRV 摘要：状态（BALANCED/UNBALANCED/LOW）、周均、昨夜均值。',
      parameters: { date: dateSpec },
      execute: async (args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(q.hrv(args.date as string | undefined)),
    }),
    defineGarminTool({
      name: 'garmin_activities',
      description: '返回指定日期区间内的活动列表（跑步/骑行/游泳/力量等），含距离、配速、平均心率、步频、卡路里、训练效果。',
      parameters: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD；缺省 = to - 7' },
        to: dateSpec,
        limit: { type: 'integer', description: '最多返回多少条活动，默认 50' },
      },
      execute: async (args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(
          q.activities({
            from: args.from as string | undefined,
            to: args.to as string | undefined,
            limit: args.limit as number | undefined,
          }),
        ),
    }),
    defineGarminTool({
      name: 'garmin_summary',
      description: '一键打包指定日期的全部数据：daily + sleep + hrv + 当日活动。',
      parameters: { date: dateSpec },
      execute: async (args: Record<string, unknown>, _exec: ToolRunContext) =>
        asJson(q.summary(args.date as string | undefined)),
    }),
  ]
}