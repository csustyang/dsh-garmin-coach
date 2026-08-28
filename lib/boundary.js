/**
 * 错误边界工具：把插件内任何对 DSH seam 的调用都包起来，
 * 出错时记日志 + 返回安全默认值，绝不抛出到 DSH 主进程。
 *
 * 涵盖：
 *   - ctx.tools.register 的 execute 函数
 *   - ctx.settings.registerCard 的 action.run 函数
 *   - ctx.schedule.register 的 job.run 函数
 *   - ctx.commands.register 的 handler 函数
 *   - apply(ctx) 自身的每个分支
 */
import { logger } from './logger.js';
/**
 * 包一个 async function：异常被吞掉、记录、返回 fallback。
 *
 * 用途：
 *   const safeExecute = withBoundary(
 *     { scope: 'tools.garmin_daily' },
 *     async (args) => q.daily(args.date),
 *   )
 *   ctx.tools.register({ ..., execute: safeExecute })
 */
export function withBoundary(opts, fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        }
        catch (err) {
            logger.error(opts.scope, `boundary caught error from ${fn.name ?? 'anonymous'}`, err);
            return opts.fallback;
        }
    };
}
/**
 * 把 sync function 也包起来（不需要 await 但可能被 throw 的情况）。
 */
export function withBoundarySync(opts, fn) {
    return (...args) => {
        try {
            return fn(...args);
        }
        catch (err) {
            logger.error(opts.scope, `boundary(sync) caught error from ${fn.name ?? 'anonymous'}`, err);
            return opts.fallback;
        }
    };
}
/**
 * 把一段代码块包起来：异常 → 日志 → fallback。
 * 用于 apply() 内部的多分支。
 */
export async function tryBlock(scope, fallback, fn) {
    try {
        return await fn();
    }
    catch (err) {
        logger.error(scope, 'tryBlock caught', err);
        return fallback;
    }
}
