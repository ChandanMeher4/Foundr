import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getRedisConnection, getRedisKeyPrefix } from "./redis";

const RATE_LIMIT_TIMEOUT_MS = 1500;

export interface RateLimitInput {
  key: string;
  limit: number;
  windowSeconds: number;
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return { 1, limit - count - 1, 0 }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryMs = windowMs
  if #oldest >= 2 then
    retryMs = math.max(1000, tonumber(oldest[2]) + windowMs - now)
  end
  redis.call('PEXPIRE', key, windowMs)
  return { 0, 0, math.ceil(retryMs / 1000) }
end
`;

/** Extracts the caller IP from x-forwarded-for, x-real-ip, or falls back to "unknown". */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}

/**
 * Atomic Redis sorted-set sliding-window rate limiter honoring REDIS_KEY_PREFIX.
 * Fails OPEN by default for general endpoints (failClosed=true for OTP verification).
 */
export async function rateLimit({
  key,
  limit,
  windowSeconds,
  failClosed = false,
}: RateLimitInput): Promise<RateLimitResult> {
  if (!process.env.REDIS_URL) {
    console.warn(`[RateLimit WARNING] REDIS_URL missing; failing ${failClosed ? "CLOSED" : "OPEN"} for ${key}`);
    return failClosed
      ? { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds }
      : { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }

  const redisKey = `${getRedisKeyPrefix()}rl:${key}`;
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const member = `${nowMs}:${crypto.randomUUID()}`;

  try {
    const redis = getRedisConnection();
    const raw = (await Promise.race([
      redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        redisKey,
        String(nowMs),
        String(windowMs),
        String(limit),
        member,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Rate limiter Redis timeout")), RATE_LIMIT_TIMEOUT_MS),
      ),
    ])) as [number, number, number];

    return {
      allowed: Number(raw[0]) === 1,
      remaining: Math.max(0, Number(raw[1])),
      retryAfterSeconds: Math.max(0, Number(raw[2])),
    };
  } catch (err) {
    console.warn(
      `[RateLimit WARNING] Redis unreachable for "${key}", failing ${failClosed ? "CLOSED" : "OPEN"}:`,
      err instanceof Error ? err.message : err,
    );
    return failClosed
      ? { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds }
      : { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/** Builds a standard HTTP 429 response with Retry-After and X-RateLimit-* headers. */
export function rateLimitResponse(
  limit: number,
  result: RateLimitResult,
  customMessage?: string,
): NextResponse {
  const retryAfter = Math.max(1, result.retryAfterSeconds || 1);
  return NextResponse.json(
    {
      error:
        customMessage ||
        `Too many attempts. Try again in ${retryAfter} seconds.`,
      retryAfterSeconds: retryAfter,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
