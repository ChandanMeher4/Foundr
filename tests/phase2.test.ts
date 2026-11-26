import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const cookieAls = new AsyncLocalStorage<{
  token?: string;
  setCookies: Array<{ name: string; value: string }>;
  deletedCookies: string[];
}>();

const emailCalls: Array<{ to: string | string[]; subject: string; html: string }> = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const store = cookieAls.getStore();
      if (name === "foundr_token" && store?.token) {
        return { value: store.token };
      }
      return undefined;
    },
    set: (name: string, value: string) => {
      cookieAls.getStore()?.setCookies.push({ name, value });
    },
    delete: (name: string) => {
      cookieAls.getStore()?.deletedCookies.push(name);
    },
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

vi.mock("../src/lib/email", () => ({
  sendAppEmail: async (input: {
    to: string | string[];
    subject: string;
    html: string;
  }) => {
    emailCalls.push({ to: input.to, subject: input.subject, html: input.html });
    return { mode: "sandbox" as const, delivered: false };
  },
}));

import dbConnect from "../src/lib/db";
import { getRedisConnection } from "../src/lib/redis";
import { rateLimit } from "../src/lib/rate-limit";
import {
  getEncodedJwtSecret,
  signSessionToken,
  verifySessionToken,
} from "../src/lib/auth-core";
import { getSession } from "../src/lib/auth";
import {
  LIFECYCLE_QUEUE,
  SCHEDULED_QUEUE,
  cancelLifecycleJobs,
  getLifecycleQueue,
  getScheduledQueue,
  scheduleExpireListing,
  scheduleReviewReminder,
} from "../src/lib/queue";
import { computeOtpHmac, storeHashedOtp } from "../src/lib/otp";
import User from "../src/models/User";
import Project from "../src/models/Project";
import AuditLog from "../src/models/AuditLog";
import PlatformStats from "../src/models/PlatformStats";
import { POST as otpSendPost } from "../src/app/api/auth/otp/send/route";
import { POST as otpVerifyPost } from "../src/app/api/auth/otp/verify/route";
import { POST as logoutPost } from "../src/app/api/auth/logout/route";
import { POST as revokeSessionsPost } from "../src/app/api/admin/users/[id]/revoke-sessions/route";
import { processLifecycleJob, processScheduledJob } from "../worker/processors";
import { registerScheduledJobs } from "../worker/index";
import type { Job } from "bullmq";

function runWithCookie<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cookieAls.run({ token, setCookies: [], deletedCookies: [] }, fn);
}

