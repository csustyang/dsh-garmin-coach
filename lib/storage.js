/**
 * Garmin 数据存储层 —— 独立 JSON 文件，不与其他数据混。
 *
 * 位置：<插件目录>/data/garmin.json（独立于 DSH 的 ~/.dsh/storages/）
 *
 * 结构：
 * {
 *   "version": 1,
 *   "lastSyncAt": "ISO",
 *   "activities": { "<activityId>": ActivityRecord },   // 按 id 去重
 *   "daily": { "<date>": DailyRecord },                 // 每日健康
 *   "sportFilter": ["running", "cycling", ...],         // 运动类型筛选
 *   "syncDaysBack": 30
 * }
 *
 * 设计：
 *  - 原子写（临时文件 + rename），防崩溃损坏
 *  - activities 用对象以 activityId 为 key → 天然去重
 *  - 后期升级 PostgreSQL 时，只需替换本文件的读写实现，
 *    上层查询引擎接口不变。
 */
import { mkdir, readFile, rename, writeFile, rm, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
/** 同步回看天数的硬上限（防 Garmin 服务器过载）*/
export const SYNC_DAYS_BACK_MAX = 30;
/** 全量同步默认起点：距今天数（防新用户点全量同步时直接拉 4+ 年把 Garmin 拉爆）*/
export const FULL_SYNC_DEFAULT_DAYS = 90;
const DEFAULT_STORE = {
    version: 1,
    lastSyncAt: '',
    activities: {},
    daily: {},
    sportFilter: [],
    syncDaysBack: SYNC_DAYS_BACK_MAX,
    fullSyncCursor: '',
};
/**
 * GarminStoreFile —— JSON 文件实现。
 * 后期换 PostgreSQL 时实现同名接口即可。
 */
export class GarminStoreFile {
    dataDir;
    metaPath;
    activitiesPath;
    cache = null;
    activitiesCache = null;
    /** 缓存权限检查结果（一次检查后所有写操作都用）*/
    _permChecked = false;
    _permOk = true;
    constructor(opts = {}) {
        // 固定数据目录：优先显式 dataDir；否则用用户主目录下的 data（~/data）。
        // 用 homedir() 而非 process.env.HOME——Windows 下 HOME 可能被 Git Bash/msys
        // 设成 POSIX 风格路径（如 /c/Users/young），导致与其他平台不一致。
        // homedir() 在三平台都返回正确的用户主目录，避免落到 cwd。
        const dir = opts.dataDir ?? join(homedir(), 'data');
        this.dataDir = dir;
        // 拆 3 文件：
        //   - garmin.json          : meta + daily（启动用，< 300 KB）
        //   - garmin-activities.json: activities（lazy 加载，可能 2+ MB）
        //   - 旧版单一 garmin.json: 兼容读取（检测到旧格式自动迁移）
        this.metaPath = join(dir, 'garmin.json');
        this.activitiesPath = join(dir, 'garmin-activities.json');
    }
    /**
     * 检查写权限（一次性，缓存结果）
     *
     * DSH 沙箱默认没 full access 权限时，写入会失败但错误信息不明确。
     * 这里用写一个临时文件来探测，失败时抛友好错误告诉用户怎么修。
     */
    async checkPermission() {
        if (this._permChecked) {
            if (!this._permOk) {
                throw new Error(this.permissionErrorMessage());
            }
            return;
        }
        this._permChecked = true;
        const testPath = `${this.metaPath}.perm-test`;
        try {
            await writeFile(testPath, 'perm-test', 'utf8');
            await unlink(testPath).catch(() => { }); // 清理失败不影响结果
            this._permOk = true;
        }
        catch (e) {
            this._permOk = false;
            const err = e;
            if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
                // 抛友好错误
                throw new Error(this.permissionErrorMessage());
            }
            // 其他错误（磁盘满、IO 错误等）抛原错
            throw e;
        }
    }
    permissionErrorMessage() {
        return ('DSH 沙箱没 full access 权限，无法写入数据。\n' +
            '尝试写入路径：' + this.metaPath + '\n' +
            '修复方法：在 DSH 设置中开启「完整文件访问」/full file access 权限，然后重启 DSH。\n' +
            '（Windows / macOS 沙箱环境通常需要此权限才能写数据到 ~/data/）');
    }
    /**
     * 读（兼容旧 API：返回完整 store，包括 activities）。
     * 如果存在旧单一 garmin.json，自动迁移到拆 3 文件结构。
     *
     * ⚠️ 注意：为了向后兼容 stats.ts 大量使用 `data.activities`，本方法会同时加载 activities。
     * 如果只要 meta + daily（启动快），用 readMetaOnly()。
     */
    async read() {
        if (this.cache)
            return this.cache;
        await this.migrateFromLegacyIfNeeded();
        const meta = await this.readMetaRaw();
        const activities = await this.readActivities();
        this.cache = {
            ...DEFAULT_STORE,
            ...meta,
            activities,
            daily: meta.daily ?? {},
            sportFilter: meta.sportFilter ?? [],
        };
        return this.cache;
    }
    /**
     * 只读 meta + daily（不加载 activities）。
     * 适合 syncGarmin / dashboardSummary 等只需要元数据的场景。
     * 启动成本从 ~2.5 MB 降到 ~300 KB（实际数据量决定）。
     */
    async readMetaOnly() {
        if (this.cache)
            return this.cache;
        await this.migrateFromLegacyIfNeeded();
        const meta = await this.readMetaRaw();
        this.cache = {
            ...DEFAULT_STORE,
            ...meta,
            activities: {}, // 空，调用方需要时用 readActivities() 显式加载
            daily: meta.daily ?? {},
            sportFilter: meta.sportFilter ?? [],
        };
        return this.cache;
    }
    /** 内部：读 meta 文件原始内容（含 daily）*/
    async readMetaRaw() {
        try {
            const raw = await readFile(this.metaPath, 'utf8');
            return JSON.parse(raw);
        }
        catch (e) {
            if (e.code === 'ENOENT') {
                return {};
            }
            logger.warn('storage', '读取 garmin.json 失败，使用空 meta', e);
            return {};
        }
    }
    /**
     * 加载 activities（懒加载，缓存）。
     * 任何用 activities 的函数（dashboard/recentActivities/sportBreakdown）都要先调这个。
     */
    async readActivities() {
        if (this.activitiesCache !== null)
            return this.activitiesCache;
        await this.migrateFromLegacyIfNeeded();
        try {
            const raw = await readFile(this.activitiesPath, 'utf8');
            const parsed = JSON.parse(raw);
            this.activitiesCache = parsed.activities ?? {};
            return this.activitiesCache;
        }
        catch (e) {
            if (e.code === 'ENOENT') {
                this.activitiesCache = {};
                return this.activitiesCache;
            }
            logger.warn('storage', '读取 garmin-activities.json 失败，使用空记录', e);
            this.activitiesCache = {};
            return this.activitiesCache;
        }
    }
    /** 缓存的 activities 是否已加载（read() 时 activities 永远是空对象）*/
    hasActivitiesLoaded() {
        return this.activitiesCache !== null;
    }
    /** 失效 activities 缓存（写后） */
    invalidateActivitiesCache() {
        this.activitiesCache = null;
    }
    /**
     * 迁移：旧版单一 garmin.json → meta + activities 两个文件
     * 只在第一次 read()/readActivities() 时跑一次（用文件存在性作 marker）
     */
    async migrateFromLegacyIfNeeded() {
        // 如果新文件已存在，无需迁移
        const metaExists = await this.fileExists(this.metaPath);
        const actsExists = await this.fileExists(this.activitiesPath);
        if (metaExists && actsExists)
            return;
        // 旧文件存在吗？
        if (!await this.fileExists(this.legacyFilePath))
            return;
        try {
            logger.info('storage', '检测到旧版 garmin.json，开始迁移到拆 3 文件结构...');
            const raw = await readFile(this.legacyFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            // ⚠️ 关键：legacyFilePath === metaPath（都是 dataDir/garmin.json）
            // 必须**先** rename 旧文件到 .bak，**再**写新文件到原路径，否则会覆盖旧数据
            const bakPath = `${this.legacyFilePath}.bak.${Date.now()}`;
            await rename(this.legacyFilePath, bakPath);
            // 拆：写入 meta + activities
            await this.writeMetaAtomic({
                version: parsed.version ?? 1,
                lastSyncAt: parsed.lastSyncAt ?? '',
                daily: parsed.daily ?? {},
                sportFilter: parsed.sportFilter ?? [],
                syncDaysBack: parsed.syncDaysBack ?? SYNC_DAYS_BACK_MAX,
                fullSyncCursor: parsed.fullSyncCursor ?? '',
            });
            await this.writeActivitiesAtomic(parsed.activities ?? {});
            logger.info('storage', `迁移完成，旧文件备份到 ${bakPath}`);
        }
        catch (e) {
            logger.warn('storage', '迁移失败，继续使用旧文件逻辑', e);
        }
    }
    get legacyFilePath() {
        return join(this.dataDir, 'garmin.json');
    }
    async fileExists(p) {
        try {
            await readFile(p, 'utf8');
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 原子写 meta（version/lastSyncAt/daily/sportFilter/syncDaysBack/fullSyncCursor）
     * 不含 activities（见 writeActivitiesAtomic）。
     */
    async writeMetaAtomic(meta) {
        await this.checkPermission();
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.metaPath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
        await rename(tmp, this.metaPath);
    }
    /** 原子写 activities（独立文件） */
    async writeActivitiesAtomic(activities) {
        await this.checkPermission();
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.activitiesPath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ activities }, null, 2), 'utf8');
        await rename(tmp, this.activitiesPath);
    }
    /** 原子写 */
    async write(store) {
        // 拆 3 文件架构：write(store) 写 meta + 写 activities
        await this.writeMetaAtomic({
            version: store.version,
            lastSyncAt: store.lastSyncAt,
            daily: store.daily,
            sportFilter: store.sportFilter,
            syncDaysBack: store.syncDaysBack,
            fullSyncCursor: store.fullSyncCursor,
        });
        await this.writeActivitiesAtomic(store.activities);
        this.cache = store;
        this.activitiesCache = store.activities;
    }
    /**
     * 更新：读→改→写（带重试，避免并发冲突）
     * 重要：传入的 fn 应该只动 meta + daily（activities 走专门路径）。
     * fn 改 store.activities 不影响最终落盘（write 走 store.activities 当前缓存）。
     */
    async mutate(fn) {
        const store = await this.read();
        const result = await fn(store);
        await this.write(store);
        return result;
    }
    /**
     * 只更新 meta + daily（不读不写 activities）—— 大多数 mutate 路径走这个。
     * 比 mutate() 快（不需要加载 activities 文件）。
     */
    async mutateMeta(fn) {
        const store = await this.read();
        const result = await fn(store);
        // 只写 meta + daily，不动 activities 文件
        await this.writeMetaAtomic({
            version: store.version,
            lastSyncAt: store.lastSyncAt,
            daily: store.daily,
            sportFilter: store.sportFilter,
            syncDaysBack: store.syncDaysBack,
            fullSyncCursor: store.fullSyncCursor,
        });
        this.cache = store;
        return result;
    }
    /** 落库一条活动（按 activityId 去重）*/
    async upsertActivity(activity) {
        // 显式加载 activities 缓存（如果还没加载）
        const cache = await this.readActivities();
        const existing = cache[activity.activityId];
        cache[activity.activityId] = activity;
        await this.writeActivitiesAtomic(cache);
        this.activitiesCache = cache;
        return !existing;
    }
    /** 批量落库活动，返回新增数量 */
    async upsertActivities(activities) {
        const cache = await this.readActivities();
        let added = 0;
        for (const a of activities) {
            if (!cache[a.activityId])
                added++;
            cache[a.activityId] = a;
        }
        await this.writeActivitiesAtomic(cache);
        this.activitiesCache = cache;
        return added;
    }
    /** 落库每日健康 */
    async upsertDaily(daily) {
        await this.mutateMeta((store) => {
            store.daily[daily.date] = daily;
        });
    }
    /** 批量落库每日健康 */
    async upsertDailies(dailies) {
        await this.mutateMeta((store) => {
            for (const d of dailies) {
                store.daily[d.date] = d;
            }
        });
    }
    /** 更新同步游标 */
    async setSyncMeta(lastSyncAt, syncDaysBack) {
        await this.mutateMeta((store) => {
            store.lastSyncAt = lastSyncAt;
            store.syncDaysBack = syncDaysBack;
        });
    }
    /** 全量同步断点游标：读取 */
    async loadSyncCursor() {
        const data = await this.read();
        return data.fullSyncCursor ?? '';
    }
    /** 全量同步断点游标：保存（空串=清除）*/
    async saveSyncCursor(cursor) {
        await this.mutateMeta((store) => {
            store.fullSyncCursor = cursor;
        });
    }
    /** 设置运动类型筛选 */
    async setSportFilter(sports) {
        await this.mutateMeta((store) => {
            store.sportFilter = sports;
        });
    }
    /** 清空（用于测试或用户重置）*/
    async clear() {
        this.cache = structuredClone(DEFAULT_STORE);
        this.activitiesCache = {};
        await rm(this.metaPath, { force: true });
        await rm(this.activitiesPath, { force: true });
    }
    // ────────────── 训练计划缓存（独立文件 training-plan.json）──────────────
    get planPath() {
        return join(this.dataDir, 'training-plan.json');
    }
    /** 读取训练计划缓存 */
    async loadTrainingPlan() {
        try {
            const raw = await readFile(this.planPath, 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /** 保存训练计划缓存 */
    async saveTrainingPlan(plan) {
        // 保留打卡：只在 plan.tasks 里没有 done 字段时才用旧值
        // 这样：1) 同目标保存保留打卡；2) toggleTask 设置的 done 不会被覆盖
        const old = await this.loadTrainingPlan();
        if (old && old.goal === plan.goal && old.tasks && old.tasks.length > 0) {
            const oldDoneMap = {};
            old.tasks.forEach(function (t) { oldDoneMap[t.id] = t.done; });
            // 只补缺漏（新计划任务无 done 字段时用旧值）
            const mergedTasks = (plan.tasks || []).map(function (t) {
                if (t.done !== undefined)
                    return t; // 新计划已有 done，保留
                const wasDone = oldDoneMap[t.id];
                return wasDone === undefined ? t : { ...t, done: wasDone };
            });
            plan = { ...plan, tasks: mergedTasks };
        }
        // 备份旧计划（防止 AI 误判覆盖后找不回）
        if (old) {
            await this.backupPlan(old);
        }
        await this.checkPermission();
        await mkdir(dirname(this.planPath), { recursive: true });
        await writeFile(this.planPath, JSON.stringify(plan, null, 2), 'utf8');
    }
    /** 备份旧计划到 history 目录（带时间戳）*/
    async backupPlan(plan) {
        const historyDir = join(dirname(this.planPath), 'training-plan-history');
        await mkdir(historyDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safeGoal = (plan.goal || 'plan').replace(/[^a-zA-Z0-9一-龥]/g, '_').slice(0, 30);
        const path = join(historyDir, ts + '-' + safeGoal + '.json');
        await writeFile(path, JSON.stringify(plan, null, 2), 'utf8');
    }
    /** 列出计划历史 */
    async listPlanHistory() {
        const historyDir = join(dirname(this.planPath), 'training-plan-history');
        try {
            const files = (await readdir(historyDir)).filter(function (f) { return f.endsWith('.json'); });
            const result = [];
            for (const f of files.sort().reverse().slice(0, 20)) {
                try {
                    const raw = await readFile(join(historyDir, f), 'utf8');
                    const plan = JSON.parse(raw);
                    const done = (plan.tasks || []).filter(function (t) { return t.done; }).length;
                    result.push({
                        file: f,
                        time: f.slice(0, 19).replace(/-/g, ':').replace('T', ' '),
                        goal: plan.goal || '',
                        tasks: (plan.tasks || []).length,
                        done: done,
                    });
                }
                catch { /* 跳过损坏文件 */ }
            }
            return result;
        }
        catch {
            return [];
        }
    }
    /** 从历史恢复一个计划 */
    async restorePlan(file) {
        const historyDir = join(dirname(this.planPath), 'training-plan-history');
        const safeFile = file.replace(/[^a-zA-Z0-9一-龥._-]/g, '');
        const path = join(historyDir, safeFile);
        try {
            const raw = await readFile(path, 'utf8');
            const plan = JSON.parse(raw);
            await this.saveTrainingPlan(plan);
            return { ok: true, message: '已恢复计划：' + (plan.goal || '') + '（打卡 ' + (plan.tasks || []).filter(function (t) { return t.done; }).length + ' 个）' };
        }
        catch (e) {
            return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
    }
    /** 打卡：切换某个训练任务的完成状态 */
    async toggleTask(taskId) {
        const plan = await this.loadTrainingPlan();
        if (!plan)
            return { ok: false, message: '无训练计划' };
        const task = (plan.tasks || []).find(function (t) { return t.id === taskId; });
        if (!task)
            return { ok: false, message: '任务不存在: ' + taskId };
        task.done = !task.done;
        await this.saveTrainingPlan(plan);
        return { ok: true, task };
    }
    /** 统计打卡进度 */
    async planProgress() {
        const plan = await this.loadTrainingPlan();
        if (!plan || !plan.tasks || plan.tasks.length === 0)
            return { done: 0, total: 0 };
        const done = plan.tasks.filter(function (t) { return t.done; }).length;
        return { done, total: plan.tasks.length };
    }
    /** 清除训练计划缓存 */
    async clearTrainingPlan() {
        await rm(this.planPath, { force: true });
    }
    // ────────────── 训练日记（独立文件 data/training-diary.json）──────────────
    get diaryPath() {
        return join(this.dataDir, 'training-diary.json');
    }
    /** 读取全部日记（按日期倒序）*/
    async loadDiary() {
        try {
            const raw = await readFile(this.diaryPath, 'utf8');
            const parsed = JSON.parse(raw);
            return (parsed.entries || []).sort(function (a, b) {
                return b.date.localeCompare(a.date);
            });
        }
        catch {
            return [];
        }
    }
    /** 添加一条日记 */
    async addDiaryEntry(entry) {
        const entries = await this.loadDiary();
        entries.push(entry);
        await this.writeDiary(entries);
        return entry;
    }
    /** 删除一条日记 */
    async removeDiaryEntry(id) {
        const entries = await this.loadDiary();
        const filtered = entries.filter(function (e) { return e.id !== id; });
        if (filtered.length === entries.length)
            return { ok: false };
        await this.writeDiary(filtered);
        return { ok: true };
    }
    /** 写日记到磁盘 */
    async writeDiary(entries) {
        await this.checkPermission();
        await mkdir(dirname(this.diaryPath), { recursive: true });
        await writeFile(this.diaryPath, JSON.stringify({ entries: entries }, null, 2), 'utf8');
    }
}
/** 数据文件路径（给用户/日志看）*/
export function dataFilePath(dataDir) {
    const dir = dataDir ?? join(homedir(), 'data');
    return join(dir, 'garmin.json');
}
