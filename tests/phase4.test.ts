import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const cookieAls = new AsyncLocalStorage<{ token?: string }>();
const emailCalls: Array<{ to: string | string[]; subject: string; html: string }> =
  [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const token = cookieAls.getStore()?.token;
      return name === "foundr_token" && token ? { value: token } : undefined;
    },
    set: () => {},
    delete: () => {},
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
import { signSessionToken } from "../src/lib/auth-core";
import { getRedisConnection, getRedisKeyPrefix } from "../src/lib/redis";
import { setCacheClientForTest } from "../src/lib/cache";
import { formatIstDateKey, getTrendingProjectScores } from "../src/lib/trending";
import {
  getInvestmentFlowProducer,
  getInvestmentQueue,
  getLifecycleQueue,
  getPaymentsQueue,
  getScheduledQueue,
} from "../src/lib/queue";
import {
  type RazorpayClientLike,
  type RazorpayOrderCreateInput,
  type RazorpayPaymentEntity,
  setRazorpayClientForTest,
} from "../src/lib/razorpay";
import {
  finalizePayment,
  processWebhookEventById,
  recordPaymentsDeadLetter,
  releaseReservation,
  runPaymentsReaperSweep,
} from "../src/lib/payments";
import { registerScheduledJobs } from "../worker/index";
import {
  processLifecycleJob,
  processPaymentsJob,
  processScheduledJob,
} from "../worker/processors";
import User from "../src/models/User";
import Project from "../src/models/Project";
import Payment from "../src/models/Payment";
import WebhookEvent from "../src/models/WebhookEvent";
import DeadLetter from "../src/models/DeadLetter";
import AuditLog from "../src/models/AuditLog";
import { GET as projectsGet } from "../src/app/api/projects/route";
import { POST as checkoutPost } from "../src/app/api/projects/[id]/checkout/route";
import { POST as investPost } from "../src/app/api/projects/[id]/invest/route";
import { POST as webhooksPost } from "../src/app/api/webhooks/razorpay/route";
import { POST as paymentsVerifyPost } from "../src/app/api/payments/verify/route";
import { GET as paymentStatusGet } from "../src/app/api/payments/[reservationId]/status/route";
import { GET as deadLettersGet } from "../src/app/api/admin/dead-letters/route";
import { POST as deadLetterReplayPost } from "../src/app/api/admin/dead-letters/[id]/replay/route";
import { POST as deadLetterDiscardPost } from "../src/app/api/admin/dead-letters/[id]/discard/route";

function runWithToken<T>(
  token: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return cookieAls.run({ token }, fn);
}

