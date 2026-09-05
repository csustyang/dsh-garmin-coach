# 更新日志

## 0.2.2（2026-09-05）— sleep 端点合并 + 写锁并发安全 + 未连接短路

### 🐛 修复
- **睡眠时长偏差 ~26 分钟**：`syncGarmin` 现在并发拉 `daily + sleep` 两个端点，并通过 `mergeDailyRaws` 让 sleep 端点的 `dailySleepDTO.sleepTimeSeconds` **覆盖** daily 端点顶层的 `sleepingSeconds`。原因：daily 顶层 sleepingSeconds 包含 ~15-30 分钟的"躺床缓冲期"（非睡眠时间），sleep 端点的 sleepTimeSeconds 才是"实际睡眠"——手表 App 显示的值。之前 `sleepSeconds` 兜底用了 daily 顶层的宽口径值，导致睡眠时长比手表显示多出 ~26 分钟
- **并发 mutate 撞车导致数据丢失 / ENOENT**：sync 主循环是 `await` 串行的，但训练补全是 fire-and-forget 的 `upsertDaily`，会和主循环的 `mutateMeta` 同时写 tmp 文件然后 `rename`，第二个 rename 经常碰到第一个还没落盘的中间态 → 偶发 ENOENT / 数据丢失。`GarminStoreFile` 新增 `writeLock`（meta/activities 共享一把锁），所有原子写操作都走 `withLock()` 串行化
- **`syncGarmin` 未连接账号静默"成功"**：旧版没 token 时调用会一路走完（拉 daily/sleep 全部报 401）才返回 `error: undefined, synced: false`，用户看到的是空成功消息。现在入口处 `await queries.isConnected()` 短路，**未连接直接返回明确错误**（"未连接佳明账号，请先在设置中点击「连接佳明」"），并 warn 日志
- **`sleepSeconds` 兜底逻辑**：移除 daily 顶层 sleepingSeconds 兜底，只用 sleep 端点的 sleepTimeSeconds（避免上面那条 bug 再次回退）。如果 sleep 端点失败 / 缺失则 sleepSeconds = undefined（前端显示 `—`）

### ✨ 新功能
- **夜间生理字段入库**：`DailyRecord` 新增 4 个字段（来自 sleep 端点 `dailySleepDTO` + 顶层）：
  - `sleepAvgHeartRate`（睡眠平均心率，sleep 端点）
  - `avgRespiration`（平均呼吸率）
  - `lowestRespiration`（最低呼吸率）
  - `avgOvernightHrv`（平均夜间 HRV，sleep 端点顶层字段）
  - 已加进 `DailyRecord` 类型 + `toDailyRecord` 解析逻辑 + `lib/*.d.ts` 类型声明。前端详情浮层暂未渲染（等用户确认展示位置后再加）
- **`GarminQueries.isConnected()`**：新增接口方法 `isConnected(): Promise<boolean>`，包装 `client.hasToken()`，供 sync 入口判断 + 未来 UI（设置页"已连接/未连接"状态指示）使用

### 🔧 重构
- `GarminStoreFile.writeMetaAtomic` / `writeActivitiesAtomic` 改为 `withLock(async () => ...)` 包裹，私有方法实现不变
- `mergeDailyRaws` 签名加 `sleepRaw` 参数（插在 `dailyRaw` 后、`hrvRaw` 前），旧调用点同步更新
- `toDailyRecord` 改为只读 sleep 端点的 `sleepTimeSeconds`，不再使用 daily 顶层的宽口径值

### 📦 构建产物
- `lib/api/queries.{js,d.ts}` / `lib/storage.{js,d.ts}` / `lib/sync.{js,d.ts}` / `lib/client.js` 由 `npm run build` 重新生成

## 0.2.1（2026-09-01）— 健康数据过滤 + 心率修正 + 默认天数保护


