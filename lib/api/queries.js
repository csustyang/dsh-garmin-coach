/**
 * Garmin Connect 数据查询的 LLM-facing 接口。
 *
 * 这 9 个函数对应 ai-skill-garmin 的 9 个 CLI 子命令：
 *   whoami / daily / sleep / hrv / readiness / training / activities / summary / weekly
 *
 * 每个函数返回 unknown（透传 Garmin JSON）。上层包装成 ctx.tools 时再做 schema 化。
 */
function today() {
    return new Date().toISOString().slice(0, 10);
}
function addDays(date, days) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
export function makeQueries(client) {
    return {
        async whoami() {
            // 未连接账号时直接返回友好字符串，避免 withBoundary 兜底对象违反 string schema
            if (!(await client.hasToken())) {
                return '未连接 Garmin账号，请到 设置 → Garmin Coach 连接账号';
            }
            const api = await client.getApi();
            return api.displayName;
        },
        async isConnected() {
            return await client.hasToken();
        },
        async daily(date) {
            const api = await client.getApi();
            return api.daily(date ?? today());
        },
        async sleep(date) {
            const api = await client.getApi();
            return api.sleep(date ?? today());
        },
        async hrv(date) {
            const api = await client.getApi();
            return api.hrv(date ?? today());
        },
        async readiness(date) {
            const api = await client.getApi();
            return api.readiness(date ?? today());
        },
        async training(date) {
            const api = await client.getApi();
            return api.training(date ?? today());
        },
        async activities({ from, to, limit = 50 }) {
            const api = await client.getApi();
            const end = to ?? today();
            const start = from ?? addDays(end, -Math.max(1, (limit ?? 50) > 50 ? 30 : 7));
            return api.activities(start, end, limit);
        },
        async summary(date) {
            const api = await client.getApi();
            const d = date ?? today();
            const [daily, sleep, hrv, readiness, training, activities] = await Promise.all([
                api.daily(d).catch(() => null),
                api.sleep(d).catch(() => null),
                api.hrv(d).catch(() => null),
                api.readiness(d).catch(() => null),
                api.training(d).catch(() => null),
                api.activities(d, d).catch(() => []),
            ]);
            return { date: d, daily, sleep, hrv, readiness, training, activities };
        },
        async weekly(endDate) {
            const api = await client.getApi();
            const end = endDate ?? today();
            const start = addDays(end, -6);
            const days = [];
            for (let i = 0; i < 7; i++) {
                const d = addDays(start, i);
                const [daily, sleep] = await Promise.all([
                    api.daily(d).catch(() => null),
                    api.sleep(d).catch(() => null),
                ]);
                days.push({ date: d, daily, sleep });
            }
            const activities = await api
                .activities(start, end, 100)
                .catch(() => []);
            return { from: start, to: end, days, activities };
        },
    };
}
