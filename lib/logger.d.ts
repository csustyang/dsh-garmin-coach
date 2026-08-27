/**
 * 插件内部日志：所有异常、warning、info 都写到文件，不污染 DSH 控制台。
 *
 * 路径策略：
 *   - 优先写到 DSH 的 profile 日志目录（与 DSH 主日志相邻）
 *     ~/.dsh/profiles/<profile>/logs/<plugin-id>.log
 *   - 取不到 DSH_HOME 时回退到工作目录 ./logs/<plugin-id>.log
 *
 * 接口参考 DSH 的 ctx.logger（info / warn / error），但落盘而非 stdout。
 */
export declare const logger: {
    /** 调试信息，最详细 */
    debug(scope: string, msg: string, extra?: unknown): void;
    /** 一般事件 */
    info(scope: string, msg: string, extra?: unknown): void;
    /** 警告，但插件仍可继续工作 */
    warn(scope: string, msg: string, extra?: unknown): void;
    /**
     * 错误。**绝不抛回调用方**——只在文件里记录。
     * 调用方应自己决定是否向用户返回降级响应。
     */
    error(scope: string, msg: string, err?: unknown): void;
    /** 日志文件路径（用于 Settings 卡片展示给用户） */
    logPath(): string;
};
/**
 * 高阶函数：把任意 async fn 包成"出异常 → 记日志 → 返回降级响应"。
 * 永远不会 throw——所有调用方都可以放心 await。
 */
export declare function safeAsync<T, A extends unknown[]>(scope: string, fallback: T, fn: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
