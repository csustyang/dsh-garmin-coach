# Garmin Coach（DSH Garmin 运动 AI 教练）

**Garmin Connect 同步 + AI 教练分析 + 训练计划生成** — DeepSeek Harness 插件。

把你的 Garmin 账号连到 DSH，自动同步活动/健康/HRV 数据，AI 基于真实数据给出专业训练建议。

## ✨ 功能

| 模块 | 内容 |
|---|---|
| 🔐 **认证** | CN 账号 + 短信 MFA + DI OAuth2（token ~28h，自动 refresh） |
| 📊 **数据同步** | 增量同步（不重复拉全量），手动触发（防 Garmin 行为指纹检测） |
| 📈 **运动看板** | 30+ 分析（距离/配速/心率/HR-Pace/步频/TRIMP/时段/一致性等）|
| 🤖 **AI 训练建议** | 规则生成洞察（PB 变化、跑量趋势、步频建议等）|
| 📋 **训练计划** | AI 生成结构化计划 + 打卡勾选 + 历史版本/恢复 |
| 📓 **训练日记** | 训练后记感受/评分 + 时间线查看 |
| 🔄 **AI 工具** | 25 个工具，AI 对话中可直接调用（如"月报"/"训练计划"）|
| 💾 **持久化** | 数据存 `~/data/`（garmin.json + training-plan.json + training-diary.json）|

## 📦 安装

### 前置条件

- **DSH (DeepSeek Harness)** 已安装并运行
- **Garmin 账号**（支持 CN/国际）
- Node.js 18+
- pnpm（推荐）或 npm

### 💡 为什么需要手动加 bundles？

DSH 启动时**只显式加载** `dsh.profile.bundles` 列表里的包，**不**自动扫 `node_modules/` 加载所有 dsh-* 包（这是设计：稳定性、隔离性、性能）。所以 `pnpm add dsh-garmin-coach` 装包后，**必须**手动加到 bundles——这是 DSH 的工作方式，不是 bug。

> DSH 官方推荐用 `dshmarket`（应用市场）装包——它会**自动**加 bundles。`dsh-garmin-coach` 目前还在审核中，临时手动加即可。

### 一键安装（推荐）

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-garmin-coach
```

装完后**还需要把 dsh-garmin-coach 加到 bundles**（DSH 启动时只显式加载 bundles 里的包）：

**方法 1：手动改 `package.json`**

编辑 `~/.dsh/profiles/web/package.json`，在 `dsh.profile.bundles` 列表末尾加：

```json
"dsh": {
  "profile": {
    "bundles": [
      ...其他包,
      "dsh-garmin-coach"   ← 加这行
    ]
  }
}
```

**方法 2：命令行追加**

```bash
cd ~/.dsh/profiles/web
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!p.dsh.profile.bundles.includes('dsh-garmin-coach')) {
  p.dsh.profile.bundles.push('dsh-garmin-coach');
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
}
"
```

加完后**重启 DSH**（您自己执行）：

```bash
ddsh restart
```

打开 DSH → 设置 → 应该看到 **Garmin Coach** 卡片。

### 手动注册（旧方式，不推荐）

在 `~/.dsh/profiles/web/cordis.patch.yml` 手动添加（如果不想用 bundles）：

```yaml
- insert:
    - id: garmin-coach
      name: dsh-garmin-coach
```

### 首次配置

1. 打开 **DSH 设置 → Garmin Coach**
2. 选择账号区域（**CN** 或 **国际**）
3. 输入**邮箱 + 密码**
4. 登录后如需要 MFA，输入**短信验证码**
5. 点击**保存配置**
6. 等待几秒，token 会自动保存（加密）
7. 点击**立即同步** → 按设置中的"回看天数"拉取（默认 14 天，可在 Garmin Coach 设置页修改）

> ⚠️ **首次同步后**，数据存到 `~/data/garmin.json`（macOS/Linux 用户 Home 目录）。Windows 用户在 DSH 启动目录下的 `data\garmin.json`。

## 🚀 使用

### 运动看板

点击侧栏 **Garmin Coach** → 打开运动看板。

默认显示：
- 运动总览（总距离/次数/时长/配速/最长）
- 健康数据（步数/心率/压力/Body Battery）
- AI 训练建议（💡⚠️🔴）
- 训练计划（折叠）+打卡
- 各项分析 section

最近活动表支持：
- **筛选**（按运动类型：跑步/骑行/登山等）
- **排序**（按日期/距离/配速/心率）
- **+ 按钮**展开心率区间（Z1恢复/Z2有氧/Z3节奏/Z4阈值/Z5无氧）和运动时间（10:00-11:30）

### AI 对话

直接用**自然语言**提问，AI 自动调用工具：

| 自然语言 | AI 调用 |
|---|---|
| "六月份报告" | `garmin_report(month)` |
| "我十公里最好成绩" | `garmin_best_pace(10000)` |
| "本周跑量" | `garmin_distance_stats(week)` |
| "帮我制定半马破2计划" | `garmin_training_plan` + `garmin_save_training_plan` |
| "记录今天的训练：跑了 6km，4星" | `garmin_log_diary` |
| "我的训练进度" | `garmin_plan_progress` |

### 训练计划工作流

```
对话："帮我制定 10km 进 5:30 的计划"
  → AI 调 garmin_training_plan（基于您的基线数据）
  → AI 生成 4 周计划 + 16 个训练任务
  → AI 调 garmin_save_training_plan 保存