### 🔐 安全
- **禁止保存账号/密码到本地文件**：settings 不再持久化 email/password（移除 schema 字段 + 保存时剥离 + 前端不写回）；MFA 状态文件（mfa-state.json）不再写入 email/password，验证码提交时由请求方把 email 传入
- token 过期（refresh 失效）后自动清除 token，用户需重新输入邮箱和密码登录

### 🐛 修复
- 全量同步完成提示展示真实新增活动数：「已处理 X/Y 个窗口，新增活动 N 条（共 M 条）」，不再只显示窗口数——之前全量同步消息不显示新增数，用户容易误以为同步了 0 条
- 备份位置调整：增量同步不再备份（按 activityId 去重 upsert 天然幂等），仅全量同步开始前备份 `garmin.json` —— 增量同步每次都备份既浪费 IO、又会留下大量 `.bak.*` 孤儿文件；全量同步覆盖大量数据时存在中间态风险，必须保留备份安全网
- **同步回看天数加 30 天硬上限**：健康数据走单日端点（每天 1 次调用），窗口过大（如 syncDaysBack=90/365）会拉爆 Garmin 服务器。新增两道防御：① `index.ts` 调用点 `Math.min/max` 截断（防 settings 文件被绕过 schema 修改）；② `syncGarmin` 入口处再截断一次（防外部直接调用），截断时输出 warn 日志。**不再在 schema 上加 `.max(30)`** —— 历史脏数据（如用户旧版手动设的 90）会被 schema 拒绝、导致整个 settings namespace 注册失败、所有保存操作静默失效（DSH 永远显示 fallback 默认值、revision 一直为 0）。实际拉取天数的硬上限只靠代码层保证。默认 `syncDaysBack` 从 14 → 30
- **全量同步默认起点改 90 天前**：新用户首次点全量同步不再默认从 `2022-01-01` 拉 4+ 年（≈13 窗口）—— 改为距今 90 天（≈1-2 窗口）。用户主动在 UI 输入更早日期或 `settings.fullSyncFrom` 设置才会拉历史。立即同步的 `syncDaysBack` 上限仍是 30 天，两者分开管
- **前端 UI（`lib/client.js`）同步改造**：输入框 `max="90" → 30`、标签 "1-90 → 1-30"、按钮 fallback `90 → 30`、`EMPTY.syncDaysBack` 默认14 → 30、全量同步默认起点 2022-01-01 → 距今 90 天前。所有前端 magic number 都改为引用前端内的 `SYNC_DAYS_BACK_MAX = 30` 常量（与 `src/storage.ts` 保持一致）
- **过滤空 daily payload**：旧版 `syncGarmin` 不管 API 返回 200+空对象（账号当天没设备记录）都会写一条"全是 undefined"的 daily 入库，污染"健康数据 N 天"统计。新增 `isEmptyDailyPayload()` 判断，daily 全字段 undefined 时不入库。新增 `scripts/clean-empty-dailies.ts` 一次性清理工具给老用户用
- **压力值 -1 显示成 `—`**：Garmin `stressAvg = -1` 是"未检测到压力"的合法占位，跟 null/undefined 一样没数据。前端表格之前用 `!= null` 判断，会把 -1 原样显示成 "-1"；现在改为 `!= null && !== -1`，正确显示成 `—`。同步修了 `lib/client.js` 健康趋势压力数组（KPI 压力平均数）和 `src/stats.ts` `avgStress` 计算，确保 -1 不参与压力均值
- **`stressAvg=-1` 配套字段 `stressQualifier=UNKNOWN` 的语义澄清**：Garmin 后端约定 `stressQualifier='UNKNOWN'` 时 `averageStressLevel=-1` 是"未检测到压力"占位。`stats.ts` 之前的判断用 `dd.stressAvg` truthy 检查，把 -1 当有效值算进 dailyRecent 和压力均值。现已改为 `stressAvg > 0` 才算有效，并补全了 dailyRecent 的"有数据的天"判断（参考活动强度字段 activeKilocalories/highlyActiveSeconds 等，避免漏掉只有活动强度没步数的日子）。`stressAvg=-1` 的记录**不清理**，保留作为"该天压力未检测到"的事实证据
- **健康趋势表行位详情 + 列编辑**：仿照最近活动，每行行尾加 📊 详情按钮，点击打开页面中间浮层，按"活动量 / 心率 / 压力 / Body Battery / 睡眠"5 个分组展示当日的全部健康指标（HRV 和训练准备度 dccc461 之后又停用，2 组已删除）（自动过滤掉空字段）；表头右上角加 ✏️ 编辑按钮，可勾选 14 个候选列（步数/静息心率/压力/Body Battery/距离/活动消耗/最低心率/最高心率/平均心率/睡眠时长/睡眠分/HRV 状态/HRV 周均/训练准备度），默认显示 4 个核心指标（步数 / 静息心率 / 最低心率 / 睡眠时长——当前 lib/client.js HEALTH_DEFAULT_COLS 实际值；dccc461 之后又调整）。浮层和编辑面板都支持 Esc / 点击遮罩 / ✕ 三种关闭方式
- **健康详情浮层数据完整性修复**：`stats.ts` 的 `dailyRecent` 之前只推 7 个字段（steps/restingHeartRate/stressAvg/bodyBattery/totalDistanceMeters/activeKilocalories + date），导致详情浮层大部分组（心率细分/睡眠/HRV/训练准备度）永远空。现在推全 20 个字段，与 `DailyRecord` 类型一致
- **`fmtTime(0)` 修正确认显示 `0`**：之前 `if (!sec) return '—'` 把 `0`（"用户没动"）也当无数据。现在 `0` 显示成 `0`，只有 `null/undefined` 显示成 `—`。所有调用点（活动时长/睡眠/久坐等）的 0 值都能正确显示
- **`stressQualifier='UNKNOWN'` 显示成 `—`**：跟 `stressAvg=-1` 一样，Garmin 的 `UNKNOWN` 状态表示"未检测到压力"，对用户来说等同于无数据。详情浮层 get 函数 + 浮层过滤器都加了 `!== 'UNKNOWN'` 判断，未检测到的日子不再展示这个字段
- **过滤"无意义 daily"（整天没戴表）**：之前 `isEmptyDailyPayload` 只检查9 个字段（是否 undefined），但 Garmin 会返回 `steps=null + sedentary=86400 + stressAvg=-1 + 其他全是0/空` 这种"整天没戴表"的脏数据——之前能穿过过滤入库。现在加强检查：所有"真实健康指标"（steps/activeKilocalories/restingHeartRate/bodyBattery/stressAvg>0/HRV/睡眠/训练准备度 等）必须任一有真值才入库。`stressAvg <= 0`、`stressQualifier === 'UNKNOWN'` 都算无效占位。`clean-empty-dailies.ts` 脚本同步升级到新规则，可清理历史脏数据
- **移除错误的"平均心率"字段**：Garmin 没直接给"全天平均心率"。旧代码用 `minAvgHeartRate`（最低活动段平均心率）当"平均心率"展示，会误导用户（看起来像全天均值实际只是某个段）。完全移除 `avgHeartRate` 字段（storage 类型 + stats dailyRecent + 前端浮层/列编辑/列渲染）。详情浮层心率组从 4 项减为 3 项（静息/最低/最高），列编辑候选从 14 列减为 13 列
- **心率假数据过滤**：`minHeartRate=75, maxHeartRate=75, restingHeartRate=null, steps=null, sedentary=86400` 这种数据是"表整天没戴"——Garmin 后端填默认静息心率 75 作为占位。真采样的心率一定有波动（min ≠ max）。`isEmptyDailyPayload` 和 `clean-empty-dailies.ts` 都改为：只有 `minHeartRate >0 && maxHeartRate >0 && minHeartRate !== maxHeartRate` 才算心率"有真值"。能识别 2 条历史脏数据（07-19、08-16）
- **"整天没动"判定升级**：`sedentarySeconds=86400` 本身不一定是无意义（可能含睡眠时间）。改为看 `activeSeconds=0 && highlyActiveSeconds=0 && activeKilocalories=0 && steps=0/null`——这才是真"整天没动/没戴表"。这种天即使有 `bodyBattery`（手表自算字段）也不算有意义，因为它不能反映用户健康状态。能识别 8 条历史脏数据（之前只有 2 条）
- **健康表默认列调整**：把 `压力` 和 `Body Battery` 从默认列里去掉，改成 `最低心率` + `最高心率`（用户日常看心率范围比压力/电池更实用）。`HEALTH_DEFAULT_COLS` 从 `['steps', 'restingHeartRate', 'stressAvg', 'bodyBattery']` 改为 `['steps', 'restingHeartRate', 'minHeartRate', 'maxHeartRate']`。`HEALTH_ALL_COLS` 编辑面板里把心率三连（静息/最低/最高）放一起
- **最近活动编辑按钮改到表头右上角**：跟健康趋势的 ✏️ 布局一致——每行不再带 ✏️ 按钮（每行只需 📊 详情），✏️ 编辑按钮挪到 h3 旁（`📅 最近活动 ✏️`），全表共用同一编辑面板。删除表头 ✏️ 列 + 每行 ✏️ 按钮列，`colSpanTotal` 从 `colMeta.length + 1` 改为 `colMeta.length`
- **健康趋势表按日期倒序**：之前后端按 i=89→0 生成 dailyRecent 是升序（最远的日期在最上面），跟用户期望的"最新一天在最上面"相反。前端按 `date` desc 排序后再渲染表体，总数 / 健康 KPI / 滚动加载判断不变
- **健康趋势表头滚动时固定**：之前表头 `<thead>` 在滚动容器内，向下滑动时跟着消失，看不到列名。CSS 用 `position: sticky; top: 0` + `background: var(--dsw-alias-bg-layer-1)` + `z-index: 1` 让 `<th>` 滚动时吸顶
- **常量提取**：`FULL_SYNC_DEFAULT_DAYS = 90` 提到 `src/storage.ts` 作为导出常量（与 `SYNC_DAYS_BACK_MAX = 30` 风格统一），`src/index.ts` 全量同步 handler 改为引用常量，不再内联 magic number
### ✨ 新功能
- 健康趋势（步数/静息心率/压力/Body Battery）改为和跑量一样的滚动加载：可下拉增量查看更多天数（不再只显示最近 14 天）

