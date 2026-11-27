import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const cookieAls = new AsyncLocalStorage<{ token?: string }>();

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

import dbConnect from "../src/lib/db";
import { getRedisConnection } from "../src/lib/redis";
import { signSessionToken } from "../src/lib/auth-core";
import { revokeTokenJti } from "../src/lib/revocation";
import { verifySessionToken } from "../src/lib/auth-core";
import { getUserStarredIds } from "../src/lib/stars";
import User from "../src/models/User";
import Project from "../src/models/Project";
import { GET as starGet, POST as starPost } from "../src/app/api/user/star/route";

function runWithToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cookieAls.run({ token }, fn);
}

describe("Project Star Persistence (SC-15 / KI-018)", () => {
  const createdUserIds: string[] = [];
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    const conn = await dbConnect();
    const dbName = conn.connection.db?.databaseName || "";
    expect(dbName.endsWith("_test")).toBe(true);
  });

  afterAll(async () => {
    await dbConnect();
    if (createdProjectIds.length > 0) {
      await Project.deleteMany({ _id: { $in: createdProjectIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }

    if (process.env.REDIS_URL) {
      const redis = getRedisConnection();
      let cursor = "0";
      const keysToDelete: string[] = [];
      do {
        const [nextCursor, batch] = await redis.scan(
          cursor,
          "MATCH",
          "test:*",
          "COUNT",
          100,
        );
        cursor = nextCursor;
        keysToDelete.push(...batch);
      } while (cursor !== "0");
      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
      await redis.quit();
    }

    await mongoose.disconnect();
  });

  it("rejects unauthenticated requests, persists starred IDs across reloads, and respects session revocation", async () => {
    const suffix = crypto.randomBytes(4).toString("hex");
    const dev = await User.create({
      name: "Star Test Dev",
      email: `star-dev-${suffix}@foundr.local`,
      password: "placeholder_password_hash",
      role: "Developer",
      city: "Bengaluru",
    });
    createdUserIds.push(dev._id.toString());

    const investor = await User.create({
      name: "Star Test Investor",
      email: `star-inv-${suffix}@foundr.local`,
      password: "placeholder_password_hash",
      role: "Investor",
      city: "Mumbai",
    });
    createdUserIds.push(investor._id.toString());

    const project = await Project.create({
      title: "Starred Tower",
      description: "Star persistence integration project.",
      developerName: dev._id,
      location: { type: "Point", coordinates: [77.59, 12.97], address: "Bengaluru" },
      category: "Commercial",
      totalValuation: 1_000_000,
      minInvestment: 100_000,
      expectedCompletion: new Date("2028-01-01"),
      imageUrls: ["https://placehold.co/600x400"],
      status: "Live",
    });
    const projectId = project._id.toString();
    createdProjectIds.push(projectId);

    // 1. Logged-out callers are rejected with 401 on GET and POST
    const unauthGet = await runWithToken(undefined, () => starGet());
    expect(unauthGet.status).toBe(401);

    const unauthPost = await runWithToken(undefined, () =>
      starPost(
        new Request("http://localhost/api/user/star", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }),
      ),
    );
    expect(unauthPost.status).toBe(401);

    // 2. Authenticated investor starts with empty starred list
    const token = await signSessionToken({
      id: investor._id.toString(),
      role: "Investor",
      name: investor.name,
      city: investor.city,
    });

    const initialGet = await runWithToken(token, () => starGet());
    expect(initialGet.status).toBe(200);
    expect(await initialGet.json()).toEqual({ starredIds: [] });

    // 3. Starring persists in MongoDB and returns on subsequent GET (page refresh hydration)
    const starRes = await runWithToken(token, () =>
      starPost(
        new Request("http://localhost/api/user/star", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }),
      ),
    );
    expect(starRes.status).toBe(200);
    expect(await starRes.json()).toEqual({
      isStarred: true,
      message: "Added to Profile",
    });

    const afterReloadGet = await runWithToken(token, () => starGet());
    expect(afterReloadGet.status).toBe(200);
    expect(await afterReloadGet.json()).toEqual({ starredIds: [projectId] });
    expect(await getUserStarredIds(investor._id.toString())).toEqual([projectId]);

    // 4. Toggling again removes bookmark cleanly
    const unstarRes = await runWithToken(token, () =>
      starPost(
        new Request("http://localhost/api/user/star", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }),
      ),
    );
    expect(unstarRes.status).toBe(200);
    expect(await unstarRes.json()).toEqual({
      isStarred: false,
      message: "Removed from Profile",
    });
    expect(await getUserStarredIds(investor._id.toString())).toEqual([]);

    // 5. Revoked token is rejected on GET /api/user/star
    const claims = await verifySessionToken(token);
    await revokeTokenJti(claims.jti, 60);
    const revokedGet = await runWithToken(token, () => starGet());
    expect(revokedGet.status).toBe(401);
  });
});
