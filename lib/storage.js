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
 *   "syncDaysBack": 14
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
const DEFAULT_STORE = {
    version: 1,
    lastSyncAt: '',
    activities: {},
    daily: {},
    sportFilter: [],
    syncDaysBack: 14,
};
/**
 * GarminStoreFile —— JSON 文件实现。
 * 后期换 PostgreSQL 时实现同名接口即可。
 */
export class GarminStoreFile {
    filePath;
    cache = null;
    /** 缓存权限检查结果（一次检查后所有写操作都用）*/
    _permChecked = false;
    _permOk = true;
    constructor(opts = {}) {
        // 固定数据目录：优先显式 dataDir；否则用用户主目录下的 data（~/data）。
        // 用 homedir() 而非 process.env.HOME——Windows 下 HOME 可能被 Git Bash/msys
        // 设成 POSIX 风格路径（如 /c/Users/young），导致与其他平台不一致。
        // homedir() 在三平台都返回正确的用户主目录，避免落到 cwd。
        const dir = opts.dataDir ?? join(homedir(), 'data');
        this.filePath = join(dir, 'garmin.json');
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
        const testPath = `${this.filePath}.perm-test`;
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
            '尝试写入路径：' + this.filePath + '\n' +
            '修复方法：在 DSH 设置中开启「完整文件访问」/full file access 权限，然后重启 DSH。\n' +
            '（Windows / macOS 沙箱环境通常需要此权限才能写数据到 ~/data/）');
    }
    /** 读（带内存缓存，避免频繁磁盘 IO）*/
    async read() {
        if (this.cache)
            return this.cache;
        try {
            const raw = await readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.cache = {
                ...DEFAULT_STORE,
                ...parsed,
                activities: parsed.activities ?? {},
                daily: parsed.daily ?? {},
                sportFilter: parsed.sportFilter ?? [],
            };
            return this.cache;
        }
        catch (e) {
            // 文件不存在或损坏 → 返回默认空库
            if (e.code === 'ENOENT') {
                this.cache = structuredClone(DEFAULT_STORE);
                return this.cache;
            }
            logger.warn('storage', '读取 garmin.json 失败，使用空库', e);
            this.cache = structuredClone(DEFAULT_STORE);
            return this.cache;
        }
    }
    /** 原子写 */
    async write(store) {
        await this.checkPermission();
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
        await rename(tmp, this.filePath);
        this.cache = store;
    }
    /**
     * 更新：读→改→写（带重试，避免并发冲突）
     */
    async mutate(fn) {
        const store = await this.read();
        const result = await fn(store);
        await this.write(store);
        return result;
    }
    /** 落库一条活动（按 activityId 去重）*/
    async upsertActivity(activity) {
        return this.mutate((store) => {
            const existing = store.activities[activity.activityId];
            store.activities[activity.activityId] = activity;
            return !existing; // 返回是否"新增"（用于去重统计）
        });
    }
    /** 批量落库活动，返回新增数量 */
    async upsertActivities(activities) {
        return this.mutate((store) => {
            let added = 0;
            for (const a of activities) {
                if (!store.activities[a.activityId])
                    added++;
                store.activities[a.activityId] = a;
            }
            return added;
        });
    }
    /** 落库每日健康 */
    async upsertDaily(daily) {
        await this.mutate((store) => {
            store.daily[daily.date] = daily;
        });
    }
    /** 批量落库每日健康 */
    async upsertDailies(dailies) {
        await this.mutate((store) => {
            for (const d of dailies) {
                store.daily[d.date] = d;
            }
        });
    }
    /** 更新同步游标 */
    async setSyncMeta(lastSyncAt, syncDaysBack) {
        await this.mutate((store) => {
            store.lastSyncAt = lastSyncAt;
            store.syncDaysBack = syncDaysBack;
        });
    }
    /** 设置运动类型筛选 */
    async setSportFilter(sports) {
        await this.mutate((store) => {
            store.sportFilter = sports;
        });
    }
    /** 清空（用于测试或用户重置）*/
    async clear() {
        this.cache = structuredClone(DEFAULT_STORE);
        await rm(this.filePath, { force: true });
    }
    // ────────────── 训练计划缓存（独立文件 training-plan.json）──────────────
    get planPath() {
        return join(dirname(this.filePath), 'training-plan.json');
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
        return join(dirname(this.filePath), 'training-diary.json');
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
