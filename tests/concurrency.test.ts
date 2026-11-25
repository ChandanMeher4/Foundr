import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let activeAuthToken = "";

// Provide request-scoped cookies and Next.js cache stubs so the real Route Handler executes verbatim
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "foundr_token" && activeAuthToken
        ? { value: activeAuthToken }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import dbConnect from "../src/lib/db";
import { signSessionToken } from "../src/lib/auth-core";
import { getRedisConnection } from "../src/lib/redis";
import { getInvestmentQueue } from "../src/lib/queue";
import User from "../src/models/User";
import Project from "../src/models/Project";
import AuditLog from "../src/models/AuditLog";
import { POST as investPost } from "../src/app/api/projects/[id]/invest/route";

describe("Investment Concurrency & Idempotency Integration", () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdRedisKeys: string[] = [];
  const createdInvestmentIds: string[] = [];
  let investorId = "";
  let developerId = "";

  beforeAll(async () => {
    await dbConnect();
    const suffix = crypto.randomBytes(6).toString("hex");

    const dev = await User.create({
      name: "Test Concurrency Dev",
      email: `test-dev-${suffix}@foundr.local`,
      password: "hashed_placeholder_not_used",
      role: "Developer",
      city: "Bengaluru",
    });
    developerId = dev._id.toString();
    createdUserIds.push(developerId);

    const inv = await User.create({
      name: "Test Concurrency Investor",
      email: `test-inv-${suffix}@foundr.local`,
      password: "hashed_placeholder_not_used",
      role: "Investor",
      city: "Mumbai",
    });
    investorId = inv._id.toString();
    createdUserIds.push(investorId);

    activeAuthToken = await signSessionToken({
      id: investorId,
      role: "Investor",
      name: inv.name,
      city: inv.city,
    });
  });

  afterAll(async () => {
    await dbConnect();
    if (createdProjectIds.length > 0) {
      await AuditLog.deleteMany({ projectId: { $in: createdProjectIds } });
      await Project.deleteMany({ _id: { $in: createdProjectIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }

    if (process.env.REDIS_URL) {
      const redis = getRedisConnection();
      if (createdRedisKeys.length > 0) {
        await redis.del(...createdRedisKeys);
      }
      const queue = getInvestmentQueue();
      for (const invId of createdInvestmentIds) {
        for (const prefix of [
          "check-funded",
          "notify-developer",
          "confirm-investor",
          "audit-log",
        ]) {
          const job = await queue.getJob(`${prefix}_${invId}`);
          if (job) {
            await job.remove().catch(() => {});
          }
        }
      }
      await queue.close();
      await redis.quit();
    }
  });

  it("never exceeds totalValuation under 20 simultaneous investments", async () => {
    const project = await Project.create({
      title: "Concurrency Verification Tower",
      description: "Automated concurrency boundary verification asset.",
      developerName: developerId,
      location: {
        type: "Point",
        coordinates: [77.5946, 12.9716],
        address: "MG Road, Bengaluru",
      },
      category: "Commercial",
      constructionStage: "Structural",
      totalValuation: 1_000_000,
      minInvestment: 200_000,
      expectedCompletion: new Date("2028-01-01"),
      currentFunding: 0,
      imageUrls: ["https://placehold.co/600x400"],
      isVerified: true,
      status: "Live",
    });

    const projectId = project._id.toString();
    createdProjectIds.push(projectId);

    const requestCount = 20;
    const commitAmount = 200_000;

    const responses = await Promise.all(
      Array.from({ length: requestCount }, () => {
        const key = crypto.randomUUID();
        createdRedisKeys.push(`idem:${investorId}:${key}`);

        const req = new Request(
          `http://localhost:3000/api/projects/${projectId}/invest`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify({ amount: commitAmount }),
          },
        );
        return investPost(req, { params: Promise.resolve({ id: projectId }) });
      }),
    );

    const statuses = responses.map((r) => r.status);
    const payloads = await Promise.all(
      responses.map((r) => r.json().catch(() => ({}))),
    );

    for (const p of payloads) {
      if (p.investmentId) createdInvestmentIds.push(p.investmentId);
    }

    const succeeded = statuses.filter((s) => s === 200).length;
    const rejected = statuses.filter((s) => s === 400).length;

    expect(succeeded).toBe(5);
    expect(rejected).toBe(15);

    const freshProject = await Project.findById(projectId).lean();
    expect(freshProject).not.toBeNull();
    expect(freshProject!.currentFunding).toBeLessThanOrEqual(
      freshProject!.totalValuation,
    );
    expect(freshProject!.currentFunding).toBe(1_000_000);
    expect(freshProject!.status).toBe("Funded");
    expect(freshProject!.investors).toHaveLength(5);
  });

  it("deduplicates 5 parallel requests sharing the same Idempotency-Key and rejects mismatched amount reuse (422)", async () => {
    const project = await Project.create({
      title: "Idempotency Verification Plaza",
      description: "Automated Redis idempotency verification asset.",
      developerName: developerId,
      location: {
        type: "Point",
        coordinates: [72.8777, 19.076],
        address: "BKC, Mumbai",
      },
      category: "Commercial",
      constructionStage: "Foundation",
      totalValuation: 1_000_000,
      minInvestment: 100_000,
      expectedCompletion: new Date("2028-06-01"),
      currentFunding: 0,
      imageUrls: ["https://placehold.co/600x400"],
      isVerified: true,
      status: "Live",
    });

    const projectId = project._id.toString();
    createdProjectIds.push(projectId);

    const sharedKey = crypto.randomUUID();
    createdRedisKeys.push(`idem:${investorId}:${sharedKey}`);

    const parallelResponses = await Promise.all(
      Array.from({ length: 5 }, () => {
        const req = new Request(
          `http://localhost:3000/api/projects/${projectId}/invest`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": sharedKey,
            },
            body: JSON.stringify({ amount: 250_000 }),
          },
        );
        return investPost(req, { params: Promise.resolve({ id: projectId }) });
      }),
    );

    const payloads = await Promise.all(parallelResponses.map((r) => r.json()));
    for (const p of payloads) {
      if (p.investmentId && !createdInvestmentIds.includes(p.investmentId)) {
        createdInvestmentIds.push(p.investmentId);
      }
    }

    const freshProject = await Project.findById(projectId).lean();
    expect(freshProject!.currentFunding).toBe(250_000);
    expect(freshProject!.investors).toHaveLength(1);

    // Reusing the same Idempotency-Key with a different amount must return 422
    const mismatchReq = new Request(
      `http://localhost:3000/api/projects/${projectId}/invest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": sharedKey,
        },
        body: JSON.stringify({ amount: 300_000 }),
      },
    );
    const mismatchRes = await investPost(mismatchReq, {
      params: Promise.resolve({ id: projectId }),
    });
    expect(mismatchRes.status).toBe(422);
  });
});
