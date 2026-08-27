/**
 * 发布脚本：从 CHANGELOG.md 提取最新版内容，创建 GitHub Release + 附件
 *
 * 用法：
 *   1. 在 CHANGELOG.md 顶部加 `## X.Y.Z（日期）` 段
 *   2. export GH_TOKEN=ghp_xxx（需要 repo scope）
 *   3. npm run build
 *   4. npx tsx scripts/release.ts [version]
 *
 * 参数：
 *   version（可选）：覆盖 CHANGELOG 里的版本号
 *
 * 流程：
 *   1. 读 package.json + CHANGELOG.md 提取版本和说明
 *   2. 构建 lib/（编译产物）
 *   3. git tag v0.X.Y
 *   4. git push --tags
 *   5. 创建 GitHub Release（标题、body、附件）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 从 CHANGELOG.md 提取最新版本段落 */
function extractChangelog(version: string): string {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const lines = changelog.split('\n')
  let startIdx = -1
  let endIdx = lines.length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    // 匹配 `## X.Y.Z` 或 `## X.Y.Z（日期）`
    const m = line.match(/^##\s+(\d+\.\d+\.\d+)/)
    if (m) {
      if (startIdx === -1) {
        if (m[1] === version) startIdx = i + 1
        else if (startIdx === -1 && i > 0) break // 没找到指定版本，用最新
      } else {
        endIdx = i
        break
      }
    }
  }

  if (startIdx === -1) {
    throw new Error(`未在 CHANGELOG.md 找到 ${version} 的段落`)
  }
  return lines.slice(startIdx, endIdx).join('\n').trim()
}

/** 列出构建产物（lib/ 下所有 .js 和 .d.ts）*/
function listArtifacts(): string[] {
  const libDir = join(ROOT, 'lib')
  if (!existsSync(libDir)) {
    throw new Error(`lib/ 不存在，请先运行 npm run build`)
  }
  const files: string[] = []
  function walk(dir: string, prefix: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const rel = prefix ? `${prefix}/${name}` : name
        const st = statSync(full)
        if (st.isDirectory()) walk(full, rel)
        else if (name.endsWith('.js') || name.endsWith('.d.ts')) files.push(rel)
      }
    }
  walk(libDir, '')
  return files
}

/** 调用 GitHub API 创建 Release */
async function createRelease(version: string, body: string, tag: string): Promise<{ id: number; html_url: string; upload_url: string }> {
  const token = process.env['GH_TOKEN']
  if (!token) {
    throw new Error('GH_TOKEN 环境变量未设置（需要 repo scope 的 PAT）')
  }

  const res = await fetch(`https://api.github.com/repos/${PKG.repository.url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/i)!.slice(1).join('/')}/releases`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `v${version}`,
      body,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`创建 Release 失败：${res.status} ${text}`)
  }

  return res.json() as Promise<{ id: number; html_url: string; upload_url: string }>
}

/** 上传附件到 Release */
async function uploadAsset(uploadUrl: string, name: string, content: Buffer, contentType: string): Promise<void> {
  const token = process.env['GH_TOKEN']
  // 上传 URL 需要把 {?name,label} 替换为 ?name=xxx
  const url = uploadUrl.replace(/\{[^}]+\}/, `?name=${encodeURIComponent(name)}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': contentType,
    },
    body: content,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`上传 ${name} 失败：${res.status} ${text}`)
  }
}

/** 主流程 */
async function main(): Promise<void> {
  const overrideVersion = process.argv[2]
  const version = overrideVersion || PKG.version
  const tag = `v${version}`

  console.log(`📦 准备发布 v${version}`)
  console.log(`   仓库: ${PKG.repository.url}`)
  console.log('')

  // 1. 检查 git 状态（确保工作区干净）
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
    if (status.trim()) {
      console.error('❌ 工作区有未提交的修改：')
      console.error(status)
      process.exit(1)
    }
  } catch {
    console.warn('⚠️ 无法检查 git 状态（继续）')
  }

  // 2. 检查 CHANGELOG
  let body: string
  try {
    body = extractChangelog(version)
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`)
    console.error(`   请在 CHANGELOG.md 顶部加 \`## ${version}（日期）\` 段`)
    process.exit(1)
  }
  console.log(`✓ CHANGELOG 段已提取（${body.length} 字符）`)

  // 3. 构建产物
  console.log('🔨 构建 lib/ ...')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
  const artifactFiles = listArtifacts()
  console.log(`✓ 构建产物 ${artifactFiles.length} 个文件`)

  // 4. 确认 GH_TOKEN
  if (!process.env['GH_TOKEN']) {
    console.error('❌ 需要 GH_TOKEN 环境变量（PAT with repo scope）')
    console.error('   export GH_TOKEN=ghp_xxxxxxxxxxxxxx')
    process.exit(1)
  }

  // 5. 创建 Git tag + push
  console.log(`🏷️  创建 tag ${tag} ...`)
  try {
    execSync(`git tag -d ${tag} 2>/dev/null || true`, { cwd: ROOT, stdio: 'ignore' })
    execSync(`git tag ${tag}`, { cwd: ROOT, stdio: 'inherit' })
    execSync(`git push origin :${tag} 2>/dev/null || true`, { cwd: ROOT, stdio: 'ignore' })
    execSync(`git push origin ${tag}`, { cwd: ROOT, stdio: 'inherit' })
  } catch (e) {
    console.error(`❌ Git tag 推送失败：${(e as Error).message}`)
    process.exit(1)
  }

  // 6. 创建 GitHub Release
  console.log(`🚀 创建 GitHub Release ...`)
  const release = await createRelease(version, body, tag)
  console.log(`✓ Release 创建成功: ${release.html_url}`)

  // 7. 上传构建产物（打包为 zip 太复杂，单文件上传）
  console.log(`📎 上传构建产物 ...`)
  for (const relPath of artifactFiles) {
    const fullPath = join(ROOT, 'lib', relPath)
    const content = readFileSync(fullPath)
    const contentType = relPath.endsWith('.d.ts') ? 'text/plain; charset=utf-8' : 'application/javascript; charset=utf-8'
    try {
      await uploadAsset(release.upload_url, relPath, content, contentType)
      console.log(`  ✓ ${relPath}`)
    } catch (e) {
      console.warn(`  ⚠️ ${relPath}: ${(e as Error).message}`)
    }
  }

  console.log('')
  console.log(`🎉 发布完成！`)
  console.log(`   ${release.html_url}`)
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e)
  process.exit(1)
})