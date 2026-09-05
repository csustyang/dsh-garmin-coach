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
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
const PLUGIN_ID = 'garmin-coach';
function resolveLogDir() {
    // 与 token 存储一致：$DSH_HOME 优先，否则 ~/.dsh。不要回退到 cwd——
    // DSH 从不同目录启动时日志会写到不同位置，无法统一排查。
    const dshHome = process.env['DSH_HOME']?.trim();
    const profile = process.env['DSH_PROFILE'] ?? 'web';
    const home = dshHome ? dshHome : join(homedir(), '.dsh');
    return resolve(home, 'profiles', profile, 'logs');
}
function ensureLogFile() {
    const logDir = resolveLogDir();
    if (!existsSync(logDir)) {
        try {
            mkdirSync(logDir, { recursive: true });
        }
        catch {
            // 失败也无所谓，最后用 fallback
        }
    }
    return resolve(logDir, `${PLUGIN_ID}.log`);
}
const LOG_PATH = ensureLogFile();
function ts() {
    // 本地时间 + 时区偏移（YYYY-MM-DDTHH:mm:ss.sss+HH:MM）
    // 而不是 toISOString() 的 UTC（YYYY-...Z），后者对中国时区看起来"差 8 小时"
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    const mss = pad(d.getMilliseconds(), 3);
    // 时区偏移（如 +08:00 / -05:00 / +00:00）
    const offMin = -d.getTimezoneOffset(); // 注意 JS 反向：getTimezoneOffset 返回 UTC-本地
    const offSign = offMin >= 0 ? '+' : '-';
    const offAbs = Math.abs(offMin);
    const offHH = pad(Math.floor(offAbs / 60));
    const offMM = pad(offAbs % 60);
    return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}.${mss}${offSign}${offHH}:${offMM}`;
}
function format(level, scope, msg, extra) {
    const base = `[${ts()}] [${level}] [${scope}] ${msg}`;
    if (extra === undefined)
        return base;
    try {
        const detail = extra instanceof Error
            ? `${extra.name}: ${extra.message}\n${extra.stack ?? ''}`
            : typeof extra === 'string'
                ? extra
                : JSON.stringify(extra);
        return `${base}\n${detail}`;
    }
    catch {
        return base;
    }
}
function write(level, scope, msg, extra) {
    try {
        appendFileSync(LOG_PATH, format(level, scope, msg, extra) + '\n', 'utf8');
    }
    catch {
        // 最后兜底：写 stderr 但不 throw
        try {
            process.stderr.write(format(level, scope, msg, extra) + '\n');
        }
        catch {
            /* swallow */
        }
    }
}
export const logger = {
    /** 调试信息，最详细 */
    debug(scope, msg, extra) {
        write('DEBUG', scope, msg, extra);
    },
    /** 一般事件 */
    info(scope, msg, extra) {
        write('INFO', scope, msg, extra);
    },
    /** 警告，但插件仍可继续工作 */
    warn(scope, msg, extra) {
        write('WARN', scope, msg, extra);
    },
    /**
     * 错误。**绝不抛回调用方**——只在文件里记录。
     * 调用方应自己决定是否向用户返回降级响应。
     */
    error(scope, msg, err) {
        write('ERROR', scope, msg, err);
    },
    /** 日志文件路径（用于 Settings 卡片展示给用户） */
    logPath() {
        return LOG_PATH;
    },
};
/**
 * 高阶函数：把任意 async fn 包成"出异常 → 记日志 → 返回降级响应"。
 * 永远不会 throw——所有调用方都可以放心 await。
 */
export function safeAsync(scope, fallback, fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        }
        catch (err) {
            logger.error(scope, `safeAsync caught: ${fn.name ?? 'anonymous'}`, err);
            return fallback;
        }
    };
}