打开看板 → 看到训练计划（默认折叠）→ 点 ▶ 展开 → 勾选完成的任务

误操作：AI 误覆盖 → 对话："找回之前的计划" → AI 调 garmin_plan_history + garmin_restore_plan
```

## ⚙️ 配置

### 账号区域

- **CN**：`sso.garmin.cn`（中国账号）
- **国际**：`sso.garmin.com`（其他地区）

### 数据存储位置

所有数据存到 DSH 用户的 `data/` 目录（macOS/Linux 是 Home 目录，Windows 是 DSH 启动目录）：

```
~/data/                                              # macOS/Linux
%USERPROFILE%\data\  或  <DSH_cwd>\data\            # Windows
├── garmin.json            # 活动 + 每日健康（同步数据）
├── training-plan.json     # 当前训练计划 + 打卡状态
├── training-diary.json    # 训练日记
└── training-plan-history/ # 计划历史（自动备份）
```

### 同步策略

- **手动同步**（推荐）：点击卡片"立即同步"按钮或对话"同步数据"
- **增量**：每次只拉上次同步后的新数据（从 lastSyncAt 前一天到今天），但若距上次同步已超过"回看天数"配置，则至少回看该配置值（默认 14 天）
- **防行为指纹**：**无定时同步**（避免被 Garmin 检测为自动化）

## ⚠️ 重要：文件写入权限

本插件需要把**同步数据、训练计划、训练日记**写入 `~/data/`（macOS/Linux）或 `C:\Users\<you>\.dsh\data\`（Windows）。

**DSH 在沙箱里运行**，默认**没 full access 权限**——会导致：
- 同步数据看起来成功但**实际写错地方**（或失败丢失）
- 训练计划看板看不到刚保存的内容
- 打卡后重启数据丢失

**修复方法**（在 DSH 里启用文件写权限）：

| 平台 | 步骤 |
|---|---|
| **macOS** | 第一次写文件时会弹"权限"请求 → 允许"完整文件访问" |
| **Windows** | DSH 设置 → 沙箱/安全 → 开启「完整文件访问」(full file access) → **重启 DSH** |
| **Linux** | 通常默认有权限；如有问题检查 `~/data/` 目录权限 `chmod 755 ~/data` |

**插件已自带保护**：写文件前会探测权限，权限不足时会返回明确错误（包含路径 + 修复方法），而不是静默失败。

## 🔧 AI 工具列表（25 个）

### 基础查询（9）
- `garmin_whoami` / `garmin_daily` / `garmin_sleep` / `garmin_hrv` / `garmin_readiness`
- `garmin_training` / `garmin_activities` / `garmin_summary` / `garmin_weekly`

### 统计与分析（7）
- `garmin_sync` / `garmin_recent_activities` / `garmin_best_pace` / `garmin_distance_stats`
- `garmin_daily_stats` / `garmin_sport_breakdown` / `garmin_report`

### 训练计划与日记（9）
- `garmin_training_plan` / `garmin_save_training_plan` / `garmin_toggle_task`
- `garmin_plan_progress` / `garmin_plan_history` / `garmin_restore_plan`
- `garmin_clear_training_plan` / `garmin_log_diary` / `garmin_diary`

## 🔐 安全

### Garmin 账号安全（铁律）

1. **不自动重试登录** — 任何重试必须先经您同意（避免封号）
2. **token 自动 refresh** — ~28h access token，过期前自动换新
3. **refresh 也失效 → 提示重新连接** — 自动清除失效 token

### 数据隐私

- 所有数据存**本地**（`~/data/`），**不上传任何服务器**
- 密码/email 用 DSH 的 `secret` role，浏览器拿不到值
- 仅与 Garmin API 通信（直接 HTTPS，无中间服务）

## 🛠️ 开发

### 构建

```bash
npm install
npm run build       # tsc → lib/
npm run typecheck   # 类型检查
```

### 数据目录

- 开发时 cwd 是插件目录 → 数据存 `data/`
- DSH 进程 cwd 是用户主目录 → 数据存 `~/data/`
- 代码自动用 `process.env.HOME/data`（统一路径）

### 项目结构

```
src/
├── index.ts          # 插件主入口（apply/register/工具注册）
├── storage.ts        # GarminStoreFile（数据存储 + 计划缓存）
├── sync.ts           # 增量同步逻辑
├── stats.ts          # 30+ 运动分析函数 + 报告聚合 + 训练计划数据
├── settings-web.ts   # settings route（/garmin-settings）
├── tools/
│   ├── register.ts        # 基础工具（9）
│   └── stats-tools.ts     # 统计工具（16）
└── auth/
    ├── client.ts          # DI OAuth2 + token refresh
    ├── file-store.ts      # 持久化 token/mfa state
    └── constants.ts       # CN/国际端点

lib/                # 编译产物
├── *.js
└── client.js       # 看板前端（React）

cordis.patch.yml    # 注册入口
package.json
tsconfig.json
```

## 📝 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

## 🤝 贡献

欢迎提 issue / PR。建议先开 issue 讨论再改。

## 📄 License

MIT — 详见 [LICENSE](./LICENSE)。