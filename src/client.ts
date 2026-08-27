/**
 * DSH 客户端入口（浏览器侧）。
 *
 * 对齐官方 cookbook/adding-a-settings-card + dsh-market 结构：
 *   1) ctx.slots.inject('settings.section', ...) —— 侧栏导航
 *   2) 嵌套 ctx.inject(['settingsScope'], cb) → settings.plugin.item —— 插件配置卡片
 *
 * 实际发布用 lib/client.js（手写 IIFE bundle，含 React 组件），此文件保持类型同步。
 */

import { createElement as h } from 'react'

export const name = 'dsh-garmin-coach:client'

// cordis 的 unwrapExports 看到 `exports.default` 会丢 sibling 字段（特别是 inject），
// 所以这里只 export 必要字段，不设 default。同时 id 必须与 URL 路径 /plugins/dsh-garmin-coach 一致。
// inject 必须声明 slots/locale/connection/remote/settingsScope，否则 ctx.slots 等访问会 throw。
export const inject = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
] as const

interface ClientContext {
  slots?: {
    inject: (
      slot: string,
      factory: () => {
        name: string
        id: string
        order?: number
        label?: () => string
        locale?: string
        inject?: () => Record<string, unknown>
      },
    ) => () => void
  }
  inject?: (services: string[], cb: (scoped: unknown) => void) => void
  [k: string]: unknown
}

/** Garmin Coach 设置卡片内容 */
function GarminSettingsCard() {
  return h(
    'div',
    { className: 'garmin-coach-settings-card' },
    h('h3', null, 'Garmin Coach'),
    h(
      'p',
      null,
      '佳明账号连接与每日数据同步配置。请在对话中输入「连接 Garmin」或调用 /garmin-dashboard 命令，会引导你完成 email / password / MFA。',
    ),
  )
}

export function apply(rawCtx: unknown): void {
  try {
    const ctx = rawCtx as ClientContext
    if (!ctx.slots?.inject || !ctx.slots.register) {
      console.warn('[dsh-garmin-coach:client] ctx.slots.inject/register 不可用')
      return
    }

    // 1. 插件配置卡片（cookbook/adding-a-settings-card）
    ctx.slots.inject('settings.plugin.item', () => {
      return ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'garmin-coach',
        locale: 'settings.plugins',
        inject: () => ({}),
      }, GarminSettingsCard)
    })

    console.info('[dsh-garmin-coach:client] settings.plugin.item slot registered (key=garmin-coach)')
  } catch (e) {
    console.error('[dsh-garmin-coach:client] apply failed', e)
  }
}
