import { validateWorkerEnv } from "./env";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import Redis from "ioredis";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { processInvestmentJob } from "./processors";
import { AUTH_COOKIE_NAME, verifySessionToken } from "../src/lib/auth-core";
import { INVESTMENT_EVENTS_QUEUE } from "../src/lib/queue";

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

async function requireAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : undefined;
  const token = req.cookies?.[AUTH_COOKIE_NAME] || bearer;

  if (!token) {
    res.status(401).json({ error: "Unauthorized. Admin session required." });
    return;
  }

  try {
    const session = await verifySessionToken(token);
    if (session.role !== "Admin") {
      res.status(403).json({ error: "Forbidden. Admin role required." });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session token." });
  }
}

async function main() {
  // Dedicated 3-connection architecture (well below Redis Cloud's 30-connection free tier):
  // 1. commandRedis (health, config check, Queue/BullBoard)
  // 2. workerRedis (BullMQ Worker blocking loop)
  // 3. subRedis (single psubscribe('funding:*') multiplexing all SSE clients)
  const commandRedis = createRedis("cmd");
  const workerRedis = createRedis("worker");
  const subRedis = createRedis("sub");

  const evictionPolicy = await verifyEvictionPolicy(commandRedis);

  const investmentQueue = new Queue(INVESTMENT_EVENTS_QUEUE, {
    connection: commandRedis as unknown as ConnectionOptions,
  });

  const worker = new Worker(
    INVESTMENT_EVENTS_QUEUE,
    async (job) => processInvestmentJob(job, investmentQueue),
    {
      connection: workerRedis as unknown as ConnectionOptions,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("completed", (job) => {
    console.log(`[Worker] Completed ${job.name} (${job.id})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[Worker] Failed ${job?.name} (${job?.id}):`, err.message);
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
      res.status(200).json({
        status: "ok",
        redis: "connected",
        evictionPolicy: evictionPolicy ?? "unknown",
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
  app.get("/projects/:id/stream", (req, res) => {
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
      res.write(": keepalive\n\n");
    }, 25000);

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
  });

  // Bull Board Dashboard (strictly protected behind Admin JWT auth)
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(investmentQueue)],
    serverAdapter,
  });
  app.use("/admin/queues", requireAdminMiddleware, serverAdapter.getRouter());

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
    await investmentQueue.close();
    await subRedis.quit();
    await commandRedis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Worker] Startup fatal error:", err);
  process.exit(1);
});