### 🔧 清理
- 移除 OAuth1.0a 流程遗留代码（`src/auth/consumer.ts`、`src/auth/oauth.ts`、`GarminConsumerCreds` 类型、`OAUTH_CONSUMER_*` 常量）—— 当前仅跑 DI OAuth2，OAuth1 不支持也不计划回退

### 📚 文档
- README 顶部新增「⚠️ 免责声明」：明确非官方逆向性质、责任免除与「按现状」声明



## 未发布

### 🐛 健康数据补齐
- **同步端点从 1 → 2**：之前只调 `daily` 端点（CN usersummary-service），所以 sleep/HRV/Readiness/Training 字段**从未入库**。**方案演进**：
  - v1: daily + sleep + hrv + readiness + training（5 端点，150 次调用）
  - v2: daily + hrv + readiness + training（4 端点，去掉 sleep 因 daily 内嵌 dailySleepDTO，120 次调用）
  - v3: daily + training（2 端点，停用 hrv/readiness 因为用户不用这些数据，61 次调用）
- 通过 `mergeDailyRaws` 合并多端点数据到统一 raw 格式
- **睡眠字段扩展**：原来只解析 `sleepSeconds + sleepScore`，现在解析 10 个字段（睡眠时长/分/深睡/浅睡/REM/睡眠中清醒/清醒次数/午睡时长/睡眠血氧均值+最低）
- **空 daily 过滤**：`isEmptyDailyPayload` 判断"整天没动 + 全 0/空"的情况（步数=0、活动=0、心率=0、BB=0、stressAvg=-1 等），不入库
  - 心率真采样要求 `min !== max`（Garmin 后端对"没戴表"会填默认 75 作为占位）
  - "整天没动"判定：`activeSeconds=0 && highlyActiveSeconds=0 && activeKilocalories=0 && steps=0`（即使有 BB 也不算有意义）
  - 压力 `-1` 和 `stressQualifier='UNKNOWN'` 视为无效占位
