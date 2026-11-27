import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import AuditLog from "@/models/AuditLog";
import DeadLetter from "@/models/DeadLetter";
import { requireRole } from "@/lib/auth";
import { getPaymentsQueue } from "@/lib/queue";
import { sanitizeJobIdSegment } from "@/lib/razorpay";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: "Invalid dead-letter ID." },
        { status: 400 },
      );
    }

    await dbConnect();

    // 1. Atomic state lock: open -> replaying (concurrent replay receives 409)
    const lockedDoc = await DeadLetter.findOneAndUpdate(
      { _id: id, status: "open" },
      { $set: { status: "replaying" } },
      { returnDocument: "after" },
    ).lean<{
      _id: mongoose.Types.ObjectId;
      queue: string;
      jobName: string;
      jobId: string;
      data: Record<string, unknown>;
    } | null>();

    if (!lockedDoc) {
      const existing = await DeadLetter.findById(id)
        .select("status")
        .lean<{ status: string } | null>();
      if (!existing) {
        return NextResponse.json(
          { error: "Dead letter not found." },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          error: `Dead letter cannot be replayed (current status: ${existing.status}).`,
        },
        { status: 409 },
      );
    }

    const replayTs = Date.now();
    const replayJobId = `payments_replay_${sanitizeJobIdSegment(id)}_${replayTs}`;

    try {
      const paymentsQueue = getPaymentsQueue();

      // 2. Remove any leftover failed BullMQ job under the original jobId
      if (lockedDoc.jobId) {
        const oldJob = await paymentsQueue.getJob(lockedDoc.jobId).catch(() => null);
        if (oldJob) {
          await oldJob.remove().catch(() => {});
        }
      }

      // 3. Re-enqueue with fresh replay jobId (no colons) and fresh attempt count
      await paymentsQueue.add(lockedDoc.jobName, lockedDoc.data, {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 200 },
        removeOnFail: false,
        jobId: replayJobId,
      });
    } catch (enqueueErr) {
      await DeadLetter.updateOne(
        { _id: id, status: "replaying" },
        { $set: { status: "open" } },
      );
      console.error("[DLQ Replay Enqueue Error]:", enqueueErr);
      return NextResponse.json(
        { error: "Failed to enqueue dead-letter replay." },
        { status: 502 },
      );
    }

    // 4. Mark replayed and record AuditLog
    await DeadLetter.updateOne(
      { _id: id },
      {
        $set: {
          status: "replayed",
          replayedAt: new Date(),
          replayedBy: auth.session.id,
          replayJobId,
        },
      },
    );

    const rawProjectId =
      typeof lockedDoc.data?.projectId === "string" &&
      mongoose.Types.ObjectId.isValid(lockedDoc.data.projectId)
        ? lockedDoc.data.projectId
        : undefined;

    await AuditLog.create({
      investmentId: `dlqrep_${id}_${replayTs}`,
      eventType: "DEAD_LETTER_REPLAYED",
      ...(rawProjectId ? { projectId: rawProjectId } : {}),
      userId: auth.session.id,
      amount: 0,
      ip: "admin-dlq",
      metadata: {
        deadLetterId: id,
        queue: lockedDoc.queue,
        jobName: lockedDoc.jobName,
        originalJobId: lockedDoc.jobId,
        replayJobId,
      },
    });

    return NextResponse.json({
      replayed: true,
      id,
      replayJobId,
    });
  } catch (error) {
    console.error("Dead Letter Replay Error:", error);
    return NextResponse.json(
      { error: "Failed to replay dead letter." },
      { status: 500 },
    );
  }
}
