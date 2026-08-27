/**
 * Garmin OAuth Consumer Key/Secret 管理。
 *
 * 数据源：https://thegarth.s3.amazonaws.com/oauth_consumer.json（garth 维护的最新值）
 * 失败回退：内置 hardcode 值（2024 年的版本，仍能跑通）。
 * 缓存：24 小时，避免每次登录都打 S3。
 *
 * DSH 插件里：首次启动时 resolve 一次，结果缓存到 process.env 或 ctx.config。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  OAUTH_CONSUMER_CACHE_TTL_SEC,
  OAUTH_CONSUMER_FALLBACK_KEY,
  OAUTH_CONSUMER_FALLBACK_SECRET,
  OAUTH_CONSUMER_URL,
} from './constants.js'
import type { GarminConsumerCreds } from './types.js'

const CACHE_PATH = join(homedir(), '.config', 'garmin-api', 'consumer.json')

interface CachedConsumer {
  readonly key: string
  readonly secret: string
  readonly fetchedAt: number
}

async function fetchRemote(): Promise<GarminConsumerCreds | null> {
  try {
    const res = await fetch(OAUTH_CONSUMER_URL, {
      headers: { 'User-Agent': 'dsh-garmin-coach/0.1' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as Partial<GarminConsumerCreds>
    if (typeof json.key !== 'string' || typeof json.secret !== 'string') {
      return null
    }
    return { key: json.key, secret: json.secret }
  } catch {
    return null
  }
}

async function loadCache(): Promise<CachedConsumer | null> {
  try {
    if (!existsSync(CACHE_PATH)) return null
    const raw = await readFile(CACHE_PATH, 'utf8')
    const json = JSON.parse(raw) as unknown
    if (
      !json ||
      typeof json !== 'object' ||
      typeof (json as CachedConsumer).key !== 'string' ||
      typeof (json as CachedConsumer).secret !== 'string' ||
      typeof (json as CachedConsumer).fetchedAt !== 'number'
    ) {
      return null
    }
    return json as CachedConsumer
  } catch {
    return null
  }
}

async function saveCache(c: GarminConsumerCreds): Promise<void> {
  try {
    await mkdir(join(homedir(), '.config', 'garmin-api'), { recursive: true })
    await writeFile(
      CACHE_PATH,
      JSON.stringify({ ...c, fetchedAt: Date.now() }),
      'utf8',
    )
  } catch {
    /* 缓存失败无所谓，下次再拉 */
  }
}

export async function loadConsumerCreds(): Promise<GarminConsumerCreds> {
  const cached = await loadCache()
  if (
    cached &&
    Date.now() - cached.fetchedAt < OAUTH_CONSUMER_CACHE_TTL_SEC * 1000
  ) {
    return { key: cached.key, secret: cached.secret }
  }
  const remote = await fetchRemote()
  if (remote) {
    await saveCache(remote)
    return remote
  }
  // 回退到 hardcode
  return {
    key: OAUTH_CONSUMER_FALLBACK_KEY,
    secret: OAUTH_CONSUMER_FALLBACK_SECRET,
  }
}

export async function invalidateConsumerCache(): Promise<void> {
  if (existsSync(CACHE_PATH)) {
    const { unlink } = await import('node:fs/promises')
    await unlink(CACHE_PATH).catch(() => undefined)
  }
}