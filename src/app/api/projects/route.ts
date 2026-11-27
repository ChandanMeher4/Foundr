import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import "@/models/User";
import { requireRole } from "@/lib/auth";
import {
  MARKETPLACE_CACHE_TTL_SECONDS,
  MARKETPLACE_PROJECTS_CACHE_KEY,
  getJson,
  isCacheDisabled,
  setJson,
} from "@/lib/cache";
import { scheduleReviewReminder } from "@/lib/queue";
import { getTrendingProjectScores } from "@/lib/trending";

interface MarketplaceProjectRecord {
  _id: { toString(): string } | string;
  status: string;
  [key: string]: unknown;
}

export async function GET(req?: Request) {
  try {
    const sort = req ? new URL(req.url).searchParams.get("sort") : null;
    const cacheDisabled = isCacheDisabled();
    let xCache: "HIT" | "MISS" | "BYPASS" = cacheDisabled ? "BYPASS" : "MISS";

    let projects: MarketplaceProjectRecord[] | null = null;
    if (!cacheDisabled) {
      projects = await getJson<MarketplaceProjectRecord[]>(
        MARKETPLACE_PROJECTS_CACHE_KEY,
      );
      if (projects !== null) {
        xCache = "HIT";
      }
    }

    if (projects === null) {
      await dbConnect();
      projects = (await Project.find({ status: { $in: ["Live", "Funded"] } })
        .populate("developerName", "name")
        .sort({ createdAt: -1 })
        .lean()) as unknown as MarketplaceProjectRecord[];

      if (!cacheDisabled) {
        await setJson(
          MARKETPLACE_PROJECTS_CACHE_KEY,
          projects,
          MARKETPLACE_CACHE_TTL_SECONDS,
        );
      }
    }

    if (sort === "trending") {
      const liveProjects = projects.filter((p) => p.status === "Live");
      const trendingScores = await getTrendingProjectScores();
      const scoreMap = new Map(
        trendingScores.map((entry) => [entry.projectId, entry.score]),
      );

      const scored: MarketplaceProjectRecord[] = [];
      const unscored: MarketplaceProjectRecord[] = [];

      for (const project of liveProjects) {
        const score = scoreMap.get(String(project._id)) ?? 0;
        if (score > 0) {
          scored.push({ ...project, trendingScore: score });
        } else {
          unscored.push(project);
        }
      }

      scored.sort(
        (a, b) =>
          Number(b.trendingScore ?? 0) - Number(a.trendingScore ?? 0),
      );

      return NextResponse.json([...scored, ...unscored], {
        headers: { "X-Cache": xCache },
      });
    }

    return NextResponse.json(projects, {
      headers: { "X-Cache": xCache },
    });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : "Unknown error";
    console.error("Fetch Marketplace Data Error:", details);
    return NextResponse.json(
      { error: "Failed to fetch marketplace data", details },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["Developer", "Admin"]);
    if (auth.response) return auth.response;

    const body = await req.json();
    const totalValuation = Number(body.totalValuation);
    const minInvestment = Number(body.minInvestment);
    const coords = body.location?.coordinates;
    const address = typeof body.location?.address === "string" ? body.location.address.trim() : "";
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls.filter((u: unknown) => typeof u === "string" && u.trim().length > 0)
      : [];

    if (
      !body.title ||
      !body.description ||
      !address ||
      !Array.isArray(coords) ||
      coords.length !== 2 ||
      !Number.isFinite(totalValuation) ||
      totalValuation <= 0 ||
      !Number.isFinite(minInvestment) ||
      minInvestment <= 0 ||
      minInvestment > totalValuation ||
      imageUrls.length === 0
    ) {
      return NextResponse.json(
        { error: "Invalid project details. Check valuation, minimum investment, location, and images." },
        { status: 400 },
      );
    }

    await dbConnect();

    const newProject = await Project.create({
      title: String(body.title).trim(),
      description: String(body.description).trim(),
      developerName: auth.session.id,
      location: {
        type: "Point",
        coordinates: [Number(coords[0]), Number(coords[1])],
        address,
      },
      category: body.category,
      constructionStage: body.constructionStage,
      totalValuation,
      minInvestment,
      expectedCompletion: body.expectedCompletion,
      imageUrls,
      status: "Pending Review",
    });

    if (process.env.REDIS_URL) {
      try {
        await scheduleReviewReminder(newProject._id.toString());
      } catch (queueErr) {
        console.error("[BullMQ Review Reminder Error]:", queueErr);
      }
    }

    return NextResponse.json(
      { message: "Project submitted successfully", project: newProject },
      { status: 201 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Submission Error:", msg);
    return NextResponse.json(
      { error: "Failed to submit project. Please check your data." },
      { status: 500 },
    );
  }
}
