/**
 * 通用 HTTP route 注册 helper（dsh 0.1.7 webServer seam）。
 *
 * 官方契约（[deepseek-harness/docs/subsystems/web-server.md]）：
 *   - 路由：{ kind: 'exact' | 'prefix', path, handler }
 *   - handler 自管响应生命周期（普通 fetch 即可，SSE 可保持连接开）
 *   - register(route) 返回 disposer（用于卸载清理）
 *
 * 用法：
 *   installWebRoute(ctx, '/garmin-settings', handler, 'dsh-garmin-coach: settings route')
 */
/// <reference types="node" />
import type { Context } from '@deepseek-ai/cordis';
export type WebRouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>;
/** dsh-host-webserver 的 WebRoute 形态（去 effect 装饰后的最小契约）*/
export interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: WebRouteHandler;
}
/**
 * 在 ctx.webServer 上注册一条命名路由。
 *
 * @param ctx - 插件上下文（cordis context）
 * @param path - 路由路径（无尾斜杠）
 * @param handler - 路由 handler
 * @param label - effect 标签 + 日志前缀（用于 dispose + 排查）
 * @param kind - exact / prefix，默认 exact
 */
export declare function installWebRoute(ctx: Context, path: string, handler: WebRouteHandler, label: string, kind?: 'exact' | 'prefix'): void;
