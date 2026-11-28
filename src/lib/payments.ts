import mongoose from "mongoose";
import type { Job, Queue } from "bullmq";
import dbConnect from "./db";
import { invalidateMarketplaceCache } from "./cache";
import { sendAppEmail } from "./email";
import {
  PAYMENTS_QUEUE,
  cancelLifecycleJobs,
  enqueueInvestmentFlow,
} from "./queue";
import {
  type RazorpayClientLike,
  type RazorpayOrderSummary,
  type RazorpayPaymentEntity,
  getRazorpayClient,
  sanitizeJobIdSegment,
} from "./razorpay";
import { publishFundingUpdate } from "./redis";
import { recordTrendingEvent } from "./trending";
import AuditLog from "../models/AuditLog";
import DeadLetter from "../models/DeadLetter";
import Payment, {
  PAYMENT_STATUSES,
  type PaymentStatus,
} from "../models/Payment";
import Project from "../models/Project";
import User from "../models/User";
import WebhookEvent from "../models/WebhookEvent";

export const ALLOWED_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> =
  {
    created: ["authorized", "captured", "failed", "expired"],
    authorized: ["captured", "failed", "expired"],
    failed: ["authorized", "captured", "expired"],
    expired: ["captured", "failed", "refund_pending"],
    captured: ["refund_pending", "refunded"],
    refund_pending: ["refunded"],
    refunded: [],
  };

export interface ProjectReservationRecord {
  reservationId: string;
  userId: mongoose.Types.ObjectId | string;
  amount: number;
  idempotencyKey: string;
  razorpayOrderId?: string;
  status: "pending";
  expiresAt: Date;
  createdAt?: Date;
}

interface LeanProjectWithReservations {
  _id: mongoose.Types.ObjectId;
  title: string;
  status: string;
  currentFunding: number;
  reservedFunding?: number;
  totalValuation: number;
  minInvestment: number;
  developerName?:
    | mongoose.Types.ObjectId
    | { _id?: mongoose.Types.ObjectId; name?: string; email?: string };
  reservations?: ProjectReservationRecord[];
  investors?: Array<{
    _id?: mongoose.Types.ObjectId;
    userId?: mongoose.Types.ObjectId | string;
    amount: number;
    idempotencyKey?: string;
  }>;
}

interface LeanPaymentDoc {
  _id: mongoose.Types.ObjectId;
  reservationId: string;
  orderId: string;
  paymentId?: string;
  idempotencyKey?: string;
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  refundId?: string;
  lastError?: string;
  expiresAt?: Date;
}

function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

/**
 * Transitions Payment status strictly according to ALLOWED_PAYMENT_TRANSITIONS.
 * Returns updated lean Payment on valid move; logs and ignores invalid transitions.
 */
export async function transitionPaymentStatus(input: {
  reservationId?: string;
  orderId?: string;
  to: PaymentStatus;
  setFields?: Record<string, unknown>;
  logContext?: string;
}): Promise<LeanPaymentDoc | null> {
  const selector = input.reservationId
    ? { reservationId: input.reservationId }
    : input.orderId
      ? { orderId: input.orderId }
      : null;

  if (!selector) {
    return null;
  }

  const allowedFrom = PAYMENT_STATUSES.filter((fromStatus) =>
    ALLOWED_PAYMENT_TRANSITIONS[fromStatus].includes(input.to),
  );

  if (allowedFrom.length === 0) {
    console.warn(
      `[Payment State WARNING] No source state permits transition to "${input.to}" (${input.logContext || "unknown"}).`,
    );
    return null;
  }

  const updated = await Payment.findOneAndUpdate(
    {
      ...selector,
      status: { $in: allowedFrom },
    },
    {
      $set: {
        ...(input.setFields || {}),
        status: input.to,
      },
    },
    { returnDocument: "after" },
  ).lean<LeanPaymentDoc | null>();

  if (!updated) {
    const existing = await Payment.findOne(selector)
      .select("status reservationId orderId")
      .lean<{ status: PaymentStatus; reservationId: string; orderId: string } | null>();

    if (existing && existing.status !== input.to) {
      console.warn(
        `[Payment State WARNING] Ignored disallowed transition ${existing.status} -> ${input.to} for reservation=${existing.reservationId} order=${existing.orderId} (${input.logContext || "transitionPaymentStatus"})`,
      );
    }
    return null;
  }

  return updated;
}

/**
 * Atomically releases any reservations whose `expiresAt <= now` on a single project
 * using an aggregation pipeline update so `reservedFunding` never drifts or goes negative.
 */
export async function releaseExpiredReservationsForProject(
  projectId: string,
  options?: { syncPaymentStatus?: boolean },
): Promise<ProjectReservationRecord[]> {
  const now = new Date();
  const before = await Project.findOneAndUpdate(
    {
      _id: projectId,
      "reservations.expiresAt": { $lte: now },
    },
    [
      {
        $set: {
          reservations: {
            $filter: {
              input: { $ifNull: ["$reservations", []] },
              as: "r",
              cond: { $gt: ["$$r.expiresAt", now] },
            },
          },
        },
      },
      {
        $set: {
          reservedFunding: {
            $sum: {
              $map: {
                input: "$reservations",
                as: "kept",
                in: "$$kept.amount",
              },
            },
          },
        },
      },
    ],
    { updatePipeline: true, returnDocument: "before" },
  ).lean<LeanProjectWithReservations | null>();

  if (!before?.reservations) {
    return [];
  }

  const removed = before.reservations.filter(
    (r) => new Date(r.expiresAt).getTime() <= now.getTime(),
  );

  if (options?.syncPaymentStatus !== false && removed.length > 0) {
    for (const r of removed) {
      await transitionPaymentStatus({
        reservationId: r.reservationId,
        to: "expired",
        logContext: "opportunistic_expiry",
      });
      await AuditLog.findOneAndUpdate(
        { investmentId: `resrel_${r.reservationId}` },
        {
          $setOnInsert: {
            investmentId: `resrel_${r.reservationId}`,
            eventType: "RESERVATION_RELEASED",
            projectId: before._id,
            userId: r.userId,
            amount: r.amount,
            idempotencyKey: r.idempotencyKey,
            ip: "system",
            metadata: {
              reason: "expired",
              orderId: r.razorpayOrderId,
              releasedAt: now.toISOString(),
            },
          },
        },
        { upsert: true },
      ).catch(() => {});
    }
  }

  return removed;
}

