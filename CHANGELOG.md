# 更新日志

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