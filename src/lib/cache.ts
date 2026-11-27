import { getRedisConnection, getRedisKeyPrefix } from "./redis";

const CACHE_TIMEOUT_MS = 1500;
const MAX_CACHE_BYTES = 200 * 1024;

export const CACHE_VERSION = "v1";
export const MARKETPLACE_PROJECTS_CACHE_KEY = "marketplace:projects";
export const MARKETPLACE_CACHE_TTL_SECONDS = 60;
export const AI_CACHE_TTL_SECONDS = 86400;

export interface CacheRedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttl: number,
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

let testCacheClientOverride: CacheClientHolder["client"] = null;
type CacheClientHolder = { client: CacheRedisClient | null };

/** Allows unit/integration tests to inject a failing or mock Redis client safely. */
export function setCacheClientForTest(client: CacheRedisClient | null): void {
  testCacheClientOverride = client;
}

export function isCacheDisabled(): boolean {
  return process.env.CACHE_DISABLED === "true";
}

export function getVersionedCacheKey(key: string): string {
  return `${getRedisKeyPrefix()}cache:${CACHE_VERSION}:${key}`;
}

function resolveCacheClient(): CacheRedisClient | null {
  if (testCacheClientOverride) {
    return testCacheClientOverride;
  }
  if (!process.env.REDIS_URL) {
    return null;
  }
  return getRedisConnection() as unknown as CacheRedisClient;
}

async function withCacheTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cache Redis operation timed out")),
          CACHE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort JSON cache read under `${prefix}cache:v1:{key}`.
 * Returns null on miss, CACHE_DISABLED=true, parse failure, or Redis outage/timeout.
 */
export async function getJson<T>(key: string): Promise<T | null> {
  if (isCacheDisabled()) {
    return null;
  }

  const client = resolveCacheClient();
  if (!client) {
    return null;
  }

  const fullKey = getVersionedCacheKey(key);
  try {
    const raw = await withCacheTimeout(() => client.get(fullKey));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `[Cache WARNING] getJson failed for "${fullKey}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Best-effort JSON cache write with EX TTL under `${prefix}cache:v1:{key}`.
 * Skips caching when CACHE_DISABLED=true or serialized payload exceeds ~200KB.
 */
export async function setJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  if (isCacheDisabled() || ttlSeconds <= 0) {
    return false;
  }

  const client = resolveCacheClient();
  if (!client) {
    return false;
  }

  const fullKey = getVersionedCacheKey(key);
  try {
    const serialized = JSON.stringify(value);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_CACHE_BYTES) {
      console.warn(
        `[Cache WARNING] Skipping "${fullKey}" (${byteLength} bytes > ${MAX_CACHE_BYTES} limit)`,
      );
      return false;
    }

    await withCacheTimeout(() =>
      client.set(fullKey, serialized, "EX", Math.ceil(ttlSeconds)),
    );
    return true;
  } catch (err) {
    console.warn(
      `[Cache WARNING] setJson failed for "${fullKey}":`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Best-effort cache key deletion under `${prefix}cache:v1:{key}`.
 */
export async function del(key: string): Promise<boolean> {
  if (isCacheDisabled()) {
    return false;
  }

  const client = resolveCacheClient();
  if (!client) {
    return false;
  }

  const fullKey = getVersionedCacheKey(key);
  try {
    await withCacheTimeout(() => client.del(fullKey));
    return true;
  } catch (err) {
    console.warn(
      `[Cache WARNING] del failed for "${fullKey}":`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Invalidates the cached Live+Funded marketplace project listing.
 * Must be invoked AFTER the authoritative MongoDB mutation succeeds.
 */
export async function invalidateMarketplaceCache(): Promise<boolean> {
  return del(MARKETPLACE_PROJECTS_CACHE_KEY);
}