/**
 * Atomically removes a single reservationId from `Project.reservations[]`
 * and recomputes `reservedFunding` via aggregation pipeline update.
 */
export async function removeProjectReservationAtomic(
  projectId: string,
  reservationId: string,
): Promise<ProjectReservationRecord | null> {
  const before = await Project.findOneAndUpdate(
    {
      _id: projectId,
      "reservations.reservationId": reservationId,
    },
    [
      {
        $set: {
          reservations: {
            $filter: {
              input: { $ifNull: ["$reservations", []] },
              as: "r",
              cond: { $ne: ["$$r.reservationId", reservationId] },
            },
          },
        },
      },
      {
        $set: {
          reservedFunding: {
            $sum: {
              $map: {
                input: "$reservations",
                as: "kept",
                in: "$$kept.amount",
              },
            },
          },
        },
      },
    ],
    { updatePipeline: true, returnDocument: "before" },
  ).lean<LeanProjectWithReservations | null>();

  if (!before?.reservations) {
    return null;
  }

  return (
    before.reservations.find((r) => r.reservationId === reservationId) ?? null
  );
}

async function completeCommittedFinalize(input: {
  updatedProject: LeanProjectWithReservations;
  payment: LeanPaymentDoc;
  investmentId: string;
  amountRupees: number;
  committedAt: Date;
  effectivePaymentId?: string;
}): Promise<void> {
  const {
    updatedProject,
    payment,
    investmentId,
    amountRupees,
    committedAt,
    effectivePaymentId,
  } = input;
  const projectIdStr = updatedProject._id.toString();
  const userIdStr = payment.userId.toString();

  const becameFunded =
    updatedProject.currentFunding >= updatedProject.totalValuation;

  if (becameFunded && updatedProject.status === "Live") {
    await Project.updateOne(
      {
        _id: projectIdStr,
        status: "Live",
        currentFunding: { $gte: updatedProject.totalValuation },
      },
      { $set: { status: "Funded" } },
    );
    updatedProject.status = "Funded";
    if (process.env.REDIS_URL) {
      await cancelLifecycleJobs(projectIdStr).catch(() => {});
    }
  }

  await transitionPaymentStatus({
    reservationId: payment.reservationId,
    to: "captured",
    ...(effectivePaymentId ? { setFields: { paymentId: effectivePaymentId } } : {}),
    logContext: "finalize_commit",
  });

  await invalidateMarketplaceCache();

  await AuditLog.findOneAndUpdate(
    { investmentId: `paycap_${payment.reservationId}` },
    {
      $setOnInsert: {
        investmentId: `paycap_${payment.reservationId}`,
        eventType: "PAYMENT_CAPTURED",
        projectId: updatedProject._id,
        userId: payment.userId,
        amount: amountRupees,
        idempotencyKey: payment.reservationId,
        ip: "razorpay",
        metadata: {
          reservationId: payment.reservationId,
          orderId: payment.orderId,
          paymentId: effectivePaymentId,
          amountPaise: payment.amountPaise,
          projectTitle: updatedProject.title,
          committedAt: committedAt.toISOString(),
        },
      },
    },
    { upsert: true },
  );

  await recordTrendingEvent({
    type: "invest",
    projectId: projectIdStr,
    viewerKey: userIdStr,
  });

  const percentage = Math.min(
    (updatedProject.currentFunding / updatedProject.totalValuation) * 100,
    100,
  );

  if (process.env.REDIS_URL) {
    try {
      await publishFundingUpdate({
        projectId: projectIdStr,
        currentFunding: updatedProject.currentFunding,
        totalValuation: updatedProject.totalValuation,
        status: updatedProject.status,
        percentage,
      });
    } catch (pubErr) {
      console.error("[Payments SSE Publish Error]:", pubErr);
    }

    try {
      const [investor, devUser] = await Promise.all([
        User.findById(userIdStr).select("name email").lean<{ name?: string; email?: string } | null>(),
        typeof updatedProject.developerName === "object" &&
        updatedProject.developerName !== null &&
        "email" in updatedProject.developerName
          ? Promise.resolve(updatedProject.developerName)
          : User.findById(updatedProject.developerName).select("name email").lean<{ name?: string; email?: string } | null>(),
      ]);

      await enqueueInvestmentFlow({
        investmentId,
        projectId: projectIdStr,
        projectTitle: updatedProject.title,
        investorId: userIdStr,
        investorName: investor?.name || "Investor",
        investorEmail: investor?.email || "",
        developerName: devUser?.name || "Developer",
        developerEmail: devUser?.email,
        amount: amountRupees,
        currentFunding: updatedProject.currentFunding,
        totalValuation: updatedProject.totalValuation,
        becameFunded,
        idempotencyKey: payment.reservationId,
        ip: "razorpay-checkout",
        createdAt: committedAt.toISOString(),
      });
    } catch (queueErr) {
      console.error("[Payments Flow Enqueue Error]:", queueErr);
    }
  }
}

interface CaptureIntegrityCheckInput {
  payment: LeanPaymentDoc;
  fetchedPayment: RazorpayPaymentEntity | null;
  webhookOrderId?: string;
  webhookCurrency?: string;
  webhookAmountPaise?: number;
  expectedProjectId?: string;
  expectedUserId?: string;
  projectDoc: {
    _id: mongoose.Types.ObjectId;
    reservations?: ProjectReservationRecord[];
  } | null;
  userExists: boolean;
}