- **健康趋势表行位详情 + 列编辑**：每行尾加 📊 详情按钮，浮层按"活动量/心率/压力/BB/睡眠"5 个分组展示当天全部指标；表头右上角加 ✏️ 编辑按钮，可勾选 13 个候选列
  - 默认列：`[步数, 静息心率, 最低心率, 睡眠时长]`（用户日常用）
  - 之前默认有 `压力/BB`，已改成 `最低/最高心率`（更实用）
  - 浮层/编辑面板支持 Esc / 点击遮罩 / ✕ 三种关闭
- **健康趋势表头滚动时固定**：CSS `position: sticky; top: 0` 让表头吸顶

### 🐛 同步逻辑修复
- **同步日期时区 bug 修复**：`new Date('2026-09-03T00:00:00')` 是 UTC 0 点（中国时区 8:00），加 `setDate + toISOString` 后 `dayBefore` 错算 1 天，导致**永远漏掉今天**。改用本地日期 `new Date(y, m-1, d)` + `getFullYear/Month/Date` 修复
- **HRV/Readiness 端点停用**：用户日常不用这两个数据，移除调用节省 API。`syncGarmin` 改为只调 daily + training，HRV/readiness 端点完全不调。删除 `Storage.DailyRecord` 的 `hrvStatus/hrvWeeklyAvg/readinessScore` 字段 + `stats.ts` healthKPI 的 `avgHrv/lastHrvStatus` 字段 + 前端详情浮层"HRV/训练准备度"组 + 列编辑对应列 + renderHealthCell 对应 case
- **204 No Content 优雅处理**：Garmin HRV 等端点对"当天没数据"返回 204（0 字节 body），之前 `JSON.parse('')` 抛错被吞掉。改为 `apiGet` 显式判断 204 / 0B → 返回 null，日志显示 `no-data` 而不是误导的"JSON 解析失败"
- **HRV/Readiness/Training 异步补全**：之前 `syncGarmin` 用 `Promise.all` 等 4 端点全部返回，耗时 = max(所有端点) ≈ 2-3 秒。改为**daily 同步入库 + 其他端点后台异步补全**（fire-and-forget），主流程耗时从 ~5 秒降到 ~1 秒（只等 daily 端点 ~0.4 秒）

