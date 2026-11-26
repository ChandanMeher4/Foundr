import { getRedisConnection, getRedisKeyPrefix } from "./redis";
import { COOKIE_MAX_AGE_SECONDS } from "./auth-core";

const REVOCATION_TIMEOUT_MS = 1500;

async function withRedisTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error("Redis revocation check timed out")),
        REVOCATION_TIMEOUT_MS,
      ),
    ),
  ]);
}

/**
 * Checks whether a token's jti or user-wide tokensValidAfter timestamp invalidates the session.
 * Fails OPEN (logs loudly) if Redis is unavailable so general site availability is preserved.
 */
export async function isSessionRevoked(
  jti: string,
  userId: string,
  iatSeconds?: number,
): Promise<boolean> {
  if (!process.env.REDIS_URL) {
    return false;
  }

  try {
    const prefix = getRedisKeyPrefix();
    const redis = getRedisConnection();
    const [revokedVal, validAfterRaw] = await withRedisTimeout(
      redis.mget(
        `${prefix}revoked:${jti}`,
        `${prefix}tokensValidAfter:${userId}`,
      ),
    );

    if (revokedVal) {
      return true;
    }

    if (validAfterRaw) {
      const validAfterSec = Number(validAfterRaw);
      const tokenIat = typeof iatSeconds === "number" ? iatSeconds : 0;
      if (Number.isFinite(validAfterSec) && tokenIat < validAfterSec) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error(
      "[Auth CRITICAL] Redis unreachable during token revocation check; failing OPEN:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Revokes a single JWT ID (`jti`) until its natural expiration. */
export async function revokeTokenJti(
  jti: string,
  remainingTtlSeconds: number,
): Promise<void> {
  if (!process.env.REDIS_URL || remainingTtlSeconds <= 0) return;

  try {
    const prefix = getRedisKeyPrefix();
    const redis = getRedisConnection();
    await withRedisTimeout(
      redis.set(
        `${prefix}revoked:${jti}`,
        "1",
        "EX",
        Math.ceil(remainingTtlSeconds),
      ),
    );
  } catch (err) {
    console.error(
      "[Auth WARNING] Failed to store revoked jti in Redis:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Invalidates all existing sessions for a user by storing `tokensValidAfter`
 * in Redis (`now` in whole seconds; +1s if fractional so tokens minted in the current second
 * are revoked cleanly while subsequent second logins remain valid).
 */
export async function revokeAllUserSessions(
  userId: string,
  validAfterUnixSeconds?: number,
): Promise<number> {
  // Using ceil(now/1000) or +1 ensures tokens minted at floor(now/1000) in the same second are < validAfter
  const cutoffSec =
    validAfterUnixSeconds ?? Math.floor(Date.now() / 1000) + 1;

  if (!process.env.REDIS_URL) {
    return cutoffSec;
  }

  try {
    const prefix = getRedisKeyPrefix();
    const redis = getRedisConnection();
    await withRedisTimeout(
      redis.set(
        `${prefix}tokensValidAfter:${userId}`,
        String(cutoffSec),
        "EX",
        COOKIE_MAX_AGE_SECONDS,
      ),
    );
  } catch (err) {
    console.error(
      `[Auth CRITICAL] Failed to revoke sessions for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return cutoffSec;
}