function collectCaptureIntegrityErrors(ctx: CaptureIntegrityCheckInput): string[] {
  const errors: string[] = [];
  const { payment, fetchedPayment, projectDoc, userExists } = ctx;

  if (!Number.isSafeInteger(payment.amountPaise) || payment.amountPaise < 100) {
    errors.push(`Invalid stored Payment.amountPaise (${String(payment.amountPaise)})`);
  }
  if (!projectDoc) {
    errors.push(`Project ${payment.projectId.toString()} does not exist`);
  }
  if (!userExists) {
    errors.push(`User ${payment.userId.toString()} does not exist`);
  }
  if (
    ctx.expectedProjectId &&
    ctx.expectedProjectId !== payment.projectId.toString()
  ) {
    errors.push(
      `Project mismatch: expected ${payment.projectId.toString()}, got ${ctx.expectedProjectId}`,
    );
  }
  if (ctx.expectedUserId && ctx.expectedUserId !== payment.userId.toString()) {
    errors.push(
      `User mismatch: expected ${payment.userId.toString()}, got ${ctx.expectedUserId}`,
    );
  }

  const matchedRes = projectDoc?.reservations?.find(
    (r) => r.reservationId === payment.reservationId,
  );
  if (matchedRes) {
    if (matchedRes.userId.toString() !== payment.userId.toString()) {
      errors.push(
        `Reservation user mismatch: reservation=${matchedRes.userId.toString()}, payment=${payment.userId.toString()}`,
      );
    }
    if (
      !Number.isSafeInteger(matchedRes.amount) ||
      matchedRes.amount * 100 !== payment.amountPaise
    ) {
      errors.push(
        `Reservation amount mismatch: reservationPaise=${matchedRes.amount * 100}, paymentPaise=${payment.amountPaise}`,
      );
    }
  }

  if (ctx.webhookOrderId && ctx.webhookOrderId !== payment.orderId) {
    errors.push(
      `Webhook order_id mismatch: expected ${payment.orderId}, got ${ctx.webhookOrderId}`,
    );
  }
  if (
    ctx.webhookCurrency !== undefined &&
    ctx.webhookCurrency.trim().toUpperCase() !== "INR"
  ) {
    errors.push(
      `Webhook currency mismatch: expected INR, got ${ctx.webhookCurrency}`,
    );
  }
  if (
    ctx.webhookAmountPaise !== undefined &&
    (!Number.isSafeInteger(ctx.webhookAmountPaise) ||
      ctx.webhookAmountPaise !== payment.amountPaise)
  ) {
    errors.push(
      `Webhook amount mismatch: expected ${payment.amountPaise}, got ${String(ctx.webhookAmountPaise)}`,
    );
  }

  if (fetchedPayment) {
    if (fetchedPayment.order_id !== payment.orderId) {
      errors.push(
        `Razorpay payment.order_id mismatch: expected ${payment.orderId}, got ${fetchedPayment.order_id}`,
      );
    }
    if ((fetchedPayment.currency || "").trim().toUpperCase() !== "INR") {
      errors.push(
        `Razorpay payment.currency mismatch: expected INR, got ${String(fetchedPayment.currency || "")}`,
      );
    }
    if (
      !Number.isSafeInteger(fetchedPayment.amount) ||
      fetchedPayment.amount !== payment.amountPaise
    ) {
      errors.push(
        `Razorpay payment.amount mismatch: expected ${payment.amountPaise}, got ${String(fetchedPayment.amount)}`,
      );
    }
  }

  return errors;
}

async function fetchAuthoritativePaymentState(input: {
  client: RazorpayClientLike;
  payment: LeanPaymentDoc;
  effectivePaymentId?: string;
  requireOrderPaid?: boolean;
}): Promise<{
  fetchedOrder: RazorpayOrderSummary | null;
  fetchedPayment: RazorpayPaymentEntity | null;
}> {
  const { client, payment, effectivePaymentId, requireOrderPaid } = input;
  let fetchedOrder: RazorpayOrderSummary | null = null;
  let fetchedPayment: RazorpayPaymentEntity | null = null;

  if (requireOrderPaid) {
    fetchedOrder = await client.orders.fetch(payment.orderId);
    const orderPayments = await client.orders.fetchPayments(payment.orderId);
    const items = orderPayments.items || [];
    const chosenItem =
      (effectivePaymentId
        ? items.find(
            (i) => i.id === effectivePaymentId && i.status === "captured",
          )
        : undefined) ||
      items.find((i) => i.status === "captured") ||
      (effectivePaymentId
        ? items.find((i) => i.id === effectivePaymentId)
        : undefined) ||
      items[0];

    if (chosenItem?.id) {
      fetchedPayment = await client.payments.fetch(chosenItem.id).catch(() => ({
        id: chosenItem.id,
        order_id: chosenItem.order_id || payment.orderId,
        status: chosenItem.status,
        amount: chosenItem.amount,
        currency: chosenItem.currency,
      }));
    } else if (effectivePaymentId) {
      fetchedPayment = await client.payments.fetch(effectivePaymentId);
    }

    return { fetchedOrder, fetchedPayment };
  }

  if (effectivePaymentId) {
    fetchedPayment = await client.payments.fetch(effectivePaymentId);
    return { fetchedOrder, fetchedPayment };
  }

  const orderPayments = await client.orders.fetchPayments(payment.orderId);
  const items = orderPayments.items || [];
  const chosenItem =
    items.find((i) => i.status === "captured") ||
    items.find((i) => i.status === "authorized") ||
    items[0];
  if (chosenItem?.id) {
    fetchedPayment = await client.payments.fetch(chosenItem.id).catch(() => ({
      id: chosenItem.id,
      order_id: chosenItem.order_id || payment.orderId,
      status: chosenItem.status,
      amount: chosenItem.amount,
      currency: chosenItem.currency,
    }));
  }

  return { fetchedOrder, fetchedPayment };
}

