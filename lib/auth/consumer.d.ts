/**
 * Garmin OAuth Consumer Key/Secret 管理。
 *
 * 数据源：https://thegarth.s3.amazonaws.com/oauth_consumer.json（garth 维护的最新值）
 * 失败回退：内置 hardcode 值（2024 年的版本，仍能跑通）。
 * 缓存：24 小时，避免每次登录都打 S3。
 *
 * DSH 插件里：首次启动时 resolve 一次，结果缓存到 process.env 或 ctx.config。
 */
import type { GarminConsumerCreds } from './types.js';
export declare function loadConsumerCreds(): Promise<GarminConsumerCreds>;
export declare function invalidateConsumerCache(): Promise<void>;
