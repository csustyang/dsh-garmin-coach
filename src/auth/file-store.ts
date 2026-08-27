/**
 * 默认 TokenStore：把 token 写到磁盘。
 *
 * 生产 DSH 插件应替换为 CordisTokenStore，用 ctx.credentials 加密存储。
 */

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenStore } from './token-store.js'
import type { GarminCachedTokens, GarminMfaState } from './types.js'

export class FileTokenStore implements TokenStore {
  constructor(
    private readonly tokenPath: string,
    private readonly mfaPath: string,
  ) {}

  static default(): FileTokenStore {
    // 优先用 DSH_HOME（~/.dsh），否则回退 cwd——确保 token 路径稳定，不受插件加载 cwd 影响
    const home = process.env.DSH_HOME
    const base = home
      ? join(home, '.garmin')
      : join(process.cwd(), '.garmin')
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