async function handleCaptureIntegrityFailure(input: {
  client: RazorpayClientLike;
  payment: LeanPaymentDoc;
  fetchedPayment: RazorpayPaymentEntity | null;
  effectivePaymentId?: string;
  reasons: string[];
  webhookOrderId?: string;
  webhookAmountPaise?: number;
  webhookCurrency?: string;
  source?: string;
  reservationBelongsToUser: boolean;
}): Promise<{
  status: "integrity_failed";
  refundId?: string;
  reservationId: string;
}> {
  const { payment, fetchedPayment, reasons, client } = input;
  const reservationId = payment.reservationId;
  const projectIdStr = payment.projectId.toString();
  const targetPaymentId = fetchedPayment?.id || input.effectivePaymentId;
  const lastError = `INTEGRITY: ${reasons.join("; ")}`.slice(0, 500);

  console.error(
    `[Payment INTEGRITY] Refusing commit for reservation=${reservationId} order=${payment.orderId}: ${reasons.join("; ")}`,
  );

  let refundId =
    payment.refundId && !payment.refundId.startsWith("claiming_")
      ? payment.refundId
      : undefined;

  if (fetchedPayment?.status === "captured" && targetPaymentId && !refundId) {
    const claimed = await Payment.findOneAndUpdate(
      {
        reservationId,
        $or: [
          { refundId: { $exists: false } },
          { refundId: null },
          { refundId: "" },
        ],
      },
      {
        $set: {
          status: "failed",
          lastError,
          paymentId: targetPaymentId,
          refundId: `claiming_${Date.now()}`,
        },
      },
      { returnDocument: "before" },
    );

    if (claimed) {
      try {
        const refundRes = await client.payments.refund(targetPaymentId, {
          ...(Number.isSafeInteger(fetchedPayment.amount) &&
          fetchedPayment.amount > 0
            ? { amount: fetchedPayment.amount }
            : {}),
          notes: {
            reservationId,
            projectId: projectIdStr,
            reason: "payment_integrity_mismatch",
          },
        });
        refundId = refundRes.id;
        await Payment.updateOne(
          { reservationId },
          {
            $set: {
              status: "failed",
              lastError,
              paymentId: targetPaymentId,
              refundId,
            },
          },
        );
      } catch (refundErr) {
        await Payment.updateOne(
          { reservationId, refundId: /^claiming_/ },
          { $unset: { refundId: "" } },
        );
        throw refundErr;
      }
    } else {
      const latest = await Payment.findOne({ reservationId })
        .select("refundId")
        .lean<{ refundId?: string } | null>();
      if (latest?.refundId && !latest.refundId.startsWith("claiming_")) {
        refundId = latest.refundId;
      }
    }
  } else {
    const transitioned = await transitionPaymentStatus({
      reservationId,
      to: "failed",
      setFields: {
        lastError,
        ...(targetPaymentId ? { paymentId: targetPaymentId } : {}),
      },
      logContext: "integrity_failure",
    });
    if (!transitioned) {
      await Payment.updateOne(
        { reservationId },
        {
          $set: {
            status: "failed",
            lastError,
            ...(targetPaymentId ? { paymentId: targetPaymentId } : {}),
          },
        },
      );
    }
  }

  if (input.reservationBelongsToUser) {
    await removeProjectReservationAtomic(projectIdStr, reservationId).catch(
      () => {},
    );
  }

  await AuditLog.findOneAndUpdate(
    { investmentId: `payint_${reservationId}` },
    {
      $setOnInsert: {
        investmentId: `payint_${reservationId}`,
        eventType: "PAYMENT_INTEGRITY_FAILED",
        projectId: payment.projectId,
        userId: payment.userId,
        amount: Number.isSafeInteger(payment.amountPaise)
          ? Math.round(payment.amountPaise / 100)
          : 0,
        idempotencyKey: reservationId,
        ip: "razorpay",
        metadata: {
          reasons,
          source: input.source,
          expectedOrderId: payment.orderId,
          actualOrderId: fetchedPayment?.order_id || input.webhookOrderId,
          expectedAmountPaise: payment.amountPaise,
          actualAmountPaise: fetchedPayment?.amount ?? input.webhookAmountPaise,
          expectedCurrency: "INR",
          actualCurrency: fetchedPayment?.currency || input.webhookCurrency,
          fetchedStatus: fetchedPayment?.status,
          paymentId: targetPaymentId,
          refundId,
        },
      },
    },
    { upsert: true },
  );

  return { status: "integrity_failed", refundId, reservationId };
}

/**
 * Idempotent payment finalizer shared across webhooks, /verify follow-up, and release-check recovery.
 * Verifies capture status & payment integrity directly against Razorpay before committing capacity,
 * or attempts late re-reservation / test refund after expiry.
 */
