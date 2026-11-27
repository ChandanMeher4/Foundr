import { NextResponse } from "next/server";
import mongoose from "mongoose";
import crypto from "node:crypto";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { getSession } from "@/lib/auth";
import {
  AI_CACHE_TTL_SECONDS,
  getJson,
  isCacheDisabled,
  setJson,
} from "@/lib/cache";
import {
  buildAuthoritativeAiPrompt,
  requestGroqAnalysis,
} from "@/lib/ai";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getRedisConnection, getRedisKeyPrefix } from "@/lib/redis";
import { recordTrendingEvent } from "@/lib/trending";

const AI_LOCK_TTL_SECONDS = 30;
const AI_REDIS_TIMEOUT_MS = 1500;
const SINGLE_FLIGHT_MAX_WAIT_MS = 8000;
const SINGLE_FLIGHT_POLL_MS = 150;

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("AI lock Redis operation timed out")),
          AI_REDIS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  let lockKey: string | null = null;
  let lockToken: string | null = null;
  let acquiredLock = false;

  try {
    const rawBody = (await req.json().catch(() => ({}))) as {
      projectId?: unknown;
    };
    const projectId =
      typeof rawBody.projectId === "string" ? rawBody.projectId.trim() : "";

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return NextResponse.json(
        { error: "Valid Project ID is required." },
        { status: 400 },
      );
    }

    await dbConnect();

    const project = await Project.findById(projectId)
      .select(
        "title description location category constructionStage minInvestment totalValuation status developerName",
      )
      .lean<{
        title: string;
        description: string;
        location?: { address?: string };
        category?: string;
        constructionStage?: string;
        minInvestment: number;
        totalValuation: number;
        status: string;
        developerName?: { toString(): string };
      } | null>();

    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const session = await getSession();
    if (project.status !== "Live" && project.status !== "Funded") {
      const isAdmin = session?.role === "Admin";
      const isOwner =
        session?.role === "Developer" &&
        project.developerName?.toString() === session.id;
      if (!isAdmin && !isOwner) {
        return NextResponse.json(
          { error: "Project not found." },
          { status: 404 },
        );
      }
    }

    const { hash, systemPrompt, userPrompt } = buildAuthoritativeAiPrompt({
      projectId,
      title: project.title,
      description: project.description,
      address: project.location?.address || "Unknown",
      category: project.category,
      constructionStage: project.constructionStage,
      minInvestment: project.minInvestment,
      totalValuation: project.totalValuation,
    });

    const ip = getClientIp(req);
    const viewerKey = session?.id || ip;
    const cacheDisabled = isCacheDisabled();
    const cacheKey = `ai:${projectId}:${hash}`;

    // 1. Check cache BEFORE rate limits so cache HITs never consume quota
    if (!cacheDisabled) {
      const cached = await getJson<{ analysis: string }>(cacheKey);
      if (cached?.analysis) {
        await recordTrendingEvent({ type: "ai", projectId, viewerKey });
        return NextResponse.json(
          { analysis: cached.analysis },
          { headers: { "X-Cache": "HIT" } },
        );
      }
    }

    // 2. Per-IP limit (20/hour)
    const ipLimit = await rateLimit({
      key: `ai:ip:${ip}`,
      limit: 20,
      windowSeconds: 3600,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(20, ipLimit);
    }

    // 3. Global Groq limiter (30 calls / 60s across entire platform)
    const globalLimit = await rateLimit({
      key: "groq:global",
      limit: 30,
      windowSeconds: 60,
    });
    if (!globalLimit.allowed) {
      const retryAfter = Math.max(1, globalLimit.retryAfterSeconds || 1);
      return rateLimitResponse(
        30,
        globalLimit,
        `Too many AI requests across the platform. Try again in ${retryAfter} seconds.`,
      );
    }

    // 4. Single-flight lock to coalesce concurrent identical misses
    if (!cacheDisabled && process.env.REDIS_URL) {
      lockKey = `${getRedisKeyPrefix()}ai:lock:${hash}`;
      lockToken = crypto.randomUUID();
      try {
        const redis = getRedisConnection();
        const lockRes = await withTimeout(() =>
          redis.set(lockKey!, lockToken!, "EX", AI_LOCK_TTL_SECONDS, "NX"),
        );

        if (lockRes === "OK") {
          acquiredLock = true;
        } else {
          // Concurrent caller lost the lock: poll cache up to ~8s
          const deadline = Date.now() + SINGLE_FLIGHT_MAX_WAIT_MS;
          while (Date.now() < deadline) {
            await sleep(SINGLE_FLIGHT_POLL_MS);
            const polled = await getJson<{ analysis: string }>(cacheKey);
            if (polled?.analysis) {
              await recordTrendingEvent({ type: "ai", projectId, viewerKey });
              return NextResponse.json(
                { analysis: polled.analysis },
                { headers: { "X-Cache": "HIT" } },
              );
            }
          }
          console.warn(
            `[AI Single-Flight WARNING] Poll timed out after ${SINGLE_FLIGHT_MAX_WAIT_MS}ms for project ${projectId}; falling back to Groq call.`,
          );
        }
      } catch (lockErr) {
        console.warn(
          "[AI Single-Flight WARNING] Redis unreachable acquiring lock; failing OPEN:",
          lockErr instanceof Error ? lockErr.message : lockErr,
        );
        lockKey = null;
        lockToken = null;
        acquiredLock = false;
      }
    }

    // Double-check cache right before invoking Groq (only when holding lock)
    if (acquiredLock && !cacheDisabled) {
      const cachedJustNow = await getJson<{ analysis: string }>(cacheKey);
      if (cachedJustNow?.analysis) {
        await recordTrendingEvent({ type: "ai", projectId, viewerKey });
        return NextResponse.json(
          { analysis: cachedJustNow.analysis },
          { headers: { "X-Cache": "HIT" } },
        );
      }
    }

    // 5. Call Groq & cache result BEFORE releasing single-flight lock
    const analysis = await requestGroqAnalysis(systemPrompt, userPrompt);

    if (!cacheDisabled) {
      await setJson(cacheKey, { analysis }, AI_CACHE_TTL_SECONDS);
    }
    await recordTrendingEvent({ type: "ai", projectId, viewerKey });

    return NextResponse.json(
      { analysis },
      { headers: { "X-Cache": cacheDisabled ? "BYPASS" : "MISS" } },
    );
  } catch (error) {
    console.error("Groq AI Generation Error:", error);
    return NextResponse.json(
      { error: "Failed to analyze property." },
      { status: 500 },
    );
  } finally {
    if (acquiredLock && lockKey && lockToken && process.env.REDIS_URL) {
      try {
        const redis = getRedisConnection();
        await withTimeout(() =>
          redis.eval(RELEASE_LOCK_LUA, 1, lockKey!, lockToken!),
        );
      } catch (unlockErr) {
        console.warn(
          "[AI Single-Flight WARNING] Failed releasing lock:",
          unlockErr instanceof Error ? unlockErr.message : unlockErr,
        );
      }
    }
  }
}
