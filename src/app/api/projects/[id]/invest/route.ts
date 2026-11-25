import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { revalidatePath } from "next/cache";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import User from "@/models/User";
import { requireRole } from "@/lib/auth";
import {
  getRedisConnection,
  getRedisKeyPrefix,
  publishFundingUpdate,
} from "@/lib/redis";
import { enqueueInvestmentFlow } from "@/lib/queue";

const IDEMPOTENCY_PROCESSING_TTL = 30;
const IDEMPOTENCY_DONE_TTL = 86400;

interface IdempotencyRecord {
  status: "processing" | "completed";
  amount: number;
  projectId: string;
  statusCode?: number;
  body?: Record<string, unknown>;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let idemRedisKey: string | null = null;
  let acquiredLock = false;

  try {
    const auth = await requireRole();
    if (auth.response) return auth.response;

    const { id: projectId } = await params;
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return NextResponse.json(
        { error: "Invalid project ID." },
        { status: 400 },
      );
    }

    const body = await req.json();
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Commitment amount must be a positive number." },
        { status: 400 },
      );
    }

    const investorId = auth.session.id;
    const rawIdemKey = req.headers.get("idempotency-key")?.trim();
    const redis = process.env.REDIS_URL ? getRedisConnection() : null;

    if (rawIdemKey && redis) {
      idemRedisKey = `${getRedisKeyPrefix()}idem:${investorId}:${rawIdemKey}`;
      const processingPayload: IdempotencyRecord = {
        status: "processing",
        amount,
        projectId,
      };

      const lockRes = await redis.set(
        idemRedisKey,
        JSON.stringify(processingPayload),
        "EX",
        IDEMPOTENCY_PROCESSING_TTL,
        "NX",
      );

      if (lockRes === "OK") {
        acquiredLock = true;
      } else {
        // Handle duplicate / in-flight / mismatched key
        for (let attempt = 0; attempt < 4; attempt++) {
          const existingRaw = await redis.get(idemRedisKey);
          if (!existingRaw) break;

          const existing = JSON.parse(existingRaw) as IdempotencyRecord;
          if (
            existing.amount !== amount ||
            existing.projectId !== projectId
          ) {
            return NextResponse.json(
              {
                error:
                  "Idempotency-Key cannot be reused with a different amount or project.",
              },
              { status: 422 },
            );
          }

          if (existing.status === "completed" && existing.body) {
            return NextResponse.json(existing.body, {
              status: existing.statusCode || 200,
              headers: { "X-Idempotent-Replay": "true" },
            });
          }

          if (attempt < 3) await sleep(80);
        }

        return NextResponse.json(
          { error: "Duplicate investment request is currently processing." },
          { status: 409 },
        );
      }
    }

    await dbConnect();

    const investor = await User.findById(investorId).select("name email").lean();
    if (!investor) {
      if (acquiredLock && idemRedisKey && redis) await redis.del(idemRedisKey);
      return NextResponse.json(
        { error: "Investor account not found." },
        { status: 404 },
      );
    }

    const investmentObjectId = new mongoose.Types.ObjectId();
    const investmentId = investmentObjectId.toString();
    const committedAt = new Date();

    const investorObjectId = new mongoose.Types.ObjectId(investorId);
    const atomicFilter: Record<string, unknown> = {
      _id: projectId,
      status: "Live",
      minInvestment: { $lte: amount },
      $expr: {
        $lte: [{ $add: ["$currentFunding", amount] }, "$totalValuation"],
      },
      ...(rawIdemKey
        ? {
            investors: {
              $not: {
                $elemMatch: {
                  userId: investorObjectId,
                  idempotencyKey: rawIdemKey,
                },
              },
            },
          }
        : {}),
    };

    // Atomic conditional increment: guarantees funding <= totalValuation and per-key uniqueness in MongoDB
    const updatedProject = await Project.findOneAndUpdate(
      atomicFilter,
      {
        $inc: { currentFunding: amount },
        $push: {
          investors: {
            _id: investmentObjectId,
            userId: investorId,
            amount,
            date: committedAt,
            ...(rawIdemKey ? { idempotencyKey: rawIdemKey } : {}),
          },
        },
      },
      { returnDocument: "after" },
    ).populate("developerName", "name email");

    if (!updatedProject) {
      // Fallback for crash between MongoDB commit and Redis cache write
      if (rawIdemKey) {
        const priorProject = await Project.findOne({
          _id: projectId,
          investors: {
            $elemMatch: {
              userId: investorObjectId,
              idempotencyKey: rawIdemKey,
            },
          },
        }).populate("developerName", "name email");

        if (priorProject) {
          const matchedEntry = (
            priorProject.investors as Array<{
              _id?: mongoose.Types.ObjectId;
              userId?: mongoose.Types.ObjectId;
              amount: number;
              idempotencyKey?: string;
            }>
          ).find(
            (entry) =>
              entry.userId?.toString() === investorId &&
              entry.idempotencyKey === rawIdemKey,
          );

          if (matchedEntry && matchedEntry.amount !== amount) {
            if (acquiredLock && idemRedisKey && redis) {
              await redis.del(idemRedisKey);
            }
            return NextResponse.json(
              {
                error:
                  "Idempotency-Key cannot be reused with a different amount or project.",
              },
              { status: 422 },
            );
          }

          if (
            priorProject.status === "Live" &&
            priorProject.currentFunding >= priorProject.totalValuation
          ) {
            await Project.updateOne(
              { _id: projectId, status: "Live" },
              { $set: { status: "Funded" } },
            );
            priorProject.status = "Funded";
          }

          const replayBody = {
            message: "Commitment secured successfully!",
            investmentId: matchedEntry?._id?.toString() ?? "",
            project: priorProject,
          };

          if (idemRedisKey && redis) {
            await redis.set(
              idemRedisKey,
              JSON.stringify({
                status: "completed",
                amount,
                projectId,
                statusCode: 200,
                body: replayBody,
              }),
              "EX",
              IDEMPOTENCY_DONE_TTL,
            );
          }

          return NextResponse.json(replayBody, {
            status: 200,
            headers: { "X-Idempotent-Replay": "true" },
          });
        }
      }

      if (acquiredLock && idemRedisKey && redis) await redis.del(idemRedisKey);

      const existing = await Project.findById(projectId)
        .select("status currentFunding totalValuation minInvestment")
        .lean();

      if (!existing) {
        return NextResponse.json(
          { error: "Opportunity not found." },
          { status: 404 },
        );
      }
      if (
        existing.status === "Funded" ||
        existing.currentFunding >= existing.totalValuation
      ) {
        return NextResponse.json(
          { error: "This opportunity is already fully funded." },
          { status: 400 },
        );
      }
      if (existing.status !== "Live") {
        return NextResponse.json(
          { error: "This opportunity is not open for investment." },
          { status: 400 },
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
      const remaining = Math.max(
        0,
        existing.totalValuation - (existing.currentFunding || 0),
      );
      return NextResponse.json(
        {
          error: `Commitment exceeds remaining allocation of ₹${remaining.toLocaleString("en-IN")}.`,
        },
        { status: 400 },
      );
    }

    const becameFunded =
      updatedProject.currentFunding >= updatedProject.totalValuation;

    if (becameFunded) {
      await Project.updateOne(
        {
          _id: projectId,
          status: "Live",
          currentFunding: { $gte: updatedProject.totalValuation },
        },
        { $set: { status: "Funded" } },
      );
      updatedProject.status = "Funded";
    }

    const responseBody = {
      message: "Commitment secured successfully!",
      investmentId,
      project: updatedProject,
    };

    if (acquiredLock && idemRedisKey && redis) {
      const doneRecord: IdempotencyRecord = {
        status: "completed",
        amount,
        projectId,
        statusCode: 200,
        body: responseBody,
      };
      await redis.set(
        idemRedisKey,
        JSON.stringify(doneRecord),
        "EX",
        IDEMPOTENCY_DONE_TTL,
      );
    }

    const percentage = Math.min(
      (updatedProject.currentFunding / updatedProject.totalValuation) * 100,
      100,
    );

    if (redis) {
      try {
        await publishFundingUpdate({
          projectId,
          currentFunding: updatedProject.currentFunding,
          totalValuation: updatedProject.totalValuation,
          status: updatedProject.status,
          percentage,
        });
      } catch (pubErr) {
        console.error("[Redis Pub/Sub Error]:", pubErr);
      }

      try {
        const dev = updatedProject.developerName as
          | { name?: string; email?: string }
          | undefined;

        await enqueueInvestmentFlow({
          investmentId,
          projectId,
          projectTitle: updatedProject.title,
          investorId,
          investorName: investor.name,
          investorEmail: investor.email,
          developerName: dev?.name || "Developer",
          developerEmail: dev?.email,
          amount,
          currentFunding: updatedProject.currentFunding,
          totalValuation: updatedProject.totalValuation,
          becameFunded,
          ...(rawIdemKey ? { idempotencyKey: rawIdemKey } : {}),
          ip: getClientIp(req),
          createdAt: committedAt.toISOString(),
        });
      } catch (queueErr) {
        // Queue failures must never fail the committed MongoDB investment
        console.error("[BullMQ Enqueue Error]:", queueErr);
      }
    }

    revalidatePath("/");
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/developer");
    revalidatePath("/admin");

    return NextResponse.json(responseBody, { status: 200 });
  } catch (error) {
    if (acquiredLock && idemRedisKey && process.env.REDIS_URL) {
      try {
        await getRedisConnection().del(idemRedisKey);
      } catch {
        // Ignore cleanup errors on unexpected failures
      }
    }
    console.error("Investment error:", error);
    return NextResponse.json(
      { error: "Failed to process commitment." },
      { status: 500 },
    );
  }
}
