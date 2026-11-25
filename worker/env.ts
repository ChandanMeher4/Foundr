import fs from "node:fs";
import path from "node:path";

/**
 * Loads key=value pairs from .env.local (if present) into process.env
 * without overriding already-set platform variables (e.g. Railway/Render).
 */
export function loadLocalEnv(): void {
  const candidates = [".env.local", ".env"];
  for (const filename of candidates) {
    const filePath = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(filePath)) continue;

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;

      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

// Populate process.env on module evaluation so sibling imports (e.g. src/lib/db)
// see .env.local variables even when hoisted under ESM.
loadLocalEnv();

export function validateWorkerEnv(): { redisUrl: string } {
  loadLocalEnv();

  const required = ["MONGODB_URI", "JWT_SECRET", "REDIS_URL"] as const;
  for (const key of required) {
    if (!process.env[key] || process.env[key]!.trim().length === 0) {
      throw new Error(`Fatal: ${key} environment variable must be defined for worker.`);
    }
  }

  return { redisUrl: process.env.REDIS_URL! };
}
