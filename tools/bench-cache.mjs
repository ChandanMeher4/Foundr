import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Redis from "ioredis";

function loadEnvLocal() {
  const vars = {};
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return vars;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k) vars[k] = v;
  }
  return vars;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, Math.min(idx, sorted.length - 1))].toFixed(2));
}

async function waitForServer(baseUrl) {
  for (let i = 0; i < 60; i++) {
    try {
      // Probe /login HTML route so we do not warm /api/projects before measurement starts
      const res = await fetch(`${baseUrl}/login`);
      if (res.ok) return;
    } catch {
      // Wait for Next.js production server bind
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Next.js server at ${baseUrl}`);
}

async function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // already exited
    }
  } else {
    child.kill("SIGTERM");
  }
}

async function runBenchmarkPass(baseUrl, count) {
  const latencies = [];
  const xCacheCounts = {};
  let firstProjectId = null;

  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/api/projects`);
    const body = await res.json();
    const dt = performance.now() - t0;

    if (!res.ok) {
      throw new Error(`GET /api/projects returned ${res.status}`);
    }
    const header = res.headers.get("X-Cache") || "NONE";
    xCacheCounts[header] = (xCacheCounts[header] || 0) + 1;
    latencies.push(dt);

    if (!firstProjectId && Array.isArray(body)) {
      const live = body.find((p) => p.status === "Live" && p._id);
      if (live?._id) firstProjectId = live._id;
    }
  }

  return { latencies, xCacheCounts, firstProjectId };
}

async function main() {
  const nextBuildDir = path.resolve(process.cwd(), ".next");
  if (!fs.existsSync(nextBuildDir)) {
    throw new Error("Missing .next production build. Run `npm run build` first.");
  }

  const envLocal = loadEnvLocal();
  const baseEnv = { ...envLocal, ...process.env };
  const iterations = Number(process.env.BENCH_ITERATIONS || 15);
  const port = Number(process.env.BENCH_PORT || 3099);
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBin = process.platform === "win32" ? "npx.cmd" : "npx";

  let child;

  // 1. Cold benchmark with CACHE_DISABLED=true
  let coldSummary;
  try {
    child = spawn(`${nextBin} next start -p ${port}`, {
      cwd: process.cwd(),
      env: { ...baseEnv, CACHE_DISABLED: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    await waitForServer(baseUrl);
    const cold = await runBenchmarkPass(baseUrl, iterations);
    const sortedCold = [...cold.latencies].sort((a, b) => a - b);
    coldSummary = {
      p50: percentile(sortedCold, 50),
      p95: percentile(sortedCold, 95),
      xCacheCounts: cold.xCacheCounts,
    };
  } finally {
    await stopChild(child);
    child = undefined;
  }

  // Delete marketplace cache key before warm pass so call 1 = MISS and calls 2..N = HIT
  const redisUrl = baseEnv.REDIS_URL;
  const prefix = baseEnv.REDIS_KEY_PREFIX || "";
  if (redisUrl) {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    await redis.del(`${prefix}cache:v1:marketplace:projects`).catch(() => {});
    await redis.quit().catch(() => {});
  }

  // 2. Warm benchmark with CACHE_DISABLED=false (+ AI MISS vs HIT if GROQ_API_KEY configured)
  let warmSummary;
  let aiSummary;

  try {
    child = spawn(`${nextBin} next start -p ${port}`, {
      cwd: process.cwd(),
      env: { ...baseEnv, CACHE_DISABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    await waitForServer(baseUrl);

    const tPrime0 = performance.now();
    const primeRes = await fetch(`${baseUrl}/api/projects`);
    await primeRes.json();
    const primingMissMs = Number((performance.now() - tPrime0).toFixed(2));
    const primeHeader = primeRes.headers.get("X-Cache") || "NONE";

    const warm = await runBenchmarkPass(baseUrl, iterations);
    const sortedWarm = [...warm.latencies].sort((a, b) => a - b);
    const allCounts = {
      [primeHeader]: (warm.xCacheCounts[primeHeader] || 0) + 1,
    };
    for (const [k, v] of Object.entries(warm.xCacheCounts)) {
      if (k !== primeHeader) allCounts[k] = v;
    }

    const totalReqs = iterations + 1;
    const hitCount = allCounts.HIT || 0;
    warmSummary = {
      primingMissMs,
      p50Hit: percentile(sortedWarm, 50),
      p95Hit: percentile(sortedWarm, 95),
      xCacheCounts: allCounts,
      hitRatio: Number((hitCount / totalReqs).toFixed(3)),
    };

    const groqKey = baseEnv.GROQ_API_KEY?.trim();
    if (!groqKey || !warm.firstProjectId) {
      aiSummary = {
        skipped: true,
        reason: !groqKey ? "GROQ_API_KEY not configured" : "No Live project found",
      };
    } else {
      if (redisUrl) {
        const redis = new Redis(redisUrl, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });
        let cursor = "0";
        const keysToDel = [];
        do {
          const [nextCursor, batch] = await redis.scan(
            cursor,
            "MATCH",
            `${prefix}cache:v1:ai:${warm.firstProjectId}:*`,
            "COUNT",
            50,
          );
          cursor = nextCursor;
          keysToDel.push(...batch);
        } while (cursor !== "0");
        if (keysToDel.length > 0) await redis.del(...keysToDel);
        await redis.quit().catch(() => {});
      }

      const tAiMiss = performance.now();
      const missAiRes = await fetch(`${baseUrl}/api/ai/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: warm.firstProjectId }),
      });
      await missAiRes.json();
      const missMs = Number((performance.now() - tAiMiss).toFixed(2));
      const missHeader = missAiRes.headers.get("X-Cache") || "NONE";

      const tAiHit = performance.now();
      const hitAiRes = await fetch(`${baseUrl}/api/ai/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: warm.firstProjectId }),
      });
      await hitAiRes.json();
      const hitMs = Number((performance.now() - tAiHit).toFixed(2));
      const hitHeader = hitAiRes.headers.get("X-Cache") || "NONE";

      aiSummary = {
        skipped: false,
        missStatus: missAiRes.status,
        missMs,
        missHeader,
        hitStatus: hitAiRes.status,
        hitMs,
        hitHeader,
      };
    }
  } finally {
    await stopChild(child);
  }

  console.log(
    JSON.stringify(
      {
        conditions:
          "Local Next.js production build (`npm start`) connecting to remote MongoDB Atlas and Redis Cloud",
        iterationsPerPass: iterations,
        marketplaceCold: coldSummary,
        marketplaceWarm: warmSummary,
        aiAnalysis: aiSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