### 🚀 性能
- **拆 3 文件存储**：原 `garmin.json`（2.5 MB 单文件）→ `garmin.json`（meta + daily，~100 KB）+ `garmin-activities.json`（activities，~1.75 MB）
  - **启动不再加载 activities**：`read()` 默认只读 meta + daily；`syncGarmin` 改用 `readMetaOnly()`
  - 升级自动迁移：第一次 `read()` 检测到旧单一 `garmin.json` 拆分到新结构，旧文件备份成 `.bak.<timestamp>` 不删
- **API 请求详细日志**：每个请求都打 `→ GET <URL>` + `← 200 (<elapsed>ms, body=<N>B, <summary>)`，方便排查同步问题
- **日志时间改本地时区**：之前用 `toISOString()` 输出 UTC（末尾 `Z`），中国时区看日志"差 8 小时"。改成本地时间 + 偏移（`2026-09-04T07:46:09.548+08:00`）——ISO 8601 标准 + 肉眼可读
- **常量提取**：`SYNC_DAYS_BACK_MAX = 30` 和 `FULL_SYNC_DEFAULT_DAYS = 90` 都提到 `src/storage.ts` 导出常量，引用统一

### 🛠️ UI 改进
- **前端 UI（`lib/client.js`）同步改造**：输入框 `max=90 → 30`、标签 "1-90 → 1-30"、按钮 fallback `90 → 30`、`EMPTY.syncDaysBack` 默认 14 → 30
- **最近活动编辑按钮挪到表头右上角**：跟健康趋势一致，每行只带 📊 详情，✏️ 在 h3 旁共用同一编辑面板
- **`fmtTime(0)` 修正**：之前 `if (!sec) return '—'` 把 0 也当无数据，现在 `0` 显示成 `0`（"用户没动"是合法状态）
- **健康详情浮层数据完整性**：`stats.ts` 的 `dailyRecent` 之前只推 7 字段，详情浮层大部分组永远空。现在推全 20 字段

