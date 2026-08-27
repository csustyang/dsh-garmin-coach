/**
 * DSH 客户端入口（浏览器侧）。
 *
 * 通过 `ctx.slots.inject('settings.section', ...)` 注册 Settings 面板侧栏导航项。
 * DSH 客户端内核会调 `apply(ctx)`。
 *
 * 同样遵守"全局 try-catch"原则——浏览器侧的异常也不能让 Settings 整体挂掉。
 */
export declare const name = "dsh-garmin-coach:client";
export declare function apply(rawCtx: unknown): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export default _default;