describe("Phase 2: Rate Limiting, OTP Hardening, Revocation & Jobs", () => {
  const createdUserIds: string[] = [];
  const createdProjectIds: string[] = [];
  const prevOtpFlag = process.env.OTP_LOGIN_ENABLED;
  const prevEmailMode = process.env.EMAIL_MODE;
  const prevAdminEmail = process.env.ADMIN_EMAIL;

  beforeAll(async () => {
    const conn = await dbConnect();
    const dbName = conn.connection.db?.databaseName || "";
    expect(dbName.endsWith("_test")).toBe(true);
    process.env.OTP_LOGIN_ENABLED = "true";
  });

  afterAll(async () => {
    process.env.OTP_LOGIN_ENABLED = prevOtpFlag;
    process.env.EMAIL_MODE = prevEmailMode;
    process.env.ADMIN_EMAIL = prevAdminEmail;

    await dbConnect();
    await PlatformStats.deleteMany({ key: "latest" });
    if (createdProjectIds.length > 0) {
      await AuditLog.deleteMany({ projectId: { $in: createdProjectIds } });
      await Project.deleteMany({ _id: { $in: createdProjectIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }

    if (process.env.REDIS_URL) {
      const redis = getRedisConnection();
      const lifecycleQueue = getLifecycleQueue();
      const scheduledQueue = getScheduledQueue();
      await lifecycleQueue.close();
      await scheduledQueue.close();

      let cursor = "0";
      const keysToDelete: string[] = [];
      do {
        const [nextCursor, batch] = await redis.scan(
          cursor,
          "MATCH",
          "test:*",
          "COUNT",
          100,
        );
        cursor = nextCursor;
        keysToDelete.push(...batch);
      } while (cursor !== "0");

      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
      await redis.quit();
    }

    await mongoose.disconnect();
  });

  describe("Part A: Atomic Sliding-Window Rate Limiter", () => {
    it("allows exactly 5 of 20 parallel requests and resets after window expiry", async () => {
      const key = `parallel-${crypto.randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          rateLimit({ key, limit: 5, windowSeconds: 10 }),
        ),
      );

      const allowed = results.filter((r) => r.allowed);
      const blocked = results.filter((r) => !r.allowed);
      expect(allowed).toHaveLength(5);
      expect(blocked).toHaveLength(15);
      for (const b of blocked) {
        expect(b.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }

      const expKey = `expiry-${crypto.randomUUID()}`;
      const r1 = await rateLimit({ key: expKey, limit: 1, windowSeconds: 1 });
      const r2 = await rateLimit({ key: expKey, limit: 1, windowSeconds: 1 });
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(false);

      await new Promise((r) => setTimeout(r, 1150));
      const r3 = await rateLimit({ key: expKey, limit: 1, windowSeconds: 1 });
      expect(r3.allowed).toBe(true);
    });

    it("fails OPEN for general limits and CLOSED for failClosed OTP limits when Redis errors", async () => {
      const redis = getRedisConnection();
      const evalSpy = vi
        .spyOn(redis, "eval")
        .mockRejectedValue(new Error("Simulated Redis outage"));

      try {
        const general = await rateLimit({
          key: "outage-general",
          limit: 5,
          windowSeconds: 60,
        });
        expect(general.allowed).toBe(true);

        const otpVerify = await rateLimit({
          key: "outage-otp",
          limit: 5,
          windowSeconds: 60,
          failClosed: true,
        });
        expect(otpVerify.allowed).toBe(false);
      } finally {
        evalSpy.mockRestore();
      }
    });
  });

  describe("Part B: Hardened Redis OTP & Enumeration Resistance", () => {
    it("hashes OTP with HMAC, locks after 5 wrong attempts (even if 6th is valid), enforces single use, expiry, and generic unknown-email response", async () => {
      const suffix = crypto.randomBytes(5).toString("hex");
      const userEmail = `otp-user-${suffix}@foundr.local`;
      const unknownEmail = `otp-missing-${suffix}@foundr.local`;

      const user = await User.create({
        name: "OTP Test Investor",
        email: userEmail,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Bengaluru",
      });
      createdUserIds.push(user._id.toString());

      emailCalls.length = 0;
      const sendKnown = await otpSendPost(
        new Request("http://localhost/api/auth/otp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": `10.0.1.${suffix.slice(0, 2)}`,
          },
          body: JSON.stringify({ email: userEmail }),
        }),
      );
      const sendUnknown = await otpSendPost(
        new Request("http://localhost/api/auth/otp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": `10.0.2.${suffix.slice(0, 2)}`,
          },
          body: JSON.stringify({ email: unknownEmail }),
        }),
      );

      expect(sendKnown.status).toBe(200);
      expect(sendUnknown.status).toBe(200);
      expect(await sendKnown.json()).toEqual(await sendUnknown.json());

      // Extract sent 6-digit OTP from mocked email dispatch
      const sentEmail = emailCalls.find((e) => e.to === userEmail);
      expect(sentEmail).toBeDefined();
      const otpMatch = sentEmail!.subject.match(/(\d{6})/);
      expect(otpMatch).not.toBeNull();
      const realOtp = otpMatch![1];

      // Redis must NOT store plaintext OTP
      const redis = getRedisConnection();
      const storedRedisVal = await redis.get(`test:otp:${userEmail}`);
      expect(storedRedisVal).toBeTruthy();
      expect(storedRedisVal).not.toBe(realOtp);
      expect(storedRedisVal).toBe(computeOtpHmac(userEmail, realOtp));
      expect(await redis.get(`test:otp:${unknownEmail}`)).toBeNull();

      // 5 wrong attempts return 400 and delete stored OTP
      for (let i = 0; i < 5; i++) {
        const badRes = await otpVerifyPost(
          new Request("http://localhost/api/auth/otp/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: userEmail, otp: "000000" }),
          }),
        );
        expect(badRes.status).toBe(400);
      }
      expect(await redis.get(`test:otp:${userEmail}`)).toBeNull();

      // 6th attempt using the original VALID code must return 429
      const lockedRes = await otpVerifyPost(
        new Request("http://localhost/api/auth/otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: userEmail, otp: realOtp }),
        }),
      );
      expect(lockedRes.status).toBe(429);

      // Send a fresh code (clears lockout) -> test expiry (1s TTL)
      await storeHashedOtp(userEmail, "654321", 1);
      await new Promise((r) => setTimeout(r, 1150));
      const expiredRes = await otpVerifyPost(
        new Request("http://localhost/api/auth/otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: userEmail, otp: "654321" }),
        }),
      );
      expect(expiredRes.status).toBe(400);

      // Fresh valid code -> succeeds once and deletes key (single use)
      await storeHashedOtp(userEmail, "987654", 600);
      const okRes = await runWithCookie(undefined, () =>
        otpVerifyPost(
          new Request("http://localhost/api/auth/otp/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: userEmail, otp: "987654" }),
          }),
        ),
      );
      expect(okRes.status).toBe(200);
      expect(await redis.get(`test:otp:${userEmail}`)).toBeNull();

      // Replaying the same OTP fails
      const replayRes = await otpVerifyPost(
        new Request("http://localhost/api/auth/otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: userEmail, otp: "987654" }),
        }),
      );
      expect(replayRes.status).toBe(400);
    });
  });

  describe("Part C: JWT jti & tokensValidAfter Revocation", () => {
    it("rejects tokens without jti, revokes on logout, and invalidates older tokens via tokensValidAfter", async () => {
      const suffix = crypto.randomBytes(4).toString("hex");
      const targetUser = await User.create({
        name: "Revoke Target",
        email: `revoke-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Mumbai",
      });
      const adminUser = await User.create({
        name: "Revoke Admin",
        email: `revoke-admin-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Admin",
        city: "Mumbai",
      });
      createdUserIds.push(targetUser._id.toString(), adminUser._id.toString());

      // Legacy token without jti must fail verifySessionToken
      const legacyNoJtiToken = await new SignJWT({
        id: targetUser._id.toString(),
        role: "Investor",
        name: targetUser.name,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(getEncodedJwtSecret());
      await expect(verifySessionToken(legacyNoJtiToken)).rejects.toThrow();

      // Sign normal token & verify logout revokes its jti
      const sessionA = await signSessionToken({
        id: targetUser._id.toString(),
        role: "Investor",
        name: targetUser.name,
        city: targetUser.city,
      });
      expect(await runWithCookie(sessionA, () => getSession())).not.toBeNull();

      const logoutRes = await runWithCookie(sessionA, () => logoutPost());
      expect(logoutRes.status).toBe(200);
      expect(await runWithCookie(sessionA, () => getSession())).toBeNull();

      // tokensValidAfter rejects sessionB issued before revoke, accepts sessionC issued >= cutoff
      const sessionB = await signSessionToken({
        id: targetUser._id.toString(),
        role: "Investor",
        name: targetUser.name,
      });
      const adminToken = await signSessionToken({
        id: adminUser._id.toString(),
        role: "Admin",
        name: adminUser.name,
      });

      const revokeRes = await runWithCookie(adminToken, () =>
        revokeSessionsPost(
          new Request("http://localhost/api/admin/users/x/revoke-sessions", {
            method: "POST",
          }),
          { params: Promise.resolve({ id: targetUser._id.toString() }) },
        ),
      );
      expect(revokeRes.status).toBe(200);
      expect(await runWithCookie(sessionB, () => getSession())).toBeNull();

      // Wait for next second so newToken.iat >= tokensValidAfter
      await new Promise((r) => setTimeout(r, 1100));
      const sessionC = await signSessionToken({
        id: targetUser._id.toString(),
        role: "Investor",
        name: targetUser.name,
      });
      expect(await runWithCookie(sessionC, () => getSession())).not.toBeNull();

      // Role mutation hook automatically revokes active sessions
      targetUser.role = "Developer";
      await targetUser.save();
      expect(await runWithCookie(sessionC, () => getSession())).toBeNull();
    });
  });

  describe("Part D: Lifecycle & Scheduled Queues + Sandbox Digest", () => {
    it("enforces runtime state guards on expire-listing / review-reminder and cancelLifecycleJobs removal", async () => {
      const suffix = crypto.randomBytes(4).toString("hex");
      const dev = await User.create({
        name: "Lifecycle Dev",
        email: `lc-dev-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Developer",
        city: "Bengaluru",
      });
      createdUserIds.push(dev._id.toString());

      const t1 = new Date("2026-11-01T10:00:00.000Z");
      const t2 = new Date("2026-11-05T10:00:00.000Z");

      // 1. Funded project -> expire-listing is a no-op
      const fundedProj = await Project.create({
        title: "Already Funded Lifecycle",
        description: "Test funded project.",
        developerName: dev._id,
        location: { type: "Point", coordinates: [77.5, 12.9], address: "Bengaluru" },
        category: "Commercial",
        totalValuation: 1_000_000,
        minInvestment: 100_000,
        expectedCompletion: new Date("2028-01-01"),
        currentFunding: 1_000_000,
        imageUrls: ["https://placehold.co/600x400"],
        status: "Funded",
        approvedAt: t1,
      });
      createdProjectIds.push(fundedProj._id.toString());

      const fundedRes = (await processLifecycleJob({
        name: "expire-listing",
        data: {
          projectId: fundedProj._id.toString(),
          approvedAt: t1.toISOString(),
        },
      } as unknown as Job)) as { noOp?: boolean };
      expect(fundedRes.noOp).toBe(true);
      expect((await Project.findById(fundedProj._id).lean())!.status).toBe("Funded");

      // 2. Re-approved project -> stale t1 approvedAt is a no-op; matching t2 expires it
      const liveProj = await Project.create({
        title: "Reapproved Lifecycle",
        description: "Test reapproved project.",
        developerName: dev._id,
        location: { type: "Point", coordinates: [77.5, 12.9], address: "Bengaluru" },
        category: "Commercial",
        totalValuation: 1_000_000,
        minInvestment: 100_000,
        expectedCompletion: new Date("2028-01-01"),
        currentFunding: 200_000,
        imageUrls: ["https://placehold.co/600x400"],
        status: "Live",
        approvedAt: t2,
      });
      createdProjectIds.push(liveProj._id.toString());

      const staleRes = (await processLifecycleJob({
        name: "expire-listing",
        data: {
          projectId: liveProj._id.toString(),
          approvedAt: t1.toISOString(),
        },
      } as unknown as Job)) as { noOp?: boolean; reason?: string };
      expect(staleRes.noOp).toBe(true);
      expect(staleRes.reason).toBe("approvedAt_mismatch");
      expect((await Project.findById(liveProj._id).lean())!.status).toBe("Live");

      const expireRes = (await processLifecycleJob({
        name: "expire-listing",
        data: {
          projectId: liveProj._id.toString(),
          approvedAt: t2.toISOString(),
        },
      } as unknown as Job)) as { expired?: boolean };
      expect(expireRes.expired).toBe(true);
      expect((await Project.findById(liveProj._id).lean())!.status).toBe("Expired");

      // 3. review-reminder is a no-op once reviewed (not Pending Review)
      const reminderRes = (await processLifecycleJob({
        name: "review-reminder",
        data: { projectId: liveProj._id.toString() },
      } as unknown as Job)) as { noOp?: boolean };
      expect(reminderRes.noOp).toBe(true);

      // 4. cancelLifecycleJobs removes scheduled jobs from lifecycle queue
      await scheduleReviewReminder(liveProj._id.toString());
      await scheduleExpireListing({
        projectId: liveProj._id.toString(),
        approvedAt: t2.toISOString(),
      });
      const lcQueue = getLifecycleQueue();
      expect(lcQueue.name).toBe(LIFECYCLE_QUEUE);
      expect(await lcQueue.getJob(`expire_${liveProj._id.toString()}`)).toBeDefined();

      await cancelLifecycleJobs(liveProj._id.toString());
      expect(await lcQueue.getJob(`expire_${liveProj._id.toString()}`)).toBeUndefined();
      expect(await lcQueue.getJob(`reminder_${liveProj._id.toString()}`)).toBeUndefined();
    });

    it("registers schedulers idempotently without duplicates and sends one admin summary in sandbox daily-digest", async () => {
      const scheduledQueue = getScheduledQueue();
      expect(scheduledQueue.name).toBe(SCHEDULED_QUEUE);

      await registerScheduledJobs(scheduledQueue);
      await registerScheduledJobs(scheduledQueue);

      const schedulers = await scheduledQueue.getJobSchedulers();
      const ids = schedulers.map((s) => s.key || s.id).sort();
      expect(ids).toEqual([
        "daily-digest-scheduler",
        "nightly-cleanup-scheduler",
        "weekly-stats-scheduler",
      ]);

      // Seed fresh approved listing + opted-in investors for daily-digest test
      const suffix = crypto.randomBytes(4).toString("hex");
      const dev = await User.create({
        name: "Digest Dev",
        email: `digest-dev-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Developer",
        city: "Pune",
      });
      const inv1 = await User.create({
        name: "Digest Investor 1",
        email: `digest-inv1-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Pune",
        digestOptIn: true,
      });
      const inv2 = await User.create({
        name: "Digest Investor 2",
        email: `digest-inv2-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Mumbai",
        digestOptIn: true,
      });
      createdUserIds.push(
        dev._id.toString(),
        inv1._id.toString(),
        inv2._id.toString(),
      );

      const recentProj = await Project.create({
        title: "Digest Fresh Listing",
        description: "Approved in last 24h.",
        developerName: dev._id,
        location: { type: "Point", coordinates: [73.85, 18.52], address: "Koregaon Park, Pune" },
        category: "Residential",
        totalValuation: 2_000_000,
        minInvestment: 100_000,
        expectedCompletion: new Date("2028-05-01"),
        currentFunding: 0,
        imageUrls: ["https://placehold.co/600x400"],
        status: "Live",
        approvedAt: new Date(),
      });
      createdProjectIds.push(recentProj._id.toString());

      process.env.EMAIL_MODE = "sandbox";
      process.env.ADMIN_EMAIL = "digest-admin@foundr.local";
      emailCalls.length = 0;

      const digestRes = (await processScheduledJob(
        { name: "daily-digest", data: {} } as unknown as Job,
        scheduledQueue,
        [scheduledQueue],
      )) as { mode: string; summarySent: boolean; wouldNotifyCount: number };

      expect(digestRes.mode).toBe("sandbox");
      expect(digestRes.summarySent).toBe(true);
      expect(digestRes.wouldNotifyCount).toBeGreaterThanOrEqual(2);
      expect(emailCalls).toHaveLength(1);
      expect(emailCalls[0].to).toBe("digest-admin@foundr.local");
      expect(
        emailCalls.some(
          (c) =>
            c.to === `digest-inv1-${suffix}@foundr.local` ||
            c.to === `digest-inv2-${suffix}@foundr.local`,
        ),
      ).toBe(false);

      // Verify nightly-cleanup unsets legacy otp/otpExpiry without touching AuditLog, and weekly-stats writes platform_stats
      const legacyUserRes = await User.collection.insertOne({
        name: "Legacy OTP User",
        email: `legacy-otp-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Bengaluru",
        otp: "112233",
        otpExpiry: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      createdUserIds.push(legacyUserRes.insertedId.toString());

      await AuditLog.create({
        investmentId: `audit-preserve-${suffix}`,
        eventType: "INVESTMENT_COMMITTED",
        projectId: recentProj._id,
        userId: inv1._id,
        amount: 100_000,
      });

      const cleanupRes = (await processScheduledJob(
        { name: "nightly-cleanup", data: {} } as unknown as Job,
        scheduledQueue,
        [scheduledQueue],
      )) as { legacyOtpUsersCleaned: number };
      expect(cleanupRes.legacyOtpUsersCleaned).toBeGreaterThanOrEqual(1);

      const cleanedLegacyUser = await User.collection.findOne({
        _id: legacyUserRes.insertedId,
      });
      expect(cleanedLegacyUser?.otp).toBeUndefined();
      expect(cleanedLegacyUser?.otpExpiry).toBeUndefined();

      const preservedAudit = await AuditLog.findOne({
        investmentId: `audit-preserve-${suffix}`,
      }).lean();
      expect(preservedAudit).not.toBeNull();

      const statsRes = (await processScheduledJob(
        { name: "weekly-stats", data: {} } as unknown as Job,
        scheduledQueue,
        [scheduledQueue],
      )) as { liveListings: number; investorCount: number };
      expect(statsRes.liveListings).toBeGreaterThanOrEqual(1);
      expect(statsRes.investorCount).toBeGreaterThanOrEqual(2);

      const savedSnapshot = await PlatformStats.findOne({ key: "latest" }).lean();
      expect(savedSnapshot).not.toBeNull();
    });
  });
});
