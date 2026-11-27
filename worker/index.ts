import { validateWorkerEnv } from "./env";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Redis from "ioredis";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import {
  processInvestmentJob,
  processLifecycleJob,
  processPaymentsJob,
  processScheduledJob,
} from "./processors";
import dbConnect from "../src/lib/db";
import { cleanupLegacyOtpFields } from "../src/lib/otp";
import { recordPaymentsDeadLetter } from "../src/lib/payments";
import Project from "../src/models/Project";
import {
  BULLBOARD_COOKIE_NAME,
  BullBoardAuthError,
  signBullBoardSessionToken,
  verifyBullBoardHandoffToken,
  verifyBullBoardSessionToken,
} from "../src/lib/auth-core";
import {
  INVESTMENT_EVENTS_QUEUE,
  LIFECYCLE_QUEUE,
  PAYMENTS_QUEUE,
  SCHEDULED_QUEUE,
  getBullPrefix,
} from "../src/lib/queue";

const { redisUrl } = validateWorkerEnv();
const PORT = Number(process.env.PORT || 4000);
const WORKER_CONCURRENCY = 3; // Low concurrency (2-5) for Redis Cloud free tier

const ALLOWED_ORIGINS = (
  process.env.FRONTEND_ORIGIN ||
  "https://foundr-gamma.vercel.app,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function createRedis(label: string): Redis {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  client.on("error", (err) => {
    console.error(`[Worker Redis:${label}]`, err.message);
  });
  return client;
}