export async function finalizePayment(input: {
  reservationId?: string;
  orderId?: string;
  paymentId?: string;
  amountPaise?: number;
  currency?: string;
  webhookOrderId?: string;
  expectedProjectId?: string;
  expectedUserId?: string;
  requireOrderPaid?: boolean;
  source?:
    | "verify"
    | "webhook_payment_captured"
    | "webhook_order_paid"
    | "release_check";
}): Promise<{
  status:
    | "finalized"
    | "finalized_late"
    | "already_finalized"
    | "awaiting_capture"
    | "integrity_failed"
    | "refund_initiated"
    | "already_refunding"
    | "payment_not_found";
  investmentId?: string;
  refundId?: string;
  reservationId?: string;
}> {
  await dbConnect();

  const payment = input.reservationId
    ? await Payment.findOne({ reservationId: input.reservationId }).lean<LeanPaymentDoc | null>()
    : input.orderId
      ? await Payment.findOne({ orderId: input.orderId }).lean<LeanPaymentDoc | null>()
      : null;

  if (!payment) {
    return { status: "payment_not_found" };
  }

  const reservationId = payment.reservationId;
  const effectivePaymentId = input.paymentId || payment.paymentId;
  const amountRupees = Math.round(payment.amountPaise / 100);
  const projectIdStr = payment.projectId.toString();

  // Check if already committed previously (idempotent second run)
  const existingCommitted = await Project.findOne({
    _id: payment.projectId,
    investors: {
      $elemMatch: {
        userId: payment.userId,
        idempotencyKey: reservationId,
      },
    },
  })
    .select("status currentFunding totalValuation")
    .lean<LeanProjectWithReservations | null>();

  if (existingCommitted) {
    if (payment.status !== "captured") {
      await transitionPaymentStatus({
        reservationId,
        to: "captured",
        ...(effectivePaymentId ? { setFields: { paymentId: effectivePaymentId } } : {}),
        logContext: "already_finalized_recovery",
      });
    }
    if (
      existingCommitted.status === "Live" &&
      existingCommitted.currentFunding >= existingCommitted.totalValuation
    ) {
      await Project.updateOne(
        { _id: projectIdStr, status: "Live" },
        { $set: { status: "Funded" } },
      );
    }
    return { status: "already_finalized", reservationId };
  }

  if (
    payment.status === "failed" &&
    payment.lastError?.startsWith("INTEGRITY:") &&
    payment.refundId &&
    !payment.refundId.startsWith("claiming_")
  ) {
    return {
      status: "integrity_failed",
      refundId: payment.refundId,
      reservationId,
    };
  }

  if (payment.status === "refunded" || payment.status === "refund_pending") {
    if (payment.refundId) {
      return {
        status: "already_refunding",
        refundId: payment.refundId,
        reservationId,
      };
    }
  }

  const { client } = getRazorpayClient();
  const [{ fetchedOrder, fetchedPayment }, projectMeta, userExists] =
    await Promise.all([
      fetchAuthoritativePaymentState({
        client,
        payment,
        effectivePaymentId,
        requireOrderPaid: input.requireOrderPaid,
      }),
      Project.findById(payment.projectId)
        .select("_id reservations")
        .lean<{
          _id: mongoose.Types.ObjectId;
          reservations?: ProjectReservationRecord[];
        } | null>(),
      User.exists({ _id: payment.userId }).then(Boolean),
    ]);

  const integrityErrors = collectCaptureIntegrityErrors({
    payment,
    fetchedPayment,
    webhookOrderId: input.webhookOrderId,
    webhookCurrency: input.currency,
    webhookAmountPaise: input.amountPaise,
    expectedProjectId: input.expectedProjectId,
    expectedUserId: input.expectedUserId,
    projectDoc: projectMeta,
    userExists,
  });

  if (integrityErrors.length > 0) {
    const matchedRes = projectMeta?.reservations?.find(
      (r) => r.reservationId === reservationId,
    );
    return handleCaptureIntegrityFailure({
      client,
      payment,
      fetchedPayment,
      effectivePaymentId,
      reasons: integrityErrors,
      webhookOrderId: input.webhookOrderId,
      webhookAmountPaise: input.amountPaise,
      webhookCurrency: input.currency,
      source: input.source,
      reservationBelongsToUser: Boolean(
        matchedRes && matchedRes.userId.toString() === payment.userId.toString(),
      ),
    });
  }

  // Capture verification: NEVER commit unless Razorpay confirms captured (and paid order for order.paid)
  const orderSatisfied = !input.requireOrderPaid || fetchedOrder?.status === "paid";
  const paymentCaptured = fetchedPayment?.status === "captured";

  if (!orderSatisfied || !paymentCaptured) {
    if (fetchedPayment?.status === "authorized" && payment.status === "created") {
      await transitionPaymentStatus({
        reservationId,
        to: "authorized",
        setFields: { paymentId: fetchedPayment.id },
        logContext: "finalize_awaiting_capture",
      });
    }
    return { status: "awaiting_capture", reservationId };
  }

  const verifiedPaymentId = fetchedPayment.id || effectivePaymentId;

  const investmentObjectId = new mongoose.Types.ObjectId();
  const investmentId = investmentObjectId.toString();
  const committedAt = new Date();

  // 1. Primary path: consume pending reservation atomically
  const primaryProject = await Project.findOneAndUpdate(
    {
      _id: payment.projectId,
      "reservations.reservationId": reservationId,
      investors: {
        $not: {
          $elemMatch: {
            userId: payment.userId,
            idempotencyKey: reservationId,
          },
        },
      },
    },
    {
      $pull: { reservations: { reservationId } },
      $inc: {
        reservedFunding: -amountRupees,
        currentFunding: amountRupees,
      },
      $push: {
        investors: {
          _id: investmentObjectId,
          userId: payment.userId,
          amount: amountRupees,
          date: committedAt,
          idempotencyKey: reservationId,
        },
      },
    },
    { returnDocument: "after" },
  )
    .populate("developerName", "name email")
    .lean<LeanProjectWithReservations | null>();

  if (primaryProject) {
    await completeCommittedFinalize({
      updatedProject: primaryProject,
      payment,
      investmentId,
      amountRupees,
      committedAt,
      effectivePaymentId: verifiedPaymentId,
    });
    return { status: "finalized", investmentId, reservationId };
  }

  // Re-check concurrent finalize winner before entering late-payment fallback
  const raceWinner = await Project.findOne({
    _id: payment.projectId,
    investors: {
      $elemMatch: {
        userId: payment.userId,
        idempotencyKey: reservationId,
      },
    },
  })
    .select("_id")
    .lean();

  if (raceWinner) {
    await transitionPaymentStatus({
      reservationId,
      to: "captured",
      ...(verifiedPaymentId ? { setFields: { paymentId: verifiedPaymentId } } : {}),
      logContext: "concurrent_finalize_winner",
    });
    return { status: "already_finalized", reservationId };
  }

  // 2. Late payment path: reservation expired and was released. Try one fresh atomic commit.
  const lateCommitProject = await Project.findOneAndUpdate(
    {
      _id: payment.projectId,
      status: "Live",
      $expr: {
        $lte: [
          {
            $add: [
              { $ifNull: ["$currentFunding", 0] },
              { $ifNull: ["$reservedFunding", 0] },
              amountRupees,
            ],
          },
          "$totalValuation",
        ],
      },
      investors: {
        $not: {
          $elemMatch: {
            userId: payment.userId,
            idempotencyKey: reservationId,
          },
        },
      },
    },
    {
      $inc: { currentFunding: amountRupees },
      $push: {
        investors: {
          _id: investmentObjectId,
          userId: payment.userId,
          amount: amountRupees,
          date: committedAt,
          idempotencyKey: reservationId,
        },
      },
    },
    { returnDocument: "after" },
  )
    .populate("developerName", "name email")
    .lean<LeanProjectWithReservations | null>();

  if (lateCommitProject) {
    await completeCommittedFinalize({
      updatedProject: lateCommitProject,
      payment,
      investmentId,
      amountRupees,
      committedAt,
      effectivePaymentId: verifiedPaymentId,
    });
    return { status: "finalized_late", investmentId, reservationId };
  }

  // 3. Capacity is gone or project is no longer Live (including Expired) -> Refund test payment
  if (
    payment.status === "created" ||
    payment.status === "authorized" ||
    payment.status === "failed"
  ) {
    await transitionPaymentStatus({
      reservationId,
      to: "expired",
      ...(verifiedPaymentId ? { setFields: { paymentId: verifiedPaymentId } } : {}),
      logContext: "late_payment_before_refund",
    });
  }

  const latestPayment = await Payment.findOne({ reservationId }).lean<LeanPaymentDoc | null>();
  if (latestPayment?.refundId || latestPayment?.status === "refunded") {
    return {
      status: "already_refunding",
      refundId: latestPayment.refundId,
      reservationId,
    };
  }

  if (latestPayment?.status === "expired" || latestPayment?.status === "captured") {
    await transitionPaymentStatus({
      reservationId,
      to: "refund_pending",
      ...(verifiedPaymentId ? { setFields: { paymentId: verifiedPaymentId } } : {}),
      logContext: "late_payment_refund_start",
    });
  }

  const targetRefundPaymentId = verifiedPaymentId;
  if (!targetRefundPaymentId) {
    throw new Error(
      `Cannot initiate refund for reservation ${reservationId}: missing Razorpay paymentId.`,
    );
  }

  const refundResult = await client.payments.refund(targetRefundPaymentId, {
    amount: payment.amountPaise,
    notes: {
      reservationId,
      projectId: projectIdStr,
      reason: "late_payment_capacity_unavailable",
    },
  });

  await Payment.updateOne(
    { reservationId },
    {
      $set: {
        paymentId: targetRefundPaymentId,
        refundId: refundResult.id,
      },
    },
  );

  const [investor, proj] = await Promise.all([
    User.findById(payment.userId).select("name email").lean<{ name?: string; email?: string } | null>(),
    Project.findById(projectIdStr).select("title status").lean<{ title?: string; status?: string } | null>(),
  ]);

  if (investor?.email) {
    try {
      await sendAppEmail({
        to: investor.email,
        subject: `Test Refund Initiated: ${proj?.title || "Listing"}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Test-Mode Refund Initiated</h2>
            <p>Hello ${investor.name || "Investor"},</p>
            <p>Your payment for <strong>${proj?.title || "this opportunity"}</strong> arrived after your temporary reservation expired and capacity was no longer available.</p>
            <p>We initiated a simulated test-mode refund of <strong>${formatInr(amountRupees)}</strong> (Refund ID: <code>${refundResult.id}</code>).</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("[Late Payment Refund Email Error]:", emailErr);
    }
  }

  await AuditLog.findOneAndUpdate(
    { investmentId: `payref_${reservationId}` },
    {
      $setOnInsert: {
        investmentId: `payref_${reservationId}`,
        eventType: "PAYMENT_REFUNDED",
        projectId: payment.projectId,
        userId: payment.userId,
        amount: amountRupees,
        idempotencyKey: reservationId,
        ip: "razorpay",
        metadata: {
          reason: "late_payment_capacity_unavailable",
          projectStatus: proj?.status,
          orderId: payment.orderId,
          paymentId: targetRefundPaymentId,
          refundId: refundResult.id,
        },
      },
    },
    { upsert: true },
  );

  return {
    status: "refund_initiated",
    refundId: refundResult.id,
    reservationId,
  };
}

/**
 * Releases a pending reservation (delayed job or 5-minute reaper) after verifying at Razorpay
 * that the order has NOT been paid. Finalizes instead if Razorpay reports status === "paid".
 */
export async function releaseReservation(input: {
  projectId: string;
  reservationId: string;
  orderId?: string;
}): Promise<{
  action: "released" | "finalized_instead" | "noop";
  reason?: string;
}> {
  await dbConnect();

  const existingProject = await Project.findOne({
    _id: input.projectId,
    "reservations.reservationId": input.reservationId,
  })
    .select("reservations")
    .lean<{ reservations?: ProjectReservationRecord[] } | null>();

  const pendingReservation = existingProject?.reservations?.find(
    (r) => r.reservationId === input.reservationId,
  );

  if (!pendingReservation) {
    return { action: "noop", reason: "reservation_already_gone" };
  }

  const existingPayment = await Payment.findOne({
    reservationId: input.reservationId,
  }).lean<LeanPaymentDoc | null>();

  if (existingPayment?.status === "captured") {
    return { action: "noop", reason: "payment_already_captured" };
  }

  const effectiveOrderId =
    input.orderId || pendingReservation.razorpayOrderId || existingPayment?.orderId;

  if (effectiveOrderId) {
    const { client } = getRazorpayClient();
    const order = await client.orders.fetch(effectiveOrderId);
    const orderPayments = await client.orders.fetchPayments(effectiveOrderId);
    const items = orderPayments.items || [];
    const capturedItem = items.find((item) => item.status === "captured");
    const authorizedItem = items.find((item) => item.status === "authorized");

    if (order.status === "paid" && capturedItem) {
      const fin = await finalizePayment({
        reservationId: input.reservationId,
        orderId: effectiveOrderId,
        paymentId: capturedItem.id,
        amountPaise: capturedItem.amount,
        currency: capturedItem.currency,
        webhookOrderId: capturedItem.order_id,
        requireOrderPaid: true,
        source: "release_check",
      });
      if (
        fin.status === "finalized" ||
        fin.status === "finalized_late" ||
        fin.status === "already_finalized"
      ) {
        return { action: "finalized_instead", reason: "razorpay_order_paid" };
      }
      return { action: "noop", reason: fin.status };
    }

    const notYetExpired =
      new Date(pendingReservation.expiresAt).getTime() > Date.now();
    const isAuthorizedOnly =
      existingPayment?.status === "authorized" ||
      Boolean(authorizedItem) ||
      (order.status === "paid" && !capturedItem);

    if (isAuthorizedOnly && notYetExpired) {
      return { action: "noop", reason: "awaiting_capture" };
    }
  }

  const removed = await removeProjectReservationAtomic(
    input.projectId,
    input.reservationId,
  );
  if (!removed) {
    return { action: "noop", reason: "concurrent_removal" };
  }

  if (existingPayment) {
    await transitionPaymentStatus({
      reservationId: input.reservationId,
      to: "expired",
      logContext: "release_reservation",
    });
  }

  await AuditLog.findOneAndUpdate(
    { investmentId: `resrel_${input.reservationId}` },
    {
      $setOnInsert: {
        investmentId: `resrel_${input.reservationId}`,
        eventType: "RESERVATION_RELEASED",
        projectId: input.projectId,
        userId: removed.userId,
        amount: removed.amount,
        idempotencyKey: removed.idempotencyKey,
        ip: "worker",
        metadata: {
          reservationId: input.reservationId,
          orderId: effectiveOrderId,
          orphanWithoutPaymentDoc: !existingPayment,
          releasedAt: new Date().toISOString(),
        },
      },
    },
    { upsert: true },
  );

  return { action: "released" };
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        error_description?: string;
        notes?: Record<string, string>;
      };
    };
    order?: {
      entity?: {
        id?: string;
        receipt?: string;
        amount?: number;
        currency?: string;
        status?: string;
        notes?: Record<string, string>;
      };
    };
    refund?: {
      entity?: {
        id?: string;
        payment_id?: string;
        amount?: number;
        status?: string;
      };
    };
  };
}

/**
 * Worker handler for stored WebhookEvent documents inside the outbox.
 */
export async function processWebhookEventById(
  eventId: string,
): Promise<{ handled: boolean; event?: string; detail?: string }> {
  await dbConnect();

  const webhookDoc = await WebhookEvent.findOneAndUpdate(
    { eventId },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  ).lean<{
    eventId: string;
    event: string;
    payload: RazorpayWebhookPayload;
    processedAt?: Date | null;
  } | null>();

  if (!webhookDoc) {
    throw new Error(`WebhookEvent not found for eventId=${eventId}`);
  }
  if (webhookDoc.processedAt) {
    return { handled: true, event: webhookDoc.event, detail: "already_processed" };
  }

  const body = webhookDoc.payload || {};
  const paymentEntity = body.payload?.payment?.entity;
  const orderEntity = body.payload?.order?.entity;
  const refundEntity = body.payload?.refund?.entity;

  const orderId = paymentEntity?.order_id || orderEntity?.id;
  const paymentId = paymentEntity?.id || refundEntity?.payment_id;
  const receiptReservationId =
    orderEntity?.receipt || paymentEntity?.notes?.reservationId;

  let payment: LeanPaymentDoc | null = null;
  if (orderId) {
    payment = await Payment.findOne({ orderId }).lean<LeanPaymentDoc | null>();
  }
  if (!payment && paymentId) {
    payment = await Payment.findOne({ paymentId }).lean<LeanPaymentDoc | null>();
  }
  if (!payment && receiptReservationId) {
    payment = await Payment.findOne({
      reservationId: receiptReservationId,
    }).lean<LeanPaymentDoc | null>();
  }

  let detail = "ignored";

  switch (webhookDoc.event) {
    case "payment.authorized": {
      if (payment) {
        const res = await transitionPaymentStatus({
          reservationId: payment.reservationId,
          to: "authorized",
          ...(paymentId ? { setFields: { paymentId } } : {}),
          logContext: "webhook_payment_authorized",
        });
        detail = res ? "marked_authorized" : "transition_ignored";
      } else {
        detail = "payment_record_missing";
      }
      break;
    }

    case "payment.captured":
    case "order.paid": {
      const targetReservationId =
        payment?.reservationId || receiptReservationId;
      const targetOrderId = payment?.orderId || orderId;
      const amountPaise = paymentEntity?.amount ?? orderEntity?.amount;
      const currency = paymentEntity?.currency ?? orderEntity?.currency;
      const webhookOrderId = paymentEntity?.order_id || orderEntity?.id;
      const expectedProjectId =
        paymentEntity?.notes?.projectId || orderEntity?.notes?.projectId;
      const expectedUserId =
        paymentEntity?.notes?.userId || orderEntity?.notes?.userId;

      const fin = await finalizePayment({
        reservationId: targetReservationId,
        orderId: targetOrderId,
        paymentId,
        amountPaise,
        currency,
        webhookOrderId,
        expectedProjectId,
        expectedUserId,
        requireOrderPaid: webhookDoc.event === "order.paid",
        source:
          webhookDoc.event === "order.paid"
            ? "webhook_order_paid"
            : "webhook_payment_captured",
      });
      detail = fin.status;
      break;
    }

    case "payment.failed": {
      // Customer can retry on the same Razorpay order -> record failed but NEVER release reservation
      if (payment) {
        const res = await transitionPaymentStatus({
          reservationId: payment.reservationId,
          to: "failed",
          setFields: {
            ...(paymentId ? { paymentId } : {}),
            ...(paymentEntity?.error_description
              ? { lastError: paymentEntity.error_description }
              : {}),
          },
          logContext: "webhook_payment_failed",
        });
        detail = res ? "marked_failed_kept_reservation" : "transition_ignored";
      } else {
        detail = "payment_record_missing";
      }
      break;
    }

    case "refund.processed": {
      if (payment) {
        const res = await transitionPaymentStatus({
          reservationId: payment.reservationId,
          to: "refunded",
          setFields: {
            ...(refundEntity?.id ? { refundId: refundEntity.id } : {}),
            ...(paymentId ? { paymentId } : {}),
          },
          logContext: "webhook_refund_processed",
        });
        detail = res ? "marked_refunded" : "transition_ignored";
      } else {
        detail = "payment_record_missing";
      }
      break;
    }

    default:
      detail = `unhandled_event_${webhookDoc.event}`;
  }

  await WebhookEvent.updateOne(
    { eventId },
    { $set: { processedAt: new Date() } },
  );

  return { handled: true, event: webhookDoc.event, detail };
}

/**
 * Scheduled every 5 minutes (Asia/Kolkata):
 * (a) Releases expired project reservations (covering lost delayed jobs & orphan reservations)
 * (b) Re-enqueues WebhookEvents unprocessed for > 2 minutes onto `payments` queue
 */
export async function runPaymentsReaperSweep(
  paymentsQueue: Queue,
  options?: { now?: Date },
): Promise<{
  expiredReservationsProcessed: number;
  staleWebhooksReenqueued: number;
}> {
  await dbConnect();
  const now = options?.now ?? new Date();
  const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

  let expiredReservationsProcessed = 0;
  const projectsWithExpired = await Project.find({
    "reservations.expiresAt": { $lte: now },
  })
    .select("_id reservations")
    .lean<Array<{ _id: mongoose.Types.ObjectId; reservations?: ProjectReservationRecord[] }>>();

  for (const proj of projectsWithExpired) {
    const expired = (proj.reservations || []).filter(
      (r) => new Date(r.expiresAt).getTime() <= now.getTime(),
    );
    for (const r of expired) {
      await releaseReservation({
        projectId: proj._id.toString(),
        reservationId: r.reservationId,
        orderId: r.razorpayOrderId,
      });
      expiredReservationsProcessed++;
    }
  }

  let staleWebhooksReenqueued = 0;
  const staleEvents = await WebhookEvent.find({
    processedAt: null,
    receivedAt: { $lte: twoMinutesAgo },
  })
    .sort({ receivedAt: 1 })
    .limit(50)
    .select("eventId")
    .lean<Array<{ eventId: string }>>();

  for (const ev of staleEvents) {
    const jobId = `webhook_${sanitizeJobIdSegment(ev.eventId)}`;
    const existing = await paymentsQueue.getJob(jobId).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state === "waiting" || state === "active" || state === "delayed") {
        continue;
      }
      await existing.remove().catch(() => {});
    }
    await paymentsQueue.add(
      "process-webhook",
      { eventId: ev.eventId },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 200 },
        removeOnFail: false,
        jobId,
      },
    );
    staleWebhooksReenqueued++;
  }

  return { expiredReservationsProcessed, staleWebhooksReenqueued };
}

function sanitizeDeadLetterData(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/secret|token|signature|card|cvv|password/i.test(k)) continue;
    copy[k] = v;
  }
  return copy;
}

/**
 * Writes permanently failed BullMQ `payments` jobs into MongoDB DeadLetter collection
 * (protecting Redis 30MB memory), alerts ADMIN_EMAIL, and logs loudly.
 */
export async function recordPaymentsDeadLetter(
  job: Pick<Job, "id" | "name" | "data" | "attemptsMade" | "opts">,
  err: Error,
): Promise<boolean> {
  const maxAttempts = job.opts?.attempts ?? 5;
  if (job.attemptsMade < maxAttempts) {
    return false;
  }

  await dbConnect();
  const jobId = String(job.id ?? `${job.name}_${Date.now()}`);
  const safeData = sanitizeDeadLetterData(job.data);

  await DeadLetter.findOneAndUpdate(
    { queue: PAYMENTS_QUEUE, jobId },
    {
      $setOnInsert: {
        queue: PAYMENTS_QUEUE,
        jobName: job.name,
        jobId,
        data: safeData,
        error: err.message || "Unknown error",
        stack: err.stack?.slice(0, 2000),
        failedAt: new Date(),
        status: "open",
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  console.error(
    `[DLQ CRITICAL] Payments job exhausted retries -> stored in MongoDB DeadLetter (${job.name} / ${jobId}): ${err.message}`,
  );

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (adminEmail) {
    try {
      await sendAppEmail({
        to: adminEmail,
        subject: `[DLQ Alert] Payments job failed permanently: ${job.name}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626;">Dead-Letter Job Recorded</h2>
            <p><strong>Queue:</strong> ${PAYMENTS_QUEUE}</p>
            <p><strong>Job Name:</strong> ${job.name}</p>
            <p><strong>Job ID:</strong> <code>${jobId}</code></p>
            <p><strong>Error:</strong> ${err.message}</p>
            <p>Inspect and replay or discard from the Admin Console.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("[DLQ Alert Email Error]:", emailErr);
    }
  }

  return true;
}
