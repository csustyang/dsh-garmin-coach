# 发布流程

本项目使用 GitHub Releases 发版。脚本 `scripts/release.ts` 自动从 CHANGELOG.md 提取新版说明，创建 GitHub Release + 附件。

## 完整流程

### 1. 修改代码 + 提交

```bash
# 修改代码、调试、测试
git add .
git commit -m "feat: 加新功能"
git push origin main
```

### 2. 更新 CHANGELOG.md

在 `CHANGELOG.md` **顶部**加新版本段（格式严格匹配）：

```markdown
## 1.0.0（2026-09-15）

### ✨ 新功能
- 功能 A
- 功能 B

### 🐛 修复
- 修复了 X

### 🔧 优化
- 性能优化

### 💥 破坏性变更
- API 改了 Y

### 📝 文档
- 更新 README
```

支持的 emoji 前缀（可选）：
- `✨ 新功能`（`feat:`）
- `🐛 修复`（`fix:`）
- `🔧 优化`（`refactor:` / `perf:`）
- `💥 破坏性变更`（`BREAKING CHANGE:`）
- `📝 文档`（`docs:`）

### 3. 更新 package.json 版本号

```bash
npm version patch   # 0.1.0 → 0.1.1（bug 修复）
npm version minor   # 0.1.0 → 0.2.0（新功能）
npm version major   # 0.1.0 → 1.0.0（破坏性变更）
```

`npm version` 会自动：
- 改 `package.json` 的 `version`
- 创建 git commit + tag
- 但**不会自动 push**（避免误操作）

### 4. 设置 GH_TOKEN

发布需要 **GitHub Personal Access Token (PAT)** with `repo` scope：

```bash
# 一次性设置（PAT 不会保存到磁盘）
export GH_TOKEN=ghp_xxxxxxxxxxxxxx
```

设置位置：https://github.com/settings/tokens/new

### 5. 推送 commit + tag

```bash
git push origin main  # 推送 commit
git push origin v0.2.0  # 推送 tag（如果 npm version 没自动推）
```

### 6. 跑发布脚本

```bash
npm run release
```

脚本会自动：
1. 校验工作区干净
2. 从 CHANGELOG.md 提取新版本段
3. 构建 `lib/`（`npm run build`）
4. 创建/推送 git tag
5. 创建 GitHub Release（含 CHANGELOG 段）
6. 上传 `lib/*.js` 和 `lib/*.d.ts` 作为附件

完成后会打印 Release URL。

## 单条命令发布

如果 `package.json` 版本已经改好 + CHANGELOG 已更新 + commit 已 push + tag 已 push：

```bash
export GH_TOKEN=ghp_xxx && npm run release
```

## 故障排查

| 错误 | 原因 | 解决 |
|---|---|---|
| `GH_TOKEN 环境变量未设置` | 没设 PAT | `export GH_TOKEN=...` |
| `工作区有未提交的修改` | 有未 commit | `git add . && git commit` |
| `未在 CHANGELOG.md 找到 X.Y.Z` | 段格式不对 | 检查格式：`## X.Y.Z（日期）` |
| `lib/ 不存在` | 没 build | `npm run build` |
| `401 Unauthorized` | Token 无效/过期 | 重新生成 PAT |
| `403 Forbidden` | Token 没 `repo` scope | 重新生成时勾选 `repo` |

## 发布后

GitHub Release URL 形如：

```
https://github.com/csustyang/dsh-garmin-coach/releases/tag/v0.2.0
```

用户可以：
- 在网页查看 release notes
- 下载附件（lib 构建产物）
- 直接 `npm install git+https://github.com/csustyang/dsh-garmin-coach.git` 安装特定版本

## 版本号规则

遵循 [Semantic Versioning](https://semver.org/)：
- **MAJOR**（破坏性变更）：API 改了，用户必须改代码
- **MINOR**（新功能）：向后兼容的新功能
- **PATCH**（bug 修复）：向后兼容的修复

## 自动化建议（未来）

- 加 `.github/workflows/release.yml`：push tag 时自动跑 `npm run release`
- 这样本地跑 `git tag v0.2.0 && git push --tags` 即可自动发布

当前是手动触发（避免 token 管理问题）。