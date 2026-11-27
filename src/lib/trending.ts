import { getRedisConnection, getRedisKeyPrefix } from "./redis";

const TRENDING_TIMEOUT_MS = 1500;
const SEEN_TTL_SECONDS = 86400;
const DAILY_ZSET_TTL_SECONDS = 8 * 86400;
const ROLLUP_TTL_SECONDS = 120;
const ROLLUP_TOP_COUNT = 20;

export const TRENDING_WEIGHTS = {
  view: 1,
  ai: 2,
  star: 3,
  invest: 5,
} as const;

export type TrendingEventType = keyof typeof TRENDING_WEIGHTS;

export interface TrendingScoreEntry {
  projectId: string;
  score: number;
}

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Formats a Date as YYYY-MM-DD in Asia/Kolkata. */
export function formatIstDateKey(date: Date = new Date()): string {
  return IST_DATE_FORMATTER.format(date);
}

/** Returns the last `days` YYYY-MM-DD keys in Asia/Kolkata ordered newest to oldest. */
export function getLastIstDateKeys(
  days = 7,
  now: Date = new Date(),
): string[] {
  const keys: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    keys.push(formatIstDateKey(d));
  }
  return keys;
}

export function getTrendingRollupKey(): string {
  return `${getRedisKeyPrefix()}trending:7d`;
}

async function withTrendingTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Trending Redis operation timed out")),
          TRENDING_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseZrevrangeWithScores(raw: unknown): TrendingScoreEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const results: TrendingScoreEntry[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const projectId = String(raw[i]);
    const score = Number(raw[i + 1]);
    if (projectId && Number.isFinite(score) && score > 0) {
      results.push({ projectId, score });
    }
  }
  return results;
}

/**
 * Records a best-effort trending engagement signal into the Asia/Kolkata daily sorted set.
 * Views, AI analyses, and star additions are deduped per viewer/project/day via SET NX EX 86400.
 * Committed investments always score (+5) and should never be called for idempotent replays.
 */
export async function recordTrendingEvent(input: {
  type: TrendingEventType;
  projectId: string;
  viewerKey?: string;
  now?: Date;
}): Promise<boolean> {
  if (!process.env.REDIS_URL) {
    return false;
  }

  const now = input.now ?? new Date();
  const prefix = getRedisKeyPrefix();
  const day = formatIstDateKey(now);
  const weight = TRENDING_WEIGHTS[input.type];

  try {
    const redis = getRedisConnection();

    if (input.type !== "invest") {
      const safeViewer = (input.viewerKey || "unknown").trim() || "unknown";
      const seenKey = `${prefix}trending:seen:${day}:${input.type}:${safeViewer}:${input.projectId}`;
      const locked = await withTrendingTimeout(() =>
        redis.set(seenKey, "1", "EX", SEEN_TTL_SECONDS, "NX"),
      );
      if (locked !== "OK") {
        return false;
      }
    }

    const dailyKey = `${prefix}trending:${day}`;
    await withTrendingTimeout(() =>
      redis
        .pipeline()
        .zincrby(dailyKey, weight, input.projectId)
        .expire(dailyKey, DAILY_ZSET_TTL_SECONDS)
        .exec(),
    );
    return true;
  } catch (err) {
    console.warn(
      `[Trending WARNING] Failed recording ${input.type} for ${input.projectId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Reads top 20 trending projects from `trending:7d`.
 * If `trending:7d` exists, reads it in one ZREVRANGE round-trip; otherwise builds it lazily
 * via MULTI (ZUNIONSTORE over last 7 IST daily buckets with WEIGHTS 7,6,5,4,3,2,1 + EXPIRE 120).
 */
export async function getTrendingProjectScores(options?: {
  now?: Date;
  forceRebuild?: boolean;
}): Promise<TrendingScoreEntry[]> {
  if (!process.env.REDIS_URL) {
    return [];
  }

  const now = options?.now ?? new Date();
  const prefix = getRedisKeyPrefix();
  const rollupKey = getTrendingRollupKey();

  try {
    const redis = getRedisConnection();

    if (!options?.forceRebuild) {
      const warmResults = await withTrendingTimeout(() =>
        redis
          .pipeline()
          .exists(rollupKey)
          .zrevrange(rollupKey, 0, ROLLUP_TOP_COUNT - 1, "WITHSCORES")
          .exec(),
      );
      const existsCount = Number(warmResults?.[0]?.[1] ?? 0);
      const zrevRaw = warmResults?.[1]?.[1];
      if (existsCount === 1) {
        return parseZrevrangeWithScores(zrevRaw);
      }
    }

    const dailyKeys = getLastIstDateKeys(7, now).map(
      (d) => `${prefix}trending:${d}`,
    );
    const rebuildResults = await withTrendingTimeout(() =>
      redis
        .multi()
        .zunionstore(
          rollupKey,
          7,
          ...dailyKeys,
          "WEIGHTS",
          7,
          6,
          5,
          4,
          3,
          2,
          1,
        )
        .expire(rollupKey, ROLLUP_TTL_SECONDS)
        .zrevrange(rollupKey, 0, ROLLUP_TOP_COUNT - 1, "WITHSCORES")
        .exec(),
    );

    const zrevRaw = rebuildResults?.[2]?.[1];
    return parseZrevrangeWithScores(zrevRaw);
  } catch (err) {
    console.warn(
      "[Trending WARNING] Failed reading 7d trending rollup:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
