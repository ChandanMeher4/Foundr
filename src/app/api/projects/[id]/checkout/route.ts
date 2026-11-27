import crypto from "node:crypto";
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import Payment from "@/models/Payment";
import { requireRole } from "@/lib/auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  RazorpayConfigError,
  getRazorpayClient,
  getReservationTtlMs,
} from "@/lib/razorpay";
import { enqueueReleaseReservation } from "@/lib/queue";
import {
  releaseExpiredReservationsForProject,
  removeProjectReservationAtomic,
  type ProjectReservationRecord,
} from "@/lib/payments";

interface DiagnosticProject {
  _id: mongoose.Types.ObjectId;
  status: string;
  minInvestment: number;
  currentFunding: number;
  reservedFunding?: number;
  totalValuation: number;
  reservations?: ProjectReservationRecord[];
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Investor");
    if (auth.response) return auth.response;

    const userId = auth.session.id;
    const { id: projectId } = await params;

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return NextResponse.json({ error: "Invalid project ID." }, { status: 400 });
    }

    const idempotencyKey = req.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "Idempotency-Key header is required." },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as { amount?: unknown };
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Commitment amount must be a positive whole-rupee integer." },
        { status: 400 },
      );
    }

    const amountPaise = amount * 100;
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) {
      return NextResponse.json(
        { error: "Commitment amount is out of supported range." },
        { status: 400 },
      );
    }

    const checkoutLimit = await rateLimit({
      key: `checkout:user:${userId}`,
      limit: 10,
      windowSeconds: 60,
    });
    if (!checkoutLimit.allowed) {
      return rateLimitResponse(10, checkoutLimit);
    }

    let razorpayBundle: ReturnType<typeof getRazorpayClient>;
    try {
      razorpayBundle = getRazorpayClient();
    } catch (err) {
      if (err instanceof RazorpayConfigError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      throw err;
    }

    await dbConnect();

    // 1. Opportunistically release any expired reservations on this project atomically
    await releaseExpiredReservationsForProject(projectId);

    const ttlMs = getReservationTtlMs();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const reservationId = new mongoose.Types.ObjectId().toString();
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // 2. ONE atomic findOneAndUpdate enforcing currentFunding + reservedFunding <= totalValuation
    const reservedProject = await Project.findOneAndUpdate(
      {
        _id: projectId,
        status: "Live",
        minInvestment: { $lte: amount },
        $expr: {
          $lte: [
            {
              $add: [
                { $ifNull: ["$currentFunding", 0] },
                { $ifNull: ["$reservedFunding", 0] },
                amount,
              ],
            },
            "$totalValuation",
          ],
        },
        reservations: {
          $not: {
            $elemMatch: {
              userId: userObjectId,
              idempotencyKey,
            },
          },
        },
        investors: {
          $not: {
            $elemMatch: {
              userId: userObjectId,
              idempotencyKey,
            },
          },
        },
      },
      {
        $push: {
          reservations: {
            reservationId,
            userId: userObjectId,
            amount,
            idempotencyKey,
            status: "pending",
            expiresAt,
            createdAt: now,
          },
        },
        $inc: { reservedFunding: amount },
      },
      { returnDocument: "after" },
    ).lean<DiagnosticProject | null>();

    if (!reservedProject) {
      // Check idempotent replay in pending reservations first
      const projWithDupRes = await Project.findOne({
        _id: projectId,
        reservations: {
          $elemMatch: {
            userId: userObjectId,
            idempotencyKey,
          },
        },
      })
        .select("reservations")
        .lean<{ reservations?: ProjectReservationRecord[] } | null>();

      const matchedPending = projWithDupRes?.reservations?.find(
        (r) => r.userId.toString() === userId && r.idempotencyKey === idempotencyKey,
      );

      if (matchedPending) {
        if (matchedPending.amount !== amount) {
          return NextResponse.json(
            {
              error:
                "Idempotency-Key cannot be reused with a different amount or project.",
            },
            { status: 422 },
          );
        }

        const existingPayment = await Payment.findOne({
          reservationId: matchedPending.reservationId,
        }).lean<{
          orderId: string;
          amountPaise: number;
          currency: string;
          reservationId: string;
          expiresAt?: Date;
        } | null>();

        if (existingPayment) {
          return NextResponse.json(
            {
              orderId: existingPayment.orderId,
              amountPaise: existingPayment.amountPaise,
              currency: existingPayment.currency || "INR",
              keyId: razorpayBundle.keyId,
              reservationId: existingPayment.reservationId,
              expiresAt: (
                existingPayment.expiresAt || matchedPending.expiresAt
              ).toISOString(),
            },
            { status: 200, headers: { "X-Idempotent-Replay": "true" } },
          );
        }
      }

      // Check existing Payment record for same (userId, projectId, idempotencyKey)
      const priorPayment = await Payment.findOne({
        userId: userObjectId,
        projectId,
        idempotencyKey,
      }).lean<{
        orderId: string;
        amountPaise: number;
        currency: string;
        reservationId: string;
        status: string;
        expiresAt?: Date;
      } | null>();

      if (priorPayment) {
        if (priorPayment.amountPaise !== amountPaise) {
          return NextResponse.json(
            {
              error:
                "Idempotency-Key cannot be reused with a different amount or project.",
            },
            { status: 422 },
          );
        }
        return NextResponse.json(
          {
            orderId: priorPayment.orderId,
            amountPaise: priorPayment.amountPaise,
            currency: priorPayment.currency || "INR",
            keyId: razorpayBundle.keyId,
            reservationId: priorPayment.reservationId,
            status: priorPayment.status,
            expiresAt: priorPayment.expiresAt?.toISOString() ?? null,
          },
          { status: 200, headers: { "X-Idempotent-Replay": "true" } },
        );
      }

      // Diagnose exact failure reason cleanly
      const existing = await Project.findById(projectId)
        .select("status minInvestment currentFunding reservedFunding totalValuation reservations")
        .lean<DiagnosticProject | null>();

      if (!existing || existing.status !== "Live") {
        return NextResponse.json(
          { error: "Opportunity not found or not currently open." },
          { status: 404 },
        );
      }

      if (amount < existing.minInvestment) {
        return NextResponse.json(
          {
            error: `Minimum commitment is ₹${existing.minInvestment.toLocaleString("en-IN")}`,
          },
          { status: 400 },
        );
      }

      const currentFunded = existing.currentFunding || 0;
      const reserved = existing.reservedFunding || 0;
      const unreservedRemaining = Math.max(
        0,
        existing.totalValuation - currentFunded - reserved,
      );

      // Capacity is temporarily held by pending payments
      if (reserved > 0 && currentFunded + amount <= existing.totalValuation) {
        const activeExpiries = (existing.reservations || [])
          .map((r) => new Date(r.expiresAt).getTime())
          .filter((ms) => Number.isFinite(ms) && ms > Date.now())
          .sort((a, b) => a - b);

        const soonestExpiry =
          activeExpiries.length > 0 ? new Date(activeExpiries[0]) : null;
        const minutesWait = soonestExpiry
          ? Math.max(1, Math.ceil((soonestExpiry.getTime() - Date.now()) / 60000))
          : 15;

        return NextResponse.json(
          {
            error: `Capacity is temporarily held by pending payments, try again in ${minutesWait} minute(s).`,
            expiresAt: soonestExpiry?.toISOString() ?? null,
            unreservedRemaining,
          },
          { status: 409 },
        );
      }

      return NextResponse.json(
        {
          error: `Commitment exceeds remaining allocation of ₹${unreservedRemaining.toLocaleString("en-IN")}.`,
        },
        { status: 400 },
      );
    }

    // 3. Create Razorpay order (compensating release immediately if Razorpay call fails)
    let orderId: string;
    try {
      const order = await razorpayBundle.client.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: reservationId,
        notes: {
          projectId,
          userId,
          reservationId,
          simulationMode: "test",
        },
      });
      orderId = order.id;
    } catch (gatewayErr) {
      console.error("[Checkout Gateway Error]:", gatewayErr);
      await removeProjectReservationAtomic(projectId, reservationId).catch(() => {});
      return NextResponse.json(
        {
          error:
            "Payment gateway failed to create test order. Capacity reservation released.",
        },
        { status: 502 },
      );
    }

    await Project.updateOne(
      { _id: projectId, "reservations.reservationId": reservationId },
      { $set: { "reservations.$.razorpayOrderId": orderId } },
    ).catch(() => {});

    // 4. Persist Payment document + best-effort delayed release job
    await Payment.findOneAndUpdate(
      { reservationId },
      {
        $setOnInsert: {
          reservationId,
          orderId,
          idempotencyKey,
          projectId,
          userId: userObjectId,
          amountPaise,
          currency: "INR",
          status: "created",
          expiresAt,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (process.env.REDIS_URL) {
      try {
        await enqueueReleaseReservation(
          {
            projectId,
            reservationId,
            orderId,
          },
          ttlMs,
        );
      } catch (queueErr) {
        console.warn(
          "[Checkout Release Job WARNING] Enqueue failed (reaper will clean):",
          queueErr instanceof Error ? queueErr.message : queueErr,
        );
      }
    }

    return NextResponse.json({
      orderId,
      amountPaise,
      currency: "INR",
      keyId: razorpayBundle.keyId,
      reservationId,
      expiresAt: expiresAt.toISOString(),
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    console.error("Checkout Reservation Error:", error);
    return NextResponse.json(
      { error: "Failed to initiate test checkout." },
      { status: 500 },
    );
  }
}