### 🐛 其他修复
- **全量同步完成提示展示真实新增数**：之前消息只显示窗口数（"已处理 X/Y 个窗口"），现在显示新增活动数（"新增 N 条，共 M 条"）
- **备份位置调整**：增量同步不再备份（按 activityId 去重天然幂等），仅全量同步开始前备份
- **同步回看天数加 30 天硬上限**：两道防御：① 调用点 `Math.min/max` 截断；② `syncGarmin` 入口再截断（防外部直接调用）。**不**在 schema 加 `.max(30)` —— 历史脏数据（90/365）会被 schema 拒绝、导致整个 settings namespace 注册失败
- **全量同步默认起点改 90 天前**（之前 `2022-01-01` 拉 4+ 年）
- **移除错误的"平均心率"字段**：Garmin 没给"全天平均心率"，旧代码用 `minAvgHeartRate`（最低活动段平均）当全天均值是错的。完全移除 `avgHeartRate`
- **健康表默认列调整**：把 `压力` 和 `Body Battery` 从默认列里去掉，改成 `最低心率` + `最高心率`

### 🧹 清理
- 删除一次性脚本：`scripts/clean-empty-dailies.ts`（清理历史脏数据，任务已完成）、`scripts/clear-synced-data.ts`（清空脚本，使用场景过于个性化）
- `.gitignore` 加 `.dsh-vision-toolkit/`（DSH vision-toolkit 本地缓存）

## 0.2.0（2026-08-30）— 看板大升级：运动分组展示 + 详情浮层 + 全量同步

### ✨ 新功能
- 最近活动按运动类型分组为 7 个 tab（跑步/步行/徒步/骑行/登山/有氧/球类），每个 tab 独立默认列 + 可编辑保存
- 行尾 📊 详情浮层：按运动类型展示同步到的字段（字段级过滤，无该字段不显示），支持遮罩/✕/Esc 关闭
- 全量同步：用户指定起始日期，按 100 天分批拉取历史活动（随机 1-3s 间隔防限流），后台异步 + 进度轮询 + 断点续传
- 自定义显示字段按运动类型过滤（availableCols），不再全类型相同
- 运动类型中文化补全（有氧/羽毛球/跑步机/温度等 60+ 类型）
- 设置卡片布局重构：分区展示、按钮统一样式
- 训练负荷/卡路里效率可折叠（默认折叠）；星期分布/运动类型分布默认展开
- 各长列表（最近活动/训练负荷/卡路里/跑量/训练计划）增量滚动加载防卡顿
- Markdown 渲染训练计划（标题/列表/加粗）

### 🐛 修复
- 0.1.4 工具注册崩溃（output.schema {} → { type: 'json' }）
- 跨平台路径统一到 DSH home（token/日志不再依赖 process.cwd()）
- aerobicTrainingEffect → trainingEffect 解析 bug
- maxSpeed/温度/海拔/移动时间等字段未解析导致 NaN 或显示 —
- React Hooks 规则违反导致卡片空白（hooks 移到组件顶部）
- 修复 0.1.4 发布版所有工具注册失败的问题

### 🔧 优化
- dashboardSummary 返回全量活动（去 raw 精简体积 + 补 parentTypeId）
- render 纯字符串不再加 JSON 引号
- 有氧/无氧效果保留一位小数

