/**
 * Garmin 设置 route —— /garmin-settings
 *
 * 完全参考 dsh-email 的保存方式：
 *   - GET  → 读取当前 settings 值 + revision
 *   - POST {action:'save', value, expectedRevision} → 保存整个表单
 *   - POST {action:'connect', email, password} → 连接（登录）
 *
 * 后端用 ctx.settings.replace(NAMESPACE, value, expectedRevision) 保存。
 */
import { logger } from './logger.js';
export const GARMIN_SETTINGS_NS = 'garmin-coach';
function isLocalhost(remote) {
    return (remote === '127.0.0.1' ||
        remote === '::1' ||
        remote === '::ffff:127.0.0.1' ||
        remote === undefined);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, data) {
    const bytes = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-store',
    });
    res.end(bytes);
}
export function makeGarminSettingsHandler(deps) {
    return async (req, res) => {
        try {
            if (!isLocalhost(req.socket?.remoteAddress)) {
                sendJson(res, 403, { ok: false, error: { message: '仅允许本地访问' } });
                return;
            }
            if (req.method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    settings: {
                        value: deps.getValue(),
                        revision: deps.getRevision(),
                    },
                    writable: deps.isWritable(),
                });
                return;
            }
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: { message: '仅支持 GET/POST' } });
                return;
            }
            const body = JSON.parse(await readBody(req));
            if (body.action === 'save') {
                if (!deps.isWritable()) {
                    sendJson(res, 400, { ok: false, error: { message: 'settings 只读' } });
                    return;
                }
                // 检测账号变化：email 或 isCn 变了 → 清掉旧 token（强制重新连接）
                const oldValue = deps.getValue();
                const newValue = body.value ?? {};
                const accountChanged = (oldValue && newValue.email && oldValue.email !== newValue.email) ||
                    (oldValue && oldValue.isCn !== newValue.isCn);
                await deps.save(newValue, body.expectedRevision);
                if (accountChanged) {
                    try {
                        await deps.clearGarminTokens();
                        logger.info('settings-web', `检测到账号变更（email 或 isCn），已清掉旧 token`);
                    }
                    catch (e) {
                        logger.error('settings-web', '清 token 失败', e);
                    }
                }
                sendJson(res, 200, {
                    ok: true,
                    accountChanged: !!accountChanged,
                    settings: {
                        value: deps.getValue(),
                        revision: deps.getRevision(),
                    },
                });
                return;
            }
            if (body.action === 'sync') {
                const result = await deps.sync();
                sendJson(res, result.ok ? 200 : 400, { ...result });
                return;
            }
            if (body.action === 'syncAll') {
                const from = typeof body.from === 'string' ? body.from : undefined;
                const result = await deps.syncAll(from);
                sendJson(res, result.ok ? 200 : 400, { ...result });
                return;
            }
            if (body.action === 'syncAllProgress') {
                const result = await deps.syncAllProgress();
                sendJson(res, 200, { ...result });
                return;
            }
            if (body.action === 'dashboard') {
                try {
                    const result = await deps.dashboard();
                    sendJson(res, 200, { ok: true, data: result });
                }
                catch (e) {
                    sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
                }
                return;
            }
            if (body.action === 'insights') {
                try {
                    const result = await deps.insights();
                    sendJson(res, 200, { ok: true, data: result });
                }
                catch (e) {
                    sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
                }
                return;
            }
            if (body.action === 'toggleTask') {
                try {
                    const result = await deps.toggleTask(body.taskId ?? '');
                    sendJson(res, result.ok ? 200 : 400, { ...result });
                }
                catch (e) {
                    sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
                }
                return;
            }
            if (body.action === 'connect') {
                const result = await deps.connect(body.email ?? '', body.password, body.mfaCode);
                sendJson(res, result.ok ? 200 : 400, { ...result });
                return;
            }
            sendJson(res, 400, { ok: false, error: { message: '未知 action' } });
        }
        catch (e) {
            logger.error('settings-web', 'route 处理失败', e);
            sendJson(res, 500, {
                ok: false,
                error: { message: e instanceof Error ? e.message : String(e) },
            });
        }
    };
}
/** 注册 /garmin-settings route */
export function installGarminSettingsRoute(ctx, handler) {
    const anyCtx = ctx;
    if (!anyCtx.inject) {
        logger.warn('settings-web', 'ctx.inject 不可用，跳过 route');
        return;
    }
    anyCtx.inject(['webServer'], (webCtx) => {
        const ws = webCtx
            .webServer;
        if (!ws) {
            logger.warn('settings-web', 'webServer 不可用，跳过 route');
            return;
        }
        const dispose = ws.register({
            kind: 'exact',
            path: '/garmin-settings',
            handler,
        });
        webCtx.effect?.(() => dispose, 'dsh-garmin-coach: settings route');
        logger.info('settings-web', '/garmin-settings route registered');
    });
}