async function verifyEvictionPolicy(redis: Redis): Promise<string | null> {
  let policy: string | null = null;

  try {
    const result = (await redis.config("GET", "maxmemory-policy")) as string[];
    if (Array.isArray(result) && result.length >= 2 && result[1]) {
      policy = result[1].trim();
    }
  } catch {
    // Managed Redis providers (e.g., Redis Cloud) may restrict CONFIG; fall back to INFO memory
  }

  if (!policy) {
    try {
      const info = await redis.info("memory");
      const match = info.match(/^maxmemory_policy:([^\r\n]+)/m);
      if (match?.[1]) {
        policy = match[1].trim();
      }
    } catch (err) {
      console.warn(
        "[Redis WARNING] Could not query maxmemory-policy via CONFIG or INFO memory:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  if (policy !== "noeviction") {
    console.warn(
      `[Redis WARNING] maxmemory-policy is "${policy ?? "unknown"}". Configure Redis to "noeviction" so BullMQ queues are never dropped.`,
    );
  } else {
    console.log("[Redis] Eviction policy verified: noeviction");
  }
  return policy;
}

async function getConnectedClients(redis: Redis): Promise<number | null> {
  try {
    const info = await redis.info("clients");
    const match = info.match(/^connected_clients:(\d+)/m);
    const infoCount = match?.[1] ? Number(match[1]) : null;
    // Redis Cloud multi-tenant proxy reports connected_clients:0 in INFO clients; fall back to CLIENT LIST
    if (infoCount !== null && infoCount > 0) {
      return infoCount;
    }
    try {
      const clientList = (await redis.client("LIST")) as string;
      if (typeof clientList === "string" && clientList.trim().length > 0) {
        return clientList.trim().split(/\r?\n/).filter(Boolean).length;
      }
    } catch {
      // Preserve infoCount if CLIENT LIST is disabled on the host
    }
    return infoCount;
  } catch (err) {
    console.warn(
      "[Redis WARNING] Could not query INFO clients:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function requireBullBoardSessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Accept ONLY the worker-scoped bullboard_session cookie; reject main login foundr_token
  const token = req.cookies?.[BULLBOARD_COOKIE_NAME];

  if (!token || typeof token !== "string") {
    res.status(401).json({ error: "Unauthorized. Bull Board session required." });
    return;
  }

  try {
    await verifyBullBoardSessionToken(token);
    next();
  } catch (err) {
    if (err instanceof BullBoardAuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(401).json({ error: "Invalid or expired Bull Board session." });
  }
}

/**
 * Idempotently registers recurring Asia/Kolkata BullMQ Job Schedulers so restarts never duplicate runs.
 * BullMQ does not backfill runs missed while the worker was stopped or sleeping.
 */
export async function registerScheduledJobs(
  scheduledQueue: Queue,
): Promise<void> {
  await scheduledQueue.upsertJobScheduler(
    "daily-digest-scheduler",
    { pattern: "0 8 * * *", tz: "Asia/Kolkata" },
    { name: "daily-digest", data: {} },
  );
  await scheduledQueue.upsertJobScheduler(
    "nightly-cleanup-scheduler",
    { pattern: "30 2 * * *", tz: "Asia/Kolkata" },
    { name: "nightly-cleanup", data: {} },
  );
  await scheduledQueue.upsertJobScheduler(
    "weekly-stats-scheduler",
    { pattern: "0 9 * * 1", tz: "Asia/Kolkata" },
    { name: "weekly-stats", data: {} },
  );
  await scheduledQueue.upsertJobScheduler(
    "payments-reaper-scheduler",
    { pattern: "*/5 * * * *", tz: "Asia/Kolkata" },
    { name: "payments-reaper", data: {} },
  );
}

async function main() {
  // Connection budget (Redis Cloud 30-conn free tier):
  // - commandRedis: shared across health, config/clients checks, Queues & Bull Board
  // - 4 Worker connections: investment-events, lifecycle, scheduled, payments
  // - subRedis: single psubscribe('funding:*') multiplexing all SSE clients
  const commandRedis = createRedis("cmd");
  const investWorkerRedis = createRedis("worker-invest");
  const lifecycleWorkerRedis = createRedis("worker-lifecycle");
  const scheduledWorkerRedis = createRedis("worker-scheduled");
  const paymentsWorkerRedis = createRedis("worker-payments");
  const subRedis = createRedis("sub");

  const evictionPolicy = await verifyEvictionPolicy(commandRedis);
  const initialClients = await getConnectedClients(commandRedis);
  console.log(`[Redis] Connected clients: ${initialClients ?? "unknown"}`);

  try {
    const cleanedOtpUsers = await cleanupLegacyOtpFields();
    console.log(
      `[OTP Cleanup] Removed legacy otp/otpExpiry fields from ${cleanedOtpUsers} user(s).`,
    );
  } catch (cleanupErr) {
    console.warn(
      "[OTP Cleanup WARNING] Startup legacy OTP cleanup failed:",
      cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
    );
  }

  const bullPrefix = getBullPrefix();
  const queueOpts = {
    connection: commandRedis as unknown as ConnectionOptions,
    ...(bullPrefix ? { prefix: bullPrefix } : {}),
  };

  const investmentQueue = new Queue(INVESTMENT_EVENTS_QUEUE, queueOpts);
  const lifecycleQueue = new Queue(LIFECYCLE_QUEUE, queueOpts);
  const scheduledQueue = new Queue(SCHEDULED_QUEUE, queueOpts);
  const paymentsQueue = new Queue(PAYMENTS_QUEUE, queueOpts);
  const allQueues = [
    investmentQueue,
    lifecycleQueue,
    scheduledQueue,
    paymentsQueue,
  ];

  await registerScheduledJobs(scheduledQueue);

  const worker = new Worker(
    INVESTMENT_EVENTS_QUEUE,
    async (job) => processInvestmentJob(job, investmentQueue),
    {
      connection: investWorkerRedis as unknown as ConnectionOptions,
      concurrency: WORKER_CONCURRENCY,
      ...(bullPrefix ? { prefix: bullPrefix } : {}),
    },
  );

  const lifecycleWorker = new Worker(
    LIFECYCLE_QUEUE,
    async (job) => processLifecycleJob(job),
    {
      connection: lifecycleWorkerRedis as unknown as ConnectionOptions,
      concurrency: 2,
      ...(bullPrefix ? { prefix: bullPrefix } : {}),
    },
  );

  const scheduledWorker = new Worker(
    SCHEDULED_QUEUE,
    async (job) => processScheduledJob(job, scheduledQueue, allQueues),
    {
      connection: scheduledWorkerRedis as unknown as ConnectionOptions,
      concurrency: 1,
      ...(bullPrefix ? { prefix: bullPrefix } : {}),
    },
  );

  const paymentsWorker = new Worker(
    PAYMENTS_QUEUE,
    async (job) => processPaymentsJob(job),
    {
      connection: paymentsWorkerRedis as unknown as ConnectionOptions,
      concurrency: 2,
      ...(bullPrefix ? { prefix: bullPrefix } : {}),
    },
  );

  for (const w of [worker, lifecycleWorker, scheduledWorker, paymentsWorker]) {
    w.on("completed", (job) => {
      console.log(`[Worker:${w.name}] Completed ${job.name} (${job.id})`);
    });
    w.on("failed", (job, err) => {
      console.error(
        `[Worker:${w.name}] Failed ${job?.name} (${job?.id}):`,
        err.message,
      );
    });
  }

  paymentsWorker.on("failed", (job, err) => {
    if (!job) return;
    void recordPaymentsDeadLetter(job, err).catch((dlqErr) => {
      console.error("[DLQ Write Error]:", dlqErr);
    });
  });

  // Single subscriber fan-out map for public SSE funding progress streams
  const sseClients = new Map<string, Set<Response>>();
  await subRedis.psubscribe("funding:*");
  subRedis.on("pmessage", (_pattern, channel, message) => {
    const projectId = channel.replace("funding:", "");
    const clients = sseClients.get(projectId);
    if (!clients || clients.size === 0) return;

    const frame = `event: funding\ndata: ${message}\n\n`;
    for (const res of clients) {
      res.write(frame);
    }
  });

  const app = express();
  app.use(cookieParser());
  app.use(
    cors({
      origin: ALLOWED_ORIGINS,
      credentials: true,
    }),
  );

  // Health endpoint for UptimeRobot & Render/Railway health checks
  app.get("/health", async (_req, res) => {
    try {
      const pong = await Promise.race([
        commandRedis.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Redis ping timeout")), 2000),
        ),
      ]);
      if (pong !== "PONG") throw new Error(`Unexpected ping response: ${pong}`);
      const [
        connectedClients,
        investCounts,
        lifecycleCounts,
        scheduledCounts,
        paymentsCounts,
      ] = await Promise.all([
        getConnectedClients(commandRedis),
        investmentQueue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "failed",
          "completed",
        ),
        lifecycleQueue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "failed",
          "completed",
        ),
        scheduledQueue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "failed",
          "completed",
        ),
        paymentsQueue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "failed",
          "completed",
        ),
      ]);
      res.status(200).json({
        status: "ok",
        redis: "connected",
        evictionPolicy: evictionPolicy ?? "unknown",
        connected_clients: connectedClients,
        queues: {
          [INVESTMENT_EVENTS_QUEUE]: investCounts,
          [LIFECYCLE_QUEUE]: lifecycleCounts,
          [SCHEDULED_QUEUE]: scheduledCounts,
          [PAYMENTS_QUEUE]: paymentsCounts,
        },
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(503).json({
        status: "unhealthy",
        redis: "disconnected",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // Public SSE stream for live project funding progress (no cookie auth required)
  app.get("/projects/:id/stream", async (req, res) => {
    const projectId = req.params.id;
    if (!/^[a-fA-F0-9]{24}$/.test(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 5000\n\n");
    res.write(": connected\n\n");

    let set = sseClients.get(projectId);
    if (!set) {
      set = new Set();
      sseClients.set(projectId, set);
    }
    set.add(res);

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(keepAlive);
      const current = sseClients.get(projectId);
      if (current) {
        current.delete(res);
        if (current.size === 0) {
          sseClients.delete(projectId);
        }
      }
      res.end();
    });

    // Push immediate current state so reconnecting clients never stay stale
    try {
      await dbConnect();
      const project = await Project.findById(projectId)
        .select("currentFunding totalValuation status")
        .lean();
      if (project && !req.destroyed && !res.writableEnded) {
        const currentFunding = project.currentFunding || 0;
        const totalValuation = project.totalValuation;
        const initialPayload = {
          projectId,
          currentFunding,
          totalValuation,
          status: project.status,
          percentage:
            totalValuation > 0
              ? Math.min((currentFunding / totalValuation) * 100, 100)
              : 0,
        };
        res.write(`event: funding\ndata: ${JSON.stringify(initialPayload)}\n\n`);
      }
    } catch (err) {
      console.error("[Worker SSE Initial State Error]:", err);
    }
  });

  // Short-lived single-use handoff login exchanging Vercel-signed token for worker bullboard_session cookie
  app.get("/admin/queues/login", async (req, res) => {
    const rawToken = typeof req.query.token === "string" ? req.query.token : "";
    if (!rawToken) {
      res.status(401).json({ error: "Missing handoff token." });
      return;
    }

    try {
      const payload = await verifyBullBoardHandoffToken(rawToken);
      const jtiKey = `bullboard:jti:${payload.jti}`;
      const locked = await commandRedis.set(jtiKey, "used", "EX", 120, "NX");
      if (locked !== "OK") {
        res.status(401).json({ error: "Handoff token has already been used." });
        return;
      }

      const sessionToken = await signBullBoardSessionToken({
        id: payload.id,
        role: payload.role,
      });

      res.cookie(BULLBOARD_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 1000,
        path: "/admin/queues",
      });
      res.redirect(302, "/admin/queues");
    } catch (err) {
      if (err instanceof BullBoardAuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(401).json({ error: "Invalid handoff token." });
    }
  });

  // Bull Board Dashboard + static assets (strictly protected behind bullboard_session cookie)
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [
      new BullMQAdapter(investmentQueue),
      new BullMQAdapter(lifecycleQueue),
      new BullMQAdapter(scheduledQueue),
      new BullMQAdapter(paymentsQueue),
    ],
    serverAdapter,
  });
  app.use(
    "/admin/queues",
    requireBullBoardSessionMiddleware,
    serverAdapter.getRouter(),
  );

  const server = app.listen(PORT, () => {
    console.log(`[Worker] Listening on port ${PORT}`);
    console.log(`[Worker] Health check: GET /health`);
    console.log(`[Worker] SSE Stream: GET /projects/:id/stream`);
    console.log(`[Worker] Bull Board (Admin): /admin/queues`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
    server.close();
    await worker.close();
    await lifecycleWorker.close();
    await scheduledWorker.close();
    await paymentsWorker.close();
    await investmentQueue.close();
    await lifecycleQueue.close();
    await scheduledQueue.close();
    await paymentsQueue.close();
    await subRedis.quit();
    await commandRedis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  main().catch((err) => {
    console.error("[Worker] Startup fatal error:", err);
    process.exit(1);
  });
}