function signWebhookBody(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signCheckoutPayload(
  orderId: string,
  paymentId: string,
  keySecret: string,
): string {
  return crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

async function clearTestRedisKeys(): Promise<number> {
  if (!process.env.REDIS_URL) return 0;
  const redis = getRedisConnection();
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      "test:*",
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length === 0) return 0;
  return redis.del(...keys);
}

describe("Phase 4: Razorpay Test Mode Payments, Capacity Reservations & Mongo DLQ", () => {
  const createdUserIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdWebhookEventIds: string[] = [];
  const createdDeadLetterIds: string[] = [];
  const createdExtraAuditIds: string[] = [];

  const prevPaymentsEnabled = process.env.PAYMENTS_ENABLED;
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const prevAdminEmail = process.env.ADMIN_EMAIL;
  const prevDemoMode = process.env.PAYMENTS_DEMO_MODE;

  const TEST_KEY_ID = "rzp_test_mock_key_01";
  const TEST_KEY_SECRET = "rzp_test_mock_secret_01";
  const TEST_WEBHOOK_SECRET = "rzp_test_webhook_secret_01";

  let adminId = "";
  let devId = "";
  let investorId = "";
  let otherInvestorId = "";

  let adminToken = "";
  let devToken = "";
  let investorToken = "";
  let otherInvestorToken = "";

  let orderCreateCalls: Array<{
    amount: number;
    receipt: string;
    payment?: RazorpayOrderCreateInput["payment"];
  }> = [];
  let refundCalls: Array<{ paymentId: string; amount?: number }> = [];
  let mockOrderOverrides = new Map<
    string,
    {
      status: string;
      amount: number;
      items?: Array<{
        id: string;
        order_id?: string;
        status: string;
        amount: number;
        currency?: string;
      }>;
    }
  >();
  let mockPaymentOverrides = new Map<string, RazorpayPaymentEntity>();
  let forceOrderCreateFail = false;

  function installDefaultRazorpayMock() {
    let orderSeq = 0;
    let refundSeq = 0;
    const mockClient: RazorpayClientLike = {
      orders: {
        async create(params) {
          if (forceOrderCreateFail) {
            throw new Error("Simulated Razorpay orders.create upstream failure");
          }
          orderSeq += 1;
          orderCreateCalls.push({
            amount: params.amount,
            receipt: params.receipt,
            payment: params.payment,
          });
          return {
            id: `order_mock_${orderSeq}_${crypto.randomBytes(3).toString("hex")}`,
            status: "created",
            amount: params.amount,
            currency: params.currency,
            receipt: params.receipt,
          };
        },
        async fetch(orderId) {
          const override = mockOrderOverrides.get(orderId);
          if (override) {
            return {
              id: orderId,
              status: override.status,
              amount: override.amount,
              currency: "INR",
            };
          }
          return {
            id: orderId,
            status: "created",
            amount: 100_000 * 100,
            currency: "INR",
          };
        },
        async fetchPayments(orderId) {
          const override = mockOrderOverrides.get(orderId);
          return {
            items: override?.items ?? [],
          };
        },
      },
      payments: {
        async fetch(paymentId) {
          const override = mockPaymentOverrides.get(paymentId);
          if (override) {
            return override;
          }
          return {
            id: paymentId,
            order_id: "order_unknown",
            status: "created",
            amount: 0,
            currency: "INR",
          };
        },
        async refund(paymentId, params) {
          refundSeq += 1;
          refundCalls.push({ paymentId, amount: params?.amount });
          return {
            id: `rfnd_mock_${refundSeq}_${crypto.randomBytes(3).toString("hex")}`,
            payment_id: paymentId,
            amount: params?.amount,
            status: "processed",
          };
        },
      },
    };
    setRazorpayClientForTest(mockClient);
  }

  async function createTestProject(overrides: Record<string, unknown> = {}) {
    const proj = await Project.create({
      title: `Phase4 Project ${crypto.randomBytes(3).toString("hex")}`,
      description: "Commercial asset for Phase 4 reservation and payment tests.",
      developerName: devId,
      location: {
        type: "Point",
        coordinates: [77.5946, 12.9716],
        address: "Residency Road, Bengaluru",
      },
      category: "Commercial",
      constructionStage: "Structural",
      totalValuation: 500_000,
      minInvestment: 100_000,
      expectedCompletion: new Date("2028-12-01"),
      currentFunding: 0,
      reservedFunding: 0,
      reservations: [],
      imageUrls: ["https://placehold.co/600x400"],
      isVerified: true,
      status: "Live",
      approvedAt: new Date(),
      ...overrides,
    });
    createdProjectIds.push(proj._id.toString());
    return proj;
  }

  beforeAll(async () => {
    const conn = await dbConnect();
    const dbName = conn.connection.db?.databaseName || "";
    expect(dbName.endsWith("_test")).toBe(true);

    const suffix = crypto.randomBytes(4).toString("hex");
    const [admin, dev, inv1, inv2] = await User.create([
      {
        name: "P4 Admin",
        email: `p4-admin-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Admin",
        city: "Bengaluru",
      },
      {
        name: "P4 Developer",
        email: `p4-dev-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Developer",
        city: "Bengaluru",
      },
      {
        name: "P4 Investor 1",
        email: `p4-inv1-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Mumbai",
      },
      {
        name: "P4 Investor 2",
        email: `p4-inv2-${suffix}@foundr.local`,
        password: "placeholder_password_hash",
        role: "Investor",
        city: "Delhi",
      },
    ]);

    adminId = admin._id.toString();
    devId = dev._id.toString();
    investorId = inv1._id.toString();
    otherInvestorId = inv2._id.toString();
    createdUserIds.push(adminId, devId, investorId, otherInvestorId);

    [adminToken, devToken, investorToken, otherInvestorToken] =
      await Promise.all([
        signSessionToken({
          id: adminId,
          role: "Admin",
          name: admin.name,
          city: admin.city,
        }),
        signSessionToken({
          id: devId,
          role: "Developer",
          name: dev.name,
          city: dev.city,
        }),
        signSessionToken({
          id: investorId,
          role: "Investor",
          name: inv1.name,
          city: inv1.city,
        }),
        signSessionToken({
          id: otherInvestorId,
          role: "Investor",
          name: inv2.name,
          city: inv2.city,
        }),
      ]);
  });

  beforeEach(async () => {
    process.env.PAYMENTS_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.ADMIN_EMAIL = "dlq-admin@foundr.local";
    process.env.PAYMENTS_DEMO_MODE = "false";

    orderCreateCalls = [];
    refundCalls = [];
    mockOrderOverrides = new Map();
    mockPaymentOverrides = new Map();
    forceOrderCreateFail = false;
    emailCalls.length = 0;

    setCacheClientForTest(null);
    installDefaultRazorpayMock();
    await clearTestRedisKeys();
  });

  afterAll(async () => {
    process.env.PAYMENTS_ENABLED = prevPaymentsEnabled;
    process.env.RAZORPAY_KEY_ID = prevKeyId;
    process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;
    process.env.ADMIN_EMAIL = prevAdminEmail;
    process.env.PAYMENTS_DEMO_MODE = prevDemoMode;

    setRazorpayClientForTest(null);
    setCacheClientForTest(null);

    await dbConnect();

    if (createdProjectIds.length > 0) {
      await Promise.all([
        Payment.deleteMany({ projectId: { $in: createdProjectIds } }),
        AuditLog.deleteMany({ projectId: { $in: createdProjectIds } }),
        Project.deleteMany({ _id: { $in: createdProjectIds } }),
      ]);
    }
    if (createdWebhookEventIds.length > 0) {
      await WebhookEvent.deleteMany({ eventId: { $in: createdWebhookEventIds } });
    }
    if (createdDeadLetterIds.length > 0) {
      await DeadLetter.deleteMany({ _id: { $in: createdDeadLetterIds } });
    }
    if (createdExtraAuditIds.length > 0) {
      await AuditLog.deleteMany({ investmentId: { $in: createdExtraAuditIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }

    await clearTestRedisKeys();
    await getPaymentsQueue().close().catch(() => {});
    await getInvestmentFlowProducer().close().catch(() => {});
    await getInvestmentQueue().close().catch(() => {});
    await getLifecycleQueue().close().catch(() => {});
    await getScheduledQueue().close().catch(() => {});
    if (process.env.REDIS_URL) {
      await getRedisConnection().quit();
    }
    await mongoose.disconnect();
  });

  describe("Part 1: Atomic Capacity Reservation, Legacy Safety, Idempotency & Validation", () => {
    it("enforces currentFunding + reservedFunding <= totalValuation across 20 parallel checkouts and keeps status Live until capture", async () => {
      const proj = await createTestProject({
        totalValuation: 300_000,
        minInvestment: 100_000,
      });
      const projId = proj._id.toString();

      const batchSuffix = crypto.randomBytes(3).toString("hex");
      const batchUsers = (await User.create(
        Array.from({ length: 20 }, (_, i) => ({
          name: `Parallel Inv ${i}`,
          email: `p4-par-${batchSuffix}-${i}@foundr.local`,
          password: "placeholder_password_hash",
          role: "Investor",
          city: "Mumbai",
        })),
      )) as unknown as Array<{
        _id: mongoose.Types.ObjectId;
        name: string;
        city: string;
      }>;
      createdUserIds.push(...batchUsers.map((u) => u._id.toString()));

      const tokens = await Promise.all(
        batchUsers.map((u) =>
          signSessionToken({
            id: u._id.toString(),
            role: "Investor",
            name: u.name,
            city: u.city,
          }),
        ),
      );

      const responses = await Promise.all(
        tokens.map((tok, i) =>
          runWithToken(tok, () =>
            checkoutPost(
              new Request(`http://localhost/api/projects/${projId}/checkout`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": `par-key-${batchSuffix}-${i}`,
                },
                body: JSON.stringify({ amount: 100_000 }),
              }),
              { params: Promise.resolve({ id: projId }) },
            ),
          ),
        ),
      );

      const okResponses = responses.filter((r) => r.status === 200);
      const conflictResponses = responses.filter((r) => r.status === 409);

      expect(okResponses).toHaveLength(3);
      expect(conflictResponses).toHaveLength(17);

      const sampleConflict = (await conflictResponses[0].json()) as {
        error: string;
        expiresAt: string | null;
        unreservedRemaining: number;
      };
      expect(sampleConflict.error).toContain("temporarily held");
      expect(typeof sampleConflict.expiresAt).toBe("string");
      expect(sampleConflict.unreservedRemaining).toBe(0);

      const dbProj = await Project.findById(projId).lean<{
        currentFunding: number;
        reservedFunding?: number;
        totalValuation: number;
        status: string;
        reservations?: unknown[];
      }>();
      expect(dbProj!.currentFunding).toBe(0);
      expect(dbProj!.reservedFunding).toBe(300_000);
      expect(dbProj!.currentFunding + (dbProj!.reservedFunding || 0)).toBeLessThanOrEqual(
        dbProj!.totalValuation,
      );
      expect(dbProj!.status).toBe("Live");
      expect(dbProj!.reservations).toHaveLength(3);
      expect(await Payment.countDocuments({ projectId: projId })).toBe(3);
      expect(orderCreateCalls).toHaveLength(3);
    });

    it("supports legacy projects without reservedFunding/reservations in both checkout and /invest, and /invest subtracts reservedFunding", async () => {
      const legacyInsert = await Project.collection.insertOne({
        title: `Legacy No-Reserved ${crypto.randomBytes(3).toString("hex")}`,
        description: "Legacy listing inserted without reservedFunding field.",
        developerName: new mongoose.Types.ObjectId(devId),
        location: {
          type: "Point",
          coordinates: [77.5946, 12.9716],
          address: "Indiranagar, Bengaluru",
        },
        category: "Commercial",
        constructionStage: "Finishing",
        totalValuation: 500_000,
        minInvestment: 100_000,
        expectedCompletion: new Date("2028-09-01"),
        currentFunding: 100_000,
        imageUrls: ["https://placehold.co/600x400"],
        isVerified: true,
        status: "Live",
        approvedAt: new Date(),
        investors: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const legacyId = legacyInsert.insertedId.toString();
      createdProjectIds.push(legacyId);

      // 1. Checkout succeeds on legacy doc
      const resCheckout = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${legacyId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `leg-chk-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 200_000 }),
          }),
          { params: Promise.resolve({ id: legacyId }) },
        ),
      );
      expect(resCheckout.status).toBe(200);

      // 2. When PAYMENTS_ENABLED=false, /invest honors reservedFunding (500k - 100k - 200k = 200k unreserved)
      process.env.PAYMENTS_ENABLED = "false";
      const resOver = await runWithToken(otherInvestorToken, () =>
        investPost(
          new Request(`http://localhost/api/projects/${legacyId}/invest`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `leg-inv-over-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 250_000 }),
          }),
          { params: Promise.resolve({ id: legacyId }) },
        ),
      );
      expect(resOver.status).toBe(400);
      const overJson = (await resOver.json()) as { error: string };
      expect(overJson.error).toContain("2,00,000");

      const resOkInvest = await runWithToken(otherInvestorToken, () =>
        investPost(
          new Request(`http://localhost/api/projects/${legacyId}/invest`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `leg-inv-ok-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 200_000 }),
          }),
          { params: Promise.resolve({ id: legacyId }) },
        ),
      );
      expect(resOkInvest.status).toBe(200);

      const updatedLegacy = await Project.findById(legacyId).lean<{
        currentFunding: number;
        reservedFunding?: number;
        totalValuation: number;
      }>();
      expect(updatedLegacy!.currentFunding).toBe(300_000);
      expect(updatedLegacy!.reservedFunding).toBe(200_000);
      expect(
        updatedLegacy!.currentFunding + (updatedLegacy!.reservedFunding || 0),
      ).toBeLessThanOrEqual(updatedLegacy!.totalValuation);

      // 3. Direct /invest on a completely untouched legacy document without reservedFunding field also succeeds
      const legacy2Insert = await Project.collection.insertOne({
        title: `Legacy Invest Only ${crypto.randomBytes(3).toString("hex")}`,
        description: "Legacy listing without reservedFunding tested directly on /invest.",
        developerName: new mongoose.Types.ObjectId(devId),
        location: {
          type: "Point",
          coordinates: [77.5946, 12.9716],
          address: "Koramangala, Bengaluru",
        },
        category: "Residential",
        constructionStage: "Structural",
        totalValuation: 400_000,
        minInvestment: 100_000,
        expectedCompletion: new Date("2028-09-01"),
        currentFunding: 0,
        imageUrls: ["https://placehold.co/600x400"],
        isVerified: true,
        status: "Live",
        approvedAt: new Date(),
        investors: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const legacy2Id = legacy2Insert.insertedId.toString();
      createdProjectIds.push(legacy2Id);

      const resLegacyInvest = await runWithToken(investorToken, () =>
        investPost(
          new Request(`http://localhost/api/projects/${legacy2Id}/invest`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `leg2-inv-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: legacy2Id }) },
        ),
      );
      expect(resLegacyInvest.status).toBe(200);
    });

    it("replays duplicate Idempotency-Key checkout, rejects amount mismatch (422), and rolls back reservation if Razorpay fails (502)", async () => {
      const proj = await createTestProject({
        totalValuation: 500_000,
        minInvestment: 100_000,
      });
      const projId = proj._id.toString();
      const idemKey = `idem-replay-${crypto.randomBytes(4).toString("hex")}`;

      const res1 = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idemKey,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      expect(body1.amountPaise).toBe(100_000 * 100);

      // Replay with same key + same amount
      const res2 = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idemKey,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(res2.status).toBe(200);
      expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
      const body2 = (await res2.json()) as {
        orderId: string;
        reservationId: string;
      };
      expect(body2.orderId).toBe(body1.orderId);
      expect(body2.reservationId).toBe(body1.reservationId);
      expect(orderCreateCalls).toHaveLength(1);

      // Replay with same key + DIFFERENT amount -> 422
      const resMismatch = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idemKey,
            },
            body: JSON.stringify({ amount: 200_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(resMismatch.status).toBe(422);

      // Compensating release when Razorpay orders.create throws -> 502 and reservedFunding untouched
      forceOrderCreateFail = true;
      const resFail = await runWithToken(otherInvestorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `idem-fail-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 150_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(resFail.status).toBe(502);

      const afterProj = await Project.findById(projId).lean<{
        reservedFunding?: number;
        reservations?: unknown[];
      }>();
      expect(afterProj!.reservedFunding).toBe(100_000);
      expect(afterProj!.reservations).toHaveLength(1);
    });

    it("gates /invest with 409 when PAYMENTS_ENABLED=true and rejects non-integer floats with 400 on /checkout and /invest", async () => {
      const proj = await createTestProject();
      const projId = proj._id.toString();

      const res409 = await runWithToken(investorToken, () =>
        investPost(
          new Request(`http://localhost/api/projects/${projId}/invest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(res409.status).toBe(409);
      const gatedJson = (await res409.json()) as { checkoutEndpoint: string };
      expect(gatedJson.checkoutEndpoint).toBe(`/api/projects/${projId}/checkout`);

      // Float rejection on /checkout
      const resFloatCheckout = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "float-chk-1",
            },
            body: JSON.stringify({ amount: 100_000.75 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(resFloatCheckout.status).toBe(400);

      // Float rejection on /invest when flag off
      process.env.PAYMENTS_ENABLED = "false";
      const resFloatInvest = await runWithToken(investorToken, () =>
        investPost(
          new Request(`http://localhost/api/projects/${projId}/invest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: 100_000.25 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(resFloatInvest.status).toBe(400);
    });
  });

  describe("Part 2: Webhook Outbox, Verify Route & Strict Payment State Machine", () => {
    it("verifies HMAC webhook signatures, rejects invalid/missing headers, deduplicates events, and enforces state transitions", async () => {
      const proj = await createTestProject({
        totalValuation: 300_000,
        minInvestment: 100_000,
      });
      const projId = proj._id.toString();

      // 1. Checkout creates pending reservation
      const chkRes = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `sm-chk-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(chkRes.status).toBe(200);
      const { orderId, reservationId, amountPaise } = (await chkRes.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };

      // 2. Tampered / bad signature / missing event id / missing sig -> 400 and NO WebhookEvent saved
      const badEvtId = `evt_bad_${crypto.randomBytes(4).toString("hex")}`;
      const samplePayload = JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_x", order_id: orderId, amount: amountPaise } } },
      });

      const resBadSig = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": "deadbeef",
            "x-razorpay-event-id": badEvtId,
          },
          body: samplePayload,
        }),
      );
      expect(resBadSig.status).toBe(400);

      const resWrongSecret = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(samplePayload, "wrong_secret"),
            "x-razorpay-event-id": badEvtId,
          },
          body: samplePayload,
        }),
      );
      expect(resWrongSecret.status).toBe(400);

      const resMissingEvtId = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              samplePayload,
              TEST_WEBHOOK_SECRET,
            ),
          },
          body: samplePayload,
        }),
      );
      expect(resMissingEvtId.status).toBe(400);
      expect(await WebhookEvent.countDocuments({ eventId: badEvtId })).toBe(0);

      // 3. POST /api/payments/verify marks Payment authorized WITHOUT changing Project.currentFunding
      const mockPaymentId = `pay_verify_${crypto.randomBytes(4).toString("hex")}`;
      const checkoutSig = signCheckoutPayload(
        orderId,
        mockPaymentId,
        TEST_KEY_SECRET,
      );

      // Non-owner Investor gets 403
      const resOtherVerify = await runWithToken(otherInvestorToken, () =>
        paymentsVerifyPost(
          new Request("http://localhost/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId,
              paymentId: mockPaymentId,
              signature: checkoutSig,
            }),
          }),
        ),
      );
      expect(resOtherVerify.status).toBe(403);

      // Bad HMAC gets 400
      const resBadVerifySig = await runWithToken(investorToken, () =>
        paymentsVerifyPost(
          new Request("http://localhost/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId,
              paymentId: mockPaymentId,
              signature: "invalid_sig",
            }),
          }),
        ),
      );
      expect(resBadVerifySig.status).toBe(400);

      const resVerifyOk = await runWithToken(investorToken, () =>
        paymentsVerifyPost(
          new Request("http://localhost/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId,
              paymentId: mockPaymentId,
              signature: checkoutSig,
            }),
          }),
        ),
      );
      expect(resVerifyOk.status).toBe(200);
      const verifyJson = (await resVerifyOk.json()) as {
        verified: boolean;
        status: string;
      };
      expect(verifyJson.verified).toBe(true);
      expect(verifyJson.status).toBe("authorized");

      const projAfterVerify = await Project.findById(projId).lean<{
        currentFunding: number;
        reservedFunding?: number;
      }>();
      expect(projAfterVerify!.currentFunding).toBe(0);
      expect(projAfterVerify!.reservedFunding).toBe(100_000);

      // 4. payment.failed webhook keeps reservation intact & moves authorized -> failed; duplicate returns 200 duplicate
      const failedEvtId = `evt_fail_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(failedEvtId);
      const failedRaw = JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: mockPaymentId,
              order_id: orderId,
              amount: amountPaise,
              error_description: "Card declined in test mode",
            },
          },
        },
      });
      const failedSig = signWebhookBody(failedRaw, TEST_WEBHOOK_SECRET);

      const whFail1 = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": failedSig,
            "x-razorpay-event-id": failedEvtId,
          },
          body: failedRaw,
        }),
      );
      expect(whFail1.status).toBe(200);

      const whFailDup = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": failedSig,
            "x-razorpay-event-id": failedEvtId,
          },
          body: failedRaw,
        }),
      );
      expect(whFailDup.status).toBe(200);
      expect(((await whFailDup.json()) as { duplicate?: boolean }).duplicate).toBe(
        true,
      );
      expect(await WebhookEvent.countDocuments({ eventId: failedEvtId })).toBe(1);

      await processWebhookEventById(failedEvtId);
      const paymentAfterFail = await Payment.findOne({ reservationId }).lean<{
        status: string;
        lastError?: string;
      }>();
      expect(paymentAfterFail!.status).toBe("failed");
      expect(paymentAfterFail!.lastError).toBe("Card declined in test mode");
      expect((await Project.findById(projId).lean())!.reservedFunding).toBe(
        100_000,
      );

      // 5. Retried payment.captured webhook transitions failed -> captured and commits capacity
      const capEvtId = `evt_cap_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(capEvtId);
      const retryPayId = `${mockPaymentId}_retry`;
      mockPaymentOverrides.set(retryPayId, {
        id: retryPayId,
        order_id: orderId,
        status: "captured",
        amount: amountPaise,
        currency: "INR",
      });
      const capRaw = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: retryPayId,
              order_id: orderId,
              amount: amountPaise,
              currency: "INR",
            },
          },
        },
      });
      await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(capRaw, TEST_WEBHOOK_SECRET),
            "x-razorpay-event-id": capEvtId,
          },
          body: capRaw,
        }),
      );
      await processWebhookEventById(capEvtId);

      const paymentAfterCap = await Payment.findOne({ reservationId }).lean<{
        status: string;
      }>();
      expect(paymentAfterCap!.status).toBe("captured");

      // 6. Out-of-order late payment.failed AFTER captured is ignored cleanly
      const lateFailEvtId = `evt_latefail_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(lateFailEvtId);
      await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              failedRaw,
              TEST_WEBHOOK_SECRET,
            ),
            "x-razorpay-event-id": lateFailEvtId,
          },
          body: failedRaw,
        }),
      );
      const lateFailRes = await processWebhookEventById(lateFailEvtId);
      expect(lateFailRes.detail).toBe("transition_ignored");
      expect((await Payment.findOne({ reservationId }).lean())!.status).toBe(
        "captured",
      );
    });

    it("returns 200 when Redis enqueue fails after outbox write and reaper recovers stale unprocessed webhooks", async () => {
      const paymentsQueue = getPaymentsQueue();
      const addSpy = vi
        .spyOn(paymentsQueue, "add")
        .mockRejectedValueOnce(new Error("Simulated Redis timeout during enqueue"));

      const evtId = `evt_reaper_rec_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(evtId);
      const rawBody = JSON.stringify({
        event: "order.paid",
        payload: {
          order: { entity: { id: "order_missing_demo", amount: 10_000_000 } },
        },
      });

      const res = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              rawBody,
              TEST_WEBHOOK_SECRET,
            ),
            "x-razorpay-event-id": evtId,
          },
          body: rawBody,
        }),
      );
      addSpy.mockRestore();

      expect(res.status).toBe(200);
      const savedOutbox = await WebhookEvent.findOne({ eventId: evtId }).lean();
      expect(savedOutbox).not.toBeNull();
      expect(savedOutbox!.processedAt).toBeNull();

      // Backdate receivedAt > 2 minutes so reaper picks it up
      await WebhookEvent.updateOne(
        { eventId: evtId },
        { $set: { receivedAt: new Date(Date.now() - 3 * 60 * 1000) } },
      );

      const sweep = await runPaymentsReaperSweep(paymentsQueue);
      expect(sweep.staleWebhooksReenqueued).toBeGreaterThanOrEqual(1);

      const recoveredJob = await paymentsQueue.getJob(`webhook_${evtId}`);
      expect(recoveredJob).toBeDefined();
      expect(recoveredJob!.name).toBe("process-webhook");
    });
  });

  describe("Part 3: Finalize Idempotency, Cache Separation, Expiry, Deferral & Late Refund", () => {
    it("keeps marketplace cache HIT across reserve and release, invalidates once on finalize, updates Funded/trending/AuditLog once", async () => {
      const proj = await createTestProject({
        title: `CacheFin ${crypto.randomBytes(3).toString("hex")}`,
        totalValuation: 200_000,
        minInvestment: 100_000,
      });
      const projId = proj._id.toString();

      // Warm cache
      const rMiss = await projectsGet(new Request("http://localhost/api/projects"));
      expect(rMiss.headers.get("X-Cache")).toBe("MISS");
      const rHit = await projectsGet(new Request("http://localhost/api/projects"));
      expect(rHit.headers.get("X-Cache")).toBe("HIT");

      // Reserve 100k -> cache MUST stay HIT
      const res1 = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `cache-res1-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      expect(res1.status).toBe(200);
      const chk1 = (await res1.json()) as { reservationId: string; orderId: string };

      expect(
        (await projectsGet(new Request("http://localhost/api/projects"))).headers.get(
          "X-Cache",
        ),
      ).toBe("HIT");

      // Release reservation -> cache MUST STILL be HIT
      const rel = await releaseReservation({
        projectId: projId,
        reservationId: chk1.reservationId,
        orderId: chk1.orderId,
      });
      expect(rel.action).toBe("released");
      expect(
        (await projectsGet(new Request("http://localhost/api/projects"))).headers.get(
          "X-Cache",
        ),
      ).toBe("HIT");

      // Reserve full 200k then finalize TWICE -> commits once, transitions to Funded, trending +5 once, invalidates cache
      const res2 = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `cache-res2-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 200_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      const chk2 = (await res2.json()) as {
        reservationId: string;
        orderId: string;
        amountPaise: number;
      };

      mockPaymentOverrides.set("pay_cache_fin_1", {
        id: "pay_cache_fin_1",
        order_id: chk2.orderId,
        status: "captured",
        amount: chk2.amountPaise,
        currency: "INR",
      });
      const fin1 = await finalizePayment({
        reservationId: chk2.reservationId,
        orderId: chk2.orderId,
        paymentId: "pay_cache_fin_1",
        amountPaise: chk2.amountPaise,
      });
      const fin2 = await finalizePayment({
        reservationId: chk2.reservationId,
        orderId: chk2.orderId,
        paymentId: "pay_cache_fin_1",
        amountPaise: chk2.amountPaise,
      });

      expect(fin1.status).toBe("finalized");
      expect(fin2.status).toBe("already_finalized");

      const finalProj = await Project.findById(projId).lean<{
        status: string;
        currentFunding: number;
        reservedFunding?: number;
        investors: unknown[];
      }>();
      expect(finalProj!.status).toBe("Funded");
      expect(finalProj!.currentFunding).toBe(200_000);
      expect(finalProj!.reservedFunding).toBe(0);
      expect(finalProj!.investors).toHaveLength(1);

      expect(
        await AuditLog.countDocuments({
          investmentId: `paycap_${chk2.reservationId}`,
        }),
      ).toBe(1);

      const dailyScoreRaw = await getRedisConnection().zscore(
        `${getRedisKeyPrefix()}trending:${formatIstDateKey()}`,
        projId,
      );
      expect(Number(dailyScoreRaw)).toBe(5);
      const trendingEntries = await getTrendingProjectScores({ forceRebuild: true });
      const trendingProj = trendingEntries.find((e) => e.projectId === projId);
      expect(trendingProj?.score).toBe(35);

      const rAfterFin = await projectsGet(
        new Request("http://localhost/api/projects"),
      );
      expect(rAfterFin.headers.get("X-Cache")).toBe("MISS");
    });

    it("finalizes instead on Razorpay paid order check, cleans crash orphans in reaper, and handles expire-listing deferral", async () => {
      const proj = await createTestProject({
        totalValuation: 500_000,
        minInvestment: 100_000,
      });
      const projId = proj._id.toString();

      // 1. Order already paid on Razorpay during release check -> finalizes instead
      const resPaidCheck = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `paid-chk-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      const { orderId, reservationId, amountPaise } =
        (await resPaidCheck.json()) as {
          orderId: string;
          reservationId: string;
          amountPaise: number;
        };

      mockOrderOverrides.set(orderId, {
        status: "paid",
        amount: amountPaise,
        items: [
          {
            id: "pay_recovered_order_1",
            order_id: orderId,
            status: "captured",
            amount: amountPaise,
            currency: "INR",
          },
        ],
      });
      mockPaymentOverrides.set("pay_recovered_order_1", {
        id: "pay_recovered_order_1",
        order_id: orderId,
        status: "captured",
        amount: amountPaise,
        currency: "INR",
      });

      const relPaid = await releaseReservation({
        projectId: projId,
        reservationId,
        orderId,
      });
      expect(relPaid.action).toBe("finalized_instead");

      // Double-release on already finalized reservation -> noop
      const relNoop = await releaseReservation({
        projectId: projId,
        reservationId,
        orderId,
      });
      expect(relNoop.action).toBe("noop");

      const projAfterPaid = await Project.findById(projId).lean<{
        currentFunding: number;
        reservedFunding?: number;
      }>();
      expect(projAfterPaid!.currentFunding).toBe(100_000);
      expect(projAfterPaid!.reservedFunding).toBe(0);

      // 2. Crash orphan reservation (on Project without Payment doc) cleaned by reaper + AuditLog written
      const orphanResId = `orphan_${crypto.randomBytes(4).toString("hex")}`;
      await Project.updateOne(
        { _id: projId },
        {
          $push: {
            reservations: {
              reservationId: orphanResId,
              userId: new mongoose.Types.ObjectId(otherInvestorId),
              amount: 100_000,
              idempotencyKey: `orphan_idem_${orphanResId}`,
              status: "pending",
              expiresAt: new Date(Date.now() - 30_000),
              createdAt: new Date(Date.now() - 600_000),
            },
          },
          $inc: { reservedFunding: 100_000 },
        },
      );

      // 3. expire-listing while reservedFunding > 0 MUST defer rather than mark Expired
      const deferRes = (await processLifecycleJob({
        name: "expire-listing",
        data: {
          projectId: projId,
          approvedAt: new Date(proj.approvedAt!).toISOString(),
        },
      } as unknown as Job)) as { deferred?: boolean };
      expect(deferRes.deferred).toBe(true);
      expect((await Project.findById(projId).lean())!.status).toBe("Live");

      // Now run reaper -> releases expired orphan
      const sweepRes = await runPaymentsReaperSweep(getPaymentsQueue());
      expect(sweepRes.expiredReservationsProcessed).toBeGreaterThanOrEqual(1);
      expect((await Project.findById(projId).lean())!.reservedFunding).toBe(0);
      const orphanAudit = await AuditLog.findOne({
        investmentId: `resrel_${orphanResId}`,
      }).lean();
      expect(orphanAudit).not.toBeNull();
      expect(orphanAudit!.eventType).toBe("RESERVATION_RELEASED");

      // 4. Now reservedFunding === 0 -> expire-listing expires it to Expired
      const expireRes = (await processLifecycleJob({
        name: "expire-listing",
        data: {
          projectId: projId,
          approvedAt: new Date(proj.approvedAt!).toISOString(),
        },
      } as unknown as Job)) as { expired?: boolean };
      expect(expireRes.expired).toBe(true);
      expect((await Project.findById(projId).lean())!.status).toBe("Expired");
    });

    it("handles late payment capture after expiry: re-reserves when capacity exists, or refunds + emails when capacity is gone", async () => {
      // Case A: Live + capacity open -> finalized_late
      const projOpen = await createTestProject({
        totalValuation: 500_000,
        minInvestment: 100_000,
      });
      const openId = projOpen._id.toString();

      const resA = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${openId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `late-open-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: openId }) },
        ),
      );
      const chkA = (await resA.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      await releaseReservation({
        projectId: openId,
        reservationId: chkA.reservationId,
        orderId: chkA.orderId,
      });

      mockPaymentOverrides.set("pay_late_win_1", {
        id: "pay_late_win_1",
        order_id: chkA.orderId,
        status: "captured",
        amount: chkA.amountPaise,
        currency: "INR",
      });
      const lateWin = await finalizePayment({
        reservationId: chkA.reservationId,
        orderId: chkA.orderId,
        paymentId: "pay_late_win_1",
        amountPaise: chkA.amountPaise,
      });
      expect(lateWin.status).toBe("finalized_late");
      expect((await Project.findById(openId).lean())!.currentFunding).toBe(
        100_000,
      );
      expect(
        (await Payment.findOne({ reservationId: chkA.reservationId }).lean())!
          .status,
      ).toBe("captured");

      // Case B: Expired reservation + capacity taken (project Marked Expired) -> test refund + email + AuditLog
      const projFull = await createTestProject({
        totalValuation: 200_000,
        minInvestment: 100_000,
      });
      const fullId = projFull._id.toString();

      const resB = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${fullId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `late-ref-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 200_000 }),
          }),
          { params: Promise.resolve({ id: fullId }) },
        ),
      );
      const chkB = (await resB.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      await releaseReservation({
        projectId: fullId,
        reservationId: chkB.reservationId,
        orderId: chkB.orderId,
      });
      await Project.updateOne({ _id: fullId }, { $set: { status: "Expired" } });

      const refundEvtId = `evt_late_cap_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(refundEvtId);
      const latePayId = `pay_late_ref_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(latePayId, {
        id: latePayId,
        order_id: chkB.orderId,
        status: "captured",
        amount: chkB.amountPaise,
        currency: "INR",
      });
      const lateCapRaw = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: latePayId,
              order_id: chkB.orderId,
              amount: chkB.amountPaise,
              currency: "INR",
            },
          },
        },
      });
      await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              lateCapRaw,
              TEST_WEBHOOK_SECRET,
            ),
            "x-razorpay-event-id": refundEvtId,
          },
          body: lateCapRaw,
        }),
      );
      const procLate = await processWebhookEventById(refundEvtId);
      expect(procLate.detail).toBe("refund_initiated");

      expect(refundCalls).toHaveLength(1);
      expect(refundCalls[0]).toEqual({
        paymentId: latePayId,
        amount: chkB.amountPaise,
      });
      expect(
        emailCalls.some((m) => m.subject.includes("Test Refund Initiated")),
      ).toBe(true);

      const refundedPay = await Payment.findOne({
        reservationId: chkB.reservationId,
      }).lean<{ status: string; refundId?: string }>();
      expect(refundedPay!.status).toBe("refund_pending");
      expect(refundedPay!.refundId).toMatch(/^rfnd_mock_/);

      const refundAudit = await AuditLog.findOne({
        investmentId: `payref_${chkB.reservationId}`,
      }).lean();
      expect(refundAudit).not.toBeNull();
      expect(refundAudit!.eventType).toBe("PAYMENT_REFUNDED");

      // refund.processed webhook moves refund_pending -> refunded
      const refDoneEvtId = `evt_ref_done_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(refDoneEvtId);
      const refDoneRaw = JSON.stringify({
        event: "refund.processed",
        payload: {
          refund: {
            entity: {
              id: refundedPay!.refundId,
              payment_id: latePayId,
              amount: chkB.amountPaise,
            },
          },
        },
      });
      await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              refDoneRaw,
              TEST_WEBHOOK_SECRET,
            ),
            "x-razorpay-event-id": refDoneEvtId,
          },
          body: refDoneRaw,
        }),
      );
      await processWebhookEventById(refDoneEvtId);
      expect(
        (await Payment.findOne({ reservationId: chkB.reservationId }).lean())!
          .status,
      ).toBe("refunded");
    });
  });

  describe("Part 4: Mongo DLQ, Admin Replay/Discard, Schedulers, Auth & 503 Guard", () => {
    it("creates Mongo DeadLetter on exhausted attempts, preserves it in nightly-cleanup, and supports atomic Admin replay & discard", async () => {
      const suffix = crypto.randomBytes(4).toString("hex");
      const notExhausted = await recordPaymentsDeadLetter(
        {
          id: `job_early_${suffix}`,
          name: "process-webhook",
          data: { eventId: "evt_early" },
          attemptsMade: 2,
          opts: { attempts: 5 },
        },
        new Error("Transient error"),
      );
      expect(notExhausted).toBe(false);

      const paymentsQueue = getPaymentsQueue();
      const origJobId = `webhook_dlq_${suffix}`;
      await paymentsQueue.add(
        "process-webhook",
        { eventId: `evt_dlq_${suffix}`, webhookSecret: "must_strip" },
        { jobId: origJobId, removeOnFail: false },
      );

      const recorded = await recordPaymentsDeadLetter(
        {
          id: origJobId,
          name: "process-webhook",
          data: { eventId: `evt_dlq_${suffix}`, webhookSecret: "must_strip" },
          attemptsMade: 5,
          opts: { attempts: 5 },
        },
        new Error("Permanent failure after 5 attempts"),
      );
      expect(recorded).toBe(true);
      expect(
        emailCalls.some((e) => e.subject.includes("[DLQ Alert]")),
      ).toBe(true);

      const dlDoc = await DeadLetter.findOne({
        queue: "payments",
        jobId: origJobId,
      }).lean<{
        _id: mongoose.Types.ObjectId;
        status: string;
        data: Record<string, unknown>;
      }>();
      expect(dlDoc).not.toBeNull();
      expect(dlDoc!.status).toBe("open");
      expect(dlDoc!.data.webhookSecret).toBeUndefined();
      const dlId = dlDoc!._id.toString();
      createdDeadLetterIds.push(dlId);

      // nightly-cleanup MUST NOT delete Mongo DeadLetter documents
      await processScheduledJob(
        { name: "nightly-cleanup", data: {} } as unknown as Job,
        getScheduledQueue(),
        [paymentsQueue, getScheduledQueue()],
      );
      expect(await DeadLetter.findById(dlId).lean()).not.toBeNull();

      // Non-admin rejected
      const nonAdminGet = await runWithToken(investorToken, () =>
        deadLettersGet(),
      );
      expect(nonAdminGet.status).toBe(403);

      // Admin lists open dead letters
      const adminListRes = await runWithToken(adminToken, () =>
        deadLettersGet(),
      );
      expect(adminListRes.status).toBe(200);
      const listJson = (await adminListRes.json()) as {
        deadLetters: Array<{ _id: string }>;
      };
      expect(listJson.deadLetters.some((d) => d._id === dlId)).toBe(true);

      // Two parallel replays -> exactly one 200 and one 409
      const [repA, repB] = await Promise.all([
        runWithToken(adminToken, () =>
          deadLetterReplayPost(
            new Request(`http://localhost/api/admin/dead-letters/${dlId}/replay`, {
              method: "POST",
            }),
            { params: Promise.resolve({ id: dlId }) },
          ),
        ),
        runWithToken(adminToken, () =>
          deadLetterReplayPost(
            new Request(`http://localhost/api/admin/dead-letters/${dlId}/replay`, {
              method: "POST",
            }),
            { params: Promise.resolve({ id: dlId }) },
          ),
        ),
      ]);
      const statuses = [repA.status, repB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const winRes = repA.status === 200 ? repA : repB;
      const winJson = (await winRes.json()) as {
        replayed: boolean;
        replayJobId: string;
      };
      expect(winJson.replayed).toBe(true);
      expect(winJson.replayJobId).not.toContain(":");
      expect(await paymentsQueue.getJob(origJobId)).toBeUndefined();
      expect(await paymentsQueue.getJob(winJson.replayJobId)).toBeDefined();

      const updatedDl = await DeadLetter.findById(dlId).lean<{
        status: string;
        replayJobId?: string;
      }>();
      expect(updatedDl!.status).toBe("replayed");
      expect(updatedDl!.replayJobId).toBe(winJson.replayJobId);

      const dlAudit = await AuditLog.findOne({
        eventType: "DEAD_LETTER_REPLAYED",
        "metadata.deadLetterId": dlId,
      }).lean<{ investmentId: string } | null>();
      expect(dlAudit).not.toBeNull();
      createdExtraAuditIds.push(dlAudit!.investmentId);

      // Discard workflow on second dead letter
      const dl2 = await DeadLetter.create({
        queue: "payments",
        jobName: "release-reservation",
        jobId: `rel_discard_${suffix}`,
        data: { reservationId: "res_x" },
        error: "Sample permanent error",
        status: "open",
      });
      const dl2Id = dl2._id.toString();
      createdDeadLetterIds.push(dl2Id);

      const discardRes = await runWithToken(adminToken, () =>
        deadLetterDiscardPost(
          new Request(
            `http://localhost/api/admin/dead-letters/${dl2Id}/discard`,
            { method: "POST" },
          ),
          { params: Promise.resolve({ id: dl2Id }) },
        ),
      );
      expect(discardRes.status).toBe(200);
      expect((await DeadLetter.findById(dl2Id).lean())!.status).toBe(
        "discarded",
      );
    });

    it("enforces ownership, role auth, checkout rate limiting, scheduler idempotency, and strict 503 test-key guard across payment routes", async () => {
      const proj = await createTestProject();
      const projId = proj._id.toString();

      // Unauth & Developer forbidden on /checkout
      expect(
        (
          await runWithToken(undefined, () =>
            checkoutPost(
              new Request(`http://localhost/api/projects/${projId}/checkout`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Idempotency-Key": "k1" },
                body: JSON.stringify({ amount: 100_000 }),
              }),
              { params: Promise.resolve({ id: projId }) },
            ),
          )
        ).status,
      ).toBe(401);

      expect(
        (
          await runWithToken(devToken, () =>
            checkoutPost(
              new Request(`http://localhost/api/projects/${projId}/checkout`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Idempotency-Key": "k2" },
                body: JSON.stringify({ amount: 100_000 }),
              }),
              { params: Promise.resolve({ id: projId }) },
            ),
          )
        ).status,
      ).toBe(403);

      // Create reservation to test status polling ownership
      const resChk = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `own-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projId }) },
        ),
      );
      const { reservationId, orderId } = (await resChk.json()) as {
        reservationId: string;
        orderId: string;
      };

      expect(
        (
          await runWithToken(otherInvestorToken, () =>
            paymentStatusGet(
              new Request(`http://localhost/api/payments/${reservationId}/status`),
              { params: Promise.resolve({ reservationId }) },
            ),
          )
        ).status,
      ).toBe(403);

      const statusOwner = await runWithToken(investorToken, () =>
        paymentStatusGet(
          new Request(`http://localhost/api/payments/${reservationId}/status`),
          { params: Promise.resolve({ reservationId }) },
        ),
      );
      expect(statusOwner.status).toBe(200);
      expect(((await statusOwner.json()) as { orderId: string }).orderId).toBe(
        orderId,
      );

      // Rate limit on /checkout (> 10 requests in 60s -> 429)
      let hit429 = false;
      for (let i = 0; i < 11; i++) {
        const rlRes = await runWithToken(investorToken, () =>
          checkoutPost(
            new Request(`http://localhost/api/projects/${projId}/checkout`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": `rl-${i}-${crypto.randomBytes(2).toString("hex")}`,
              },
              body: JSON.stringify({ amount: 100_000 }),
            }),
            { params: Promise.resolve({ id: projId }) },
          ),
        );
        if (rlRes.status === 429) {
          hit429 = true;
          break;
        }
      }
      expect(hit429).toBe(true);

      // Scheduler idempotency including payments-reaper-scheduler
      const schedQueue = getScheduledQueue();
      await registerScheduledJobs(schedQueue);
      await registerScheduledJobs(schedQueue);
      const schedIds = (await schedQueue.getJobSchedulers())
        .map((s) => s.key || s.id)
        .sort();
      expect(schedIds).toEqual([
        "daily-digest-scheduler",
        "nightly-cleanup-scheduler",
        "payments-reaper-scheduler",
        "weekly-stats-scheduler",
      ]);

      // Strict lazy Razorpay guard -> 503 on ALL payment routes when missing or rzp_live_
      await clearTestRedisKeys();
      setRazorpayClientForTest(null);

      for (const badKey of ["", "rzp_live_1234567890"]) {
        if (badKey === "") {
          delete process.env.RAZORPAY_KEY_ID;
        } else {
          process.env.RAZORPAY_KEY_ID = badKey;
        }

        const rChk503 = await runWithToken(otherInvestorToken, () =>
          checkoutPost(
            new Request(`http://localhost/api/projects/${projId}/checkout`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": `guard-${badKey || "empty"}`,
              },
              body: JSON.stringify({ amount: 100_000 }),
            }),
            { params: Promise.resolve({ id: projId }) },
          ),
        );
        expect(rChk503.status).toBe(503);

        const rVer503 = await runWithToken(investorToken, () =>
          paymentsVerifyPost(
            new Request("http://localhost/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orderId,
                paymentId: "pay_1",
                signature: "sig_1",
              }),
            }),
          ),
        );
        expect(rVer503.status).toBe(503);

        const rStat503 = await runWithToken(investorToken, () =>
          paymentStatusGet(
            new Request(`http://localhost/api/payments/${reservationId}/status`),
            { params: Promise.resolve({ reservationId }) },
          ),
        );
        expect(rStat503.status).toBe(503);

        const rWh503 = await webhooksPost(
          new Request("http://localhost/api/webhooks/razorpay", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-razorpay-signature": "sig",
              "x-razorpay-event-id": "evt_guard",
            },
            body: "{}",
          }),
        );
        expect(rWh503.status).toBe(503);
      }
    });
  });

  describe("Part 5: Capture Safety & Integrity Verification", () => {
    it("passes auto-capture on order creation, waits on authorized-only verify until captured, rejects order.paid without capture, enforces integrity checks, and handles releaseReservation capture rules", async () => {
      // Case A: Order creation passes automatic capture settings + authorized-only /verify waits
      const projAId = await createTestProject();
      const resA = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projAId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `cap-auto-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projAId }) },
        ),
      );
      expect(resA.status).toBe(200);
      const chkA = (await resA.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const lastOrderCreate = orderCreateCalls.at(-1);
      expect(lastOrderCreate?.payment).toEqual({
        capture: "automatic",
        capture_options: {
          automatic_expiry_period: 12,
          manual_expiry_period: 7200,
          refund_speed: "optimum",
        },
      });

      const payAuthId = `pay_auth_only_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(payAuthId, {
        id: payAuthId,
        order_id: chkA.orderId,
        status: "authorized",
        amount: chkA.amountPaise,
        currency: "INR",
      });

      const verifyRes = await runWithToken(investorToken, () =>
        paymentsVerifyPost(
          new Request("http://localhost/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: chkA.orderId,
              paymentId: payAuthId,
              signature: signCheckoutPayload(chkA.orderId, payAuthId, TEST_KEY_SECRET),
            }),
          }),
        ),
      );
      expect(verifyRes.status).toBe(200);

      // Run the /verify-triggered finalize-payment job while payment is still only authorized
      const verifyJobResult = await processPaymentsJob({
        name: "finalize-payment",
        data: {
          reservationId: chkA.reservationId,
          orderId: chkA.orderId,
          paymentId: payAuthId,
          source: "verify",
        },
      } as Job);
      expect((verifyJobResult as { status: string }).status).toBe("awaiting_capture");

      const projAfterVerify = await Project.findById(projAId).lean();
      expect(projAfterVerify?.currentFunding).toBe(0);
      expect(projAfterVerify?.reservedFunding).toBe(100_000);
      expect(projAfterVerify?.reservations?.length).toBe(1);

      const payAfterVerify = await Payment.findOne({
        reservationId: chkA.reservationId,
      }).lean();
      expect(payAfterVerify?.status).toBe("authorized");

      // Later Razorpay transitions payment to captured and delivers payment.captured webhook -> commits once
      mockPaymentOverrides.set(payAuthId, {
        id: payAuthId,
        order_id: chkA.orderId,
        status: "captured",
        amount: chkA.amountPaise,
        currency: "INR",
      });

      const capEvtId = `evt_auth_then_cap_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(capEvtId);
      const capBody = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: payAuthId,
              order_id: chkA.orderId,
              amount: chkA.amountPaise,
              currency: "INR",
            },
          },
        },
      });
      const capWhRes = await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(capBody, TEST_WEBHOOK_SECRET),
            "x-razorpay-event-id": capEvtId,
          },
          body: capBody,
        }),
      );
      expect(capWhRes.status).toBe(200);
      await processPaymentsJob({
        name: "process-webhook",
        data: { eventId: capEvtId },
      } as Job);

      const projAfterCap = await Project.findById(projAId).lean();
      expect(projAfterCap?.currentFunding).toBe(100_000);
      expect(projAfterCap?.reservedFunding).toBe(0);
      expect(projAfterCap?.investors.length).toBe(1);
      const payAfterCap = await Payment.findOne({
        reservationId: chkA.reservationId,
      }).lean();
      expect(payAfterCap?.status).toBe("captured");

      // Case B: order.paid webhook without a captured payment on the order does NOT commit
      const projBId = await createTestProject();
      const resB = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projBId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `order-paid-nocap-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projBId }) },
        ),
      );
      const chkB = (await resB.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const authOrderPayId = `pay_ord_auth_${crypto.randomBytes(3).toString("hex")}`;
      mockOrderOverrides.set(chkB.orderId, {
        status: "paid",
        amount: chkB.amountPaise,
        items: [
          {
            id: authOrderPayId,
            order_id: chkB.orderId,
            status: "authorized",
            amount: chkB.amountPaise,
            currency: "INR",
          },
        ],
      });
      mockPaymentOverrides.set(authOrderPayId, {
        id: authOrderPayId,
        order_id: chkB.orderId,
        status: "authorized",
        amount: chkB.amountPaise,
        currency: "INR",
      });

      const orderPaidNoCapEvt = `evt_ord_nocap_${crypto.randomBytes(4).toString("hex")}`;
      createdWebhookEventIds.push(orderPaidNoCapEvt);
      const orderPaidNoCapBody = JSON.stringify({
        event: "order.paid",
        payload: {
          order: { entity: { id: chkB.orderId, amount: chkB.amountPaise, currency: "INR" } },
        },
      });
      await webhooksPost(
        new Request("http://localhost/api/webhooks/razorpay", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-razorpay-signature": signWebhookBody(
              orderPaidNoCapBody,
              TEST_WEBHOOK_SECRET,
            ),
            "x-razorpay-event-id": orderPaidNoCapEvt,
          },
          body: orderPaidNoCapBody,
        }),
      );
      const whOrderNoCapRes = (await processPaymentsJob({
        name: "process-webhook",
        data: { eventId: orderPaidNoCapEvt },
      } as Job)) as { detail?: string };
      expect(whOrderNoCapRes.detail).toBe("awaiting_capture");

      const projBAfterOrderPaid = await Project.findById(projBId).lean();
      expect(projBAfterOrderPaid?.currentFunding).toBe(0);
      expect(projBAfterOrderPaid?.reservedFunding).toBe(100_000);

      // Case C: Integrity mismatches (amount mismatch captured, amount mismatch authorized, currency mismatch, order_id mismatch)
      // C1: Amount mismatch on captured payment -> no commit, AuditLog, Payment failed, single idempotent refund
      const projAmtId = await createTestProject();
      const resAmt = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projAmtId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `int-amt-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projAmtId }) },
        ),
      );
      const chkAmt = (await resAmt.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payAmtId = `pay_int_amt_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(payAmtId, {
        id: payAmtId,
        order_id: chkAmt.orderId,
        status: "captured",
        amount: chkAmt.amountPaise - 5_000,
        currency: "INR",
      });
      const rAmt1 = await finalizePayment({
        reservationId: chkAmt.reservationId,
        orderId: chkAmt.orderId,
        paymentId: payAmtId,
        source: "webhook_payment_captured",
      });
      const rAmt2 = await finalizePayment({
        reservationId: chkAmt.reservationId,
        orderId: chkAmt.orderId,
        paymentId: payAmtId,
        source: "webhook_payment_captured",
      });
      expect(rAmt1.status).toBe("integrity_failed");
      expect(rAmt2.status).toBe("integrity_failed");
      expect(refundCalls.filter((c) => c.paymentId === payAmtId).length).toBe(1);
      expect((await Project.findById(projAmtId).lean())?.currentFunding).toBe(0);
      expect((await Project.findById(projAmtId).lean())?.reservedFunding).toBe(0);
      const payAmtDoc = await Payment.findOne({ reservationId: chkAmt.reservationId }).lean();
      expect(payAmtDoc?.status).toBe("failed");
      expect(payAmtDoc?.lastError).toMatch(/payment\.amount mismatch/);
      const amtAudit = await AuditLog.findOne({
        investmentId: `payint_${chkAmt.reservationId}`,
        eventType: "PAYMENT_INTEGRITY_FAILED",
      }).lean();
      expect(amtAudit).not.toBeNull();
      if (amtAudit?._id) createdExtraAuditIds.push(amtAudit._id.toString());

      // C2: Amount mismatch while only authorized -> fails integrity with 0 refunds
      const projAmtAuthId = await createTestProject();
      const resAmtAuth = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projAmtAuthId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `int-amt-auth-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projAmtAuthId }) },
        ),
      );
      const chkAmtAuth = (await resAmtAuth.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payAmtAuthId = `pay_int_amt_auth_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(payAmtAuthId, {
        id: payAmtAuthId,
        order_id: chkAmtAuth.orderId,
        status: "authorized",
        amount: chkAmtAuth.amountPaise - 100,
        currency: "INR",
      });
      const rAmtAuth = await finalizePayment({
        reservationId: chkAmtAuth.reservationId,
        orderId: chkAmtAuth.orderId,
        paymentId: payAmtAuthId,
        source: "verify",
      });
      expect(rAmtAuth.status).toBe("integrity_failed");
      expect(refundCalls.filter((c) => c.paymentId === payAmtAuthId).length).toBe(0);
      const amtAuthAudit = await AuditLog.findOne({
        investmentId: `payint_${chkAmtAuth.reservationId}`,
        eventType: "PAYMENT_INTEGRITY_FAILED",
      }).lean();
      expect(amtAuthAudit).not.toBeNull();
      if (amtAuthAudit?._id) createdExtraAuditIds.push(amtAuthAudit._id.toString());

      // C3: Currency mismatch ("USD") on captured payment -> no commit, AuditLog, Payment failed, refund once
      const projCurId = await createTestProject();
      const resCur = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projCurId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `int-cur-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projCurId }) },
        ),
      );
      const chkCur = (await resCur.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payCurId = `pay_int_cur_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(payCurId, {
        id: payCurId,
        order_id: chkCur.orderId,
        status: "captured",
        amount: chkCur.amountPaise,
        currency: "USD",
      });
      const rCur = await finalizePayment({
        reservationId: chkCur.reservationId,
        orderId: chkCur.orderId,
        paymentId: payCurId,
        source: "webhook_payment_captured",
      });
      expect(rCur.status).toBe("integrity_failed");
      expect(refundCalls.filter((c) => c.paymentId === payCurId).length).toBe(1);
      expect((await Project.findById(projCurId).lean())?.currentFunding).toBe(0);
      expect(
        (await Payment.findOne({ reservationId: chkCur.reservationId }).lean())?.status,
      ).toBe("failed");
      const curAudit = await AuditLog.findOne({
        investmentId: `payint_${chkCur.reservationId}`,
        eventType: "PAYMENT_INTEGRITY_FAILED",
      }).lean();
      expect(curAudit).not.toBeNull();
      if (curAudit?._id) createdExtraAuditIds.push(curAudit._id.toString());

      // C4: order_id mismatch on captured payment -> no commit, AuditLog, Payment failed, refund once
      const projOrdId = await createTestProject();
      const resOrd = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projOrdId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `int-ord-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projOrdId }) },
        ),
      );
      const chkOrd = (await resOrd.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payOrdId = `pay_int_ord_${crypto.randomBytes(3).toString("hex")}`;
      mockPaymentOverrides.set(payOrdId, {
        id: payOrdId,
        order_id: "order_mismatch_other",
        status: "captured",
        amount: chkOrd.amountPaise,
        currency: "INR",
      });
      const rOrd = await finalizePayment({
        reservationId: chkOrd.reservationId,
        orderId: chkOrd.orderId,
        paymentId: payOrdId,
        source: "webhook_payment_captured",
      });
      expect(rOrd.status).toBe("integrity_failed");
      expect(refundCalls.filter((c) => c.paymentId === payOrdId).length).toBe(1);
      expect((await Project.findById(projOrdId).lean())?.currentFunding).toBe(0);
      expect(
        (await Payment.findOne({ reservationId: chkOrd.reservationId }).lean())?.status,
      ).toBe("failed");
      const ordAudit = await AuditLog.findOne({
        investmentId: `payint_${chkOrd.reservationId}`,
        eventType: "PAYMENT_INTEGRITY_FAILED",
      }).lean();
      expect(ordAudit).not.toBeNull();
      if (ordAudit?._id) createdExtraAuditIds.push(ordAudit._id.toString());

      // Case D: releaseReservation on paid order finalizes; on authorized-only order keeps capacity before expiry and releases cleanly after expiry
      const projRelId = await createTestProject();
      const resRelPaid = await runWithToken(investorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projRelId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `rel-paid-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projRelId }) },
        ),
      );
      const chkRelPaid = (await resRelPaid.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payRelPaidId = `pay_rel_paid_${crypto.randomBytes(3).toString("hex")}`;
      mockOrderOverrides.set(chkRelPaid.orderId, {
        status: "paid",
        amount: chkRelPaid.amountPaise,
        items: [
          {
            id: payRelPaidId,
            order_id: chkRelPaid.orderId,
            status: "captured",
            amount: chkRelPaid.amountPaise,
            currency: "INR",
          },
        ],
      });
      mockPaymentOverrides.set(payRelPaidId, {
        id: payRelPaidId,
        order_id: chkRelPaid.orderId,
        status: "captured",
        amount: chkRelPaid.amountPaise,
        currency: "INR",
      });
      const relPaidOutcome = await releaseReservation({
        projectId: projRelId,
        reservationId: chkRelPaid.reservationId,
        orderId: chkRelPaid.orderId,
      });
      expect(relPaidOutcome.action).toBe("finalized_instead");

      const resRelAuth = await runWithToken(otherInvestorToken, () =>
        checkoutPost(
          new Request(`http://localhost/api/projects/${projRelId}/checkout`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `rel-auth-${crypto.randomBytes(4).toString("hex")}`,
            },
            body: JSON.stringify({ amount: 100_000 }),
          }),
          { params: Promise.resolve({ id: projRelId }) },
        ),
      );
      const chkRelAuth = (await resRelAuth.json()) as {
        orderId: string;
        reservationId: string;
        amountPaise: number;
      };
      const payRelAuthId = `pay_rel_auth_${crypto.randomBytes(3).toString("hex")}`;
      mockOrderOverrides.set(chkRelAuth.orderId, {
        status: "attempted",
        amount: chkRelAuth.amountPaise,
        items: [
          {
            id: payRelAuthId,
            order_id: chkRelAuth.orderId,
            status: "authorized",
            amount: chkRelAuth.amountPaise,
            currency: "INR",
          },
        ],
      });
      mockPaymentOverrides.set(payRelAuthId, {
        id: payRelAuthId,
        order_id: chkRelAuth.orderId,
        status: "authorized",
        amount: chkRelAuth.amountPaise,
        currency: "INR",
      });

      const relBeforeExpiry = await releaseReservation({
        projectId: projRelId,
        reservationId: chkRelAuth.reservationId,
        orderId: chkRelAuth.orderId,
      });
      expect(relBeforeExpiry).toEqual({ action: "noop", reason: "awaiting_capture" });

      const projBeforeExpiry = await Project.findById(projRelId).lean();
      expect(projBeforeExpiry?.currentFunding).toBe(100_000);
      expect(projBeforeExpiry?.reservedFunding).toBe(100_000);

      // Advance reservation + payment expiry into the past -> releaseReservation releases capacity cleanly once
      const past = new Date(Date.now() - 60_000);
      await Project.updateOne(
        { _id: projRelId, "reservations.reservationId": chkRelAuth.reservationId },
        { $set: { "reservations.$.expiresAt": past } },
      );
      await Payment.updateOne(
        { reservationId: chkRelAuth.reservationId },
        { $set: { expiresAt: past } },
      );

      const relAfterExpiry = await releaseReservation({
        projectId: projRelId,
        reservationId: chkRelAuth.reservationId,
        orderId: chkRelAuth.orderId,
      });
      expect(relAfterExpiry).toEqual({ action: "released" });

      const projAfterExpiry = await Project.findById(projRelId).lean();
      expect(projAfterExpiry?.currentFunding).toBe(100_000);
      expect(projAfterExpiry?.reservedFunding).toBe(0);
      expect(
        (await Payment.findOne({ reservationId: chkRelAuth.reservationId }).lean())?.status,
      ).toBe("expired");
    });
  });
});
