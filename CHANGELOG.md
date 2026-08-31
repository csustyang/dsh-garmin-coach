# 更新日志

## 未发布

### 🔐 安全
- **禁止保存账号/密码到本地文件**：settings 不再持久化 email/password（移除 schema 字段 + 保存时剥离 + 前端不写回）；MFA 状态文件（mfa-state.json）不再写入 email/password，验证码提交时由请求方把 email 传入
- token 过期（refresh 失效）后自动清除 token，用户需重新输入邮箱和密码登录

### 🐛 修复
- 全量同步完成提示展示真实新增活动数：「已处理 X/Y 个窗口，新增活动 N 条（共 M 条）」，不再只显示窗口数——之前全量同步消息不显示新增数，用户容易误以为同步了 0 条

### ✨ 新功能
- 健康趋势（步数/静息心率/压力/Body Battery）改为和跑量一样的滚动加载：可下拉增量查看更多天数（不再只显示最近 14 天）

### 🔧 清理
- 移除 OAuth1.0a 流程遗留代码（`src/auth/consumer.ts`、`src/auth/oauth.ts`、`GarminConsumerCreds` 类型、`OAUTH_CONSUMER_*` 常量）—— 当前仅跑 DI OAuth2，OAuth1 不支持也不计划回退

### 📚 文档
- README 顶部新增「⚠️ 免责声明」：明确非官方逆向性质、责任免除与「按现状」声明

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
- 25 个 AI 工具（自然语言调用）
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