## 0.1.3（2026-08-29）— 精简工具集 + 账号切换

### 🔧 优化
- 移除 8 个低频工具：readiness / training / weekly / distance_stats / daily_stats / sport_breakdown / clear_training_plan / plan_history（精简 AI 工具列表，保持 6 基础 + 5 统计）
- README 补「bundles 手动加载」说明 + 一键安装流程

### ✨ 新功能
- settings-web：检测到账号变更（email 或 isCn）自动清掉旧 token，提示用户重新连接
- 连接成功后把 displayName / status 写回 settings（避免"已连接"但"当前用户"显示空）

### 🧪 测试
- 同步工具数量断言（≥ 11）

## 0.1.2（2026-08-29）— 兼容性修复

### 🐛 修复
- 适配 DSH 框架 commands.register 新契约（name/handler），修复公司电脑报"value must be a string"
- whoami() 工具在未连接账号时直接返回友好字符串，避免 withBoundary 兜底对象违反 string schema
- storage Windows 路径 bug：用 `path.dirname` 替代 `lastIndexOf('/')`（macOS/Linux 兼容）

### 🧪 测试
- 新增回归测试集 64+ 用例（contracts/unit 分层）
- 新增 storage-permission 回归测试

### 📚 文档
- README 加「文件写入权限」章节（说明 DSH 沙箱需要 full access）
- README 区分 macOS/Linux（`~/data/`）和 Windows（`<DSH_cwd>\data\`）数据路径

## 0.1.1（2026-08-28）— npm 发布修复

- 移除 `package.json` 的 `private: true` 字段（npm publish 要求）
- 同步 `package-lock.json`

## 0.1.0（2026-08-26）— 首次发布

### ✨ 功能
- Garmin Connect 同步（CN + 国际，DI OAuth2 + MFA）
- token 自动 refresh（~28h，refresh 失效时降级提示重新连接）
- 增量数据同步（从上次同步日期开始，避免重复拉全量）
- 数据存储在 `~/data/`（garmin.json + training-plan.json + training-diary.json）
- 运动看板（侧栏入口 + 打开挂载/卸载刷新 + 30+ 分析）
- 最近活动表（运动类型筛选 + 日期/距离/配速/心率排序）
- 心率区间时长（真实 hrTimeInZone_1~5 + 有氧/无氧分类）
- 最近活动心率/时长列 + 按钮展开详情
- AI 训练建议（规则生成 8 类洞察：PB/跑量/频率/步频/HR-Pace/爬升/卡路里/稳定性）
- 训练计划看板（折叠/展开 + 16 任务可打卡）
- 训练日记（感受/评分/时间线）
- 训练计划缓存（同目标保留打卡 + 跨年不丢）
- 训练计划历史/恢复（AI 误判覆盖可找回）
- 周报/月报/季报/年报/自定义日期范围报告工具
- 20 个 AI 工具（9 个 Garmin 数据 + 11 个统计，自然语言调用）
- DSH 上下文压缩启用（避免切换模型消耗过大 token）
- 数据路径统一（`process.env.HOME/data`，开发/DSH 一致）

### 🔐 安全
- 邮箱密码用 DSH `secret` role（浏览器拿不到）
- 数据只存本地，不上传任何服务器
- 仅与 Garmin API 直连（无中间服务）
- 无定时同步（防 Garmin 行为指纹检测）
- 重试验证必须用户同意（防账号封禁）

### 🛠️ 技术
- TypeScript + Node.js（DSH 插件标准）
- Cordis 注入 + dsh-settings + dsh-tools
- 前端 React IIFE（无打包工具）
- 增量同步 + 数据指纹（避免重复生成训练计划）

## 计划中

- 报告看板展示（直接在看板看月报）
- 健康数据分析（HRV/睡眠趋势）
- 多运动类型专项分析（骑行/游泳）
- 数据导出（CSV/JSON）