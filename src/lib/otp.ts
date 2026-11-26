import crypto from "node:crypto";
import dbConnect from "./db";
import User from "../models/User";
import { getRedisConnection, getRedisKeyPrefix } from "./redis";

const OTP_TTL_SECONDS = 600;
const OTP_MAX_WRONG_ATTEMPTS = 5;
const OTP_REDIS_TIMEOUT_MS = 1500;

function getOtpHmacKey(): Buffer {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length === 0) {
    throw new Error("Fatal: JWT_SECRET environment variable must be defined.");
  }
  return crypto.createHash("sha256").update(`otp-v1:${jwtSecret}`).digest();
}

export function computeOtpHmac(email: string, code: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  return crypto
    .createHmac("sha256", getOtpHmacKey())
    .update(`${normalizedEmail}:${code}`)
    .digest("hex");
}

function getOtpKeys(email: string) {
  const prefix = getRedisKeyPrefix();
  const normalized = email.trim().toLowerCase();
  return {
    otpKey: `${prefix}otp:${normalized}`,
    attemptsKey: `${prefix}otp_attempts:${normalized}`,
  };
}

/** Stores HMAC-SHA256 OTP in Redis with 600s TTL and resets wrong-attempt counter. */
export async function storeHashedOtp(
  email: string,
  code: string,
  ttlSeconds = OTP_TTL_SECONDS,
): Promise<void> {
  const digest = computeOtpHmac(email, code);
  const { otpKey, attemptsKey } = getOtpKeys(email);
  const redis = getRedisConnection();

  await Promise.race([
    redis
      .multi()
      .set(otpKey, digest, "EX", ttlSeconds)
      .del(attemptsKey)
      .exec(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis timeout storing OTP")), OTP_REDIS_TIMEOUT_MS),
    ),
  ]);
}

export type VerifyOtpResult =
  | { status: "valid" }
  | { status: "invalid" }
  | { status: "locked"; retryAfterSeconds: number }
  | { status: "unavailable" };

const CONSUME_MATCHED_OTP_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
return 0
`;

/**
 * Verifies a 6-digit OTP against Redis HMAC-SHA256 using timingSafeEqual.
 * Fails CLOSED when Redis is unreachable; locks with 429 after 5 wrong attempts.
 */
export async function verifyAndConsumeOtp(
  email: string,
  candidateCode: string,
): Promise<VerifyOtpResult> {
  if (!process.env.REDIS_URL) {
    console.error("[OTP SECURITY] REDIS_URL missing; failing CLOSED on OTP verification.");
    return { status: "unavailable" };
  }

  const { otpKey, attemptsKey } = getOtpKeys(email);
  const candidateDigest = computeOtpHmac(email, candidateCode);

  try {
    const redis = getRedisConnection();
    const [storedDigest, attemptsRaw, attemptTtl] = (await Promise.race([
      Promise.all([
        redis.get(otpKey),
        redis.get(attemptsKey),
        redis.ttl(attemptsKey),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis timeout verifying OTP")), OTP_REDIS_TIMEOUT_MS),
      ),
    ])) as [string | null, string | null, number];

    const priorAttempts = Number(attemptsRaw || 0);
    if (priorAttempts >= OTP_MAX_WRONG_ATTEMPTS) {
      await redis.del(otpKey).catch(() => {});
      return {
        status: "locked",
        retryAfterSeconds: attemptTtl > 0 ? attemptTtl : OTP_TTL_SECONDS,
      };
    }

    if (!storedDigest) {
      return { status: "invalid" };
    }

    const expectedBuf = Buffer.from(storedDigest, "hex");
    const candidateBuf = Buffer.from(candidateDigest, "hex");
    const isMatch =
      expectedBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(expectedBuf, candidateBuf);

    if (isMatch) {
      const consumed = await redis.eval(
        CONSUME_MATCHED_OTP_LUA,
        2,
        otpKey,
        attemptsKey,
        storedDigest,
      );
      return Number(consumed) === 1 ? { status: "valid" } : { status: "invalid" };
    }

    const wrongAttempts = await redis.incr(attemptsKey);
    const otpTtl = await redis.ttl(otpKey);
    await redis.expire(attemptsKey, otpTtl > 0 ? otpTtl : OTP_TTL_SECONDS);

    if (wrongAttempts >= OTP_MAX_WRONG_ATTEMPTS) {
      await redis.del(otpKey);
    }

    return { status: "invalid" };
  } catch (err) {
    console.error(
      "[OTP SECURITY] Redis unreachable during OTP verification; failing CLOSED:",
      err instanceof Error ? err.message : err,
    );
    return { status: "unavailable" };
  }
}

/**
 * Idempotently strips legacy plaintext `otp` and `otpExpiry` fields from User documents.
 */
export async function cleanupLegacyOtpFields(): Promise<number> {
  await dbConnect();
  const result = await User.collection.updateMany(
    {
      $or: [{ otp: { $exists: true } }, { otpExpiry: { $exists: true } }],
    },
    {
      $unset: { otp: "", otpExpiry: "" },
    },
  );
  return result.modifiedCount ?? 0;
}
