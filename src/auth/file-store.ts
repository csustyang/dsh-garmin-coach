/**
 * 默认 TokenStore：把 token 写到磁盘。
 *
 * 生产 DSH 插件应替换为 CordisTokenStore，用 ctx.credentials 加密存储。
 */

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TokenStore } from './token-store.js'
import type { GarminCachedTokens, GarminMfaState } from './types.js'

export class FileTokenStore implements TokenStore {
  constructor(
    private readonly tokenPath: string,
    private readonly mfaPath: string,
  ) {}

  static default(): FileTokenStore {
    // 按 DSH 的 home 解析规则定位 token 目录：$DSH_HOME 优先，否则 ~/.dsh。
    // 不要回退到 process.cwd()——插件从不同 cwd 启动时 token 路径会漂移，导致读不到已保存的 token。
    const envHome = process.env.DSH_HOME?.trim()
    const home = envHome ? envHome : join(homedir(), '.dsh')
    const base = join(home, '.garmin')
    return new FileTokenStore(
      join(base, 'tokens.json'),
      join(base, 'mfa-state.json'),
    )
  }

  async loadTokens(): Promise<GarminCachedTokens | null> {
    return readJsonFile<GarminCachedTokens>(this.tokenPath)
  }

  async saveTokens(t: GarminCachedTokens): Promise<void> {
    await writeJsonFile(this.tokenPath, t, 0o600)
  }

  async clear(): Promise<void> {
    await unlink(this.tokenPath).catch(() => undefined)
  }

  async loadMfaState(): Promise<GarminMfaState | null> {
    return readJsonFile<GarminMfaState>(this.mfaPath)
  }

  async saveMfaState(s: GarminMfaState): Promise<void> {
    await writeJsonFile(this.mfaPath, s, 0o600)
  }

  async clearMfaState(): Promise<void> {
    await unlink(this.mfaPath).catch(() => undefined)
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null
    const txt = await readFile(path, 'utf8')
    return JSON.parse(txt) as T
  } catch {
    return null
  }
}

async function writeJsonFile(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
  try {
    await chmod(path, mode)
  } catch {
    /* Windows 忽略 */
  }
}