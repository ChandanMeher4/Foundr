import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { getSession } from "@/lib/auth";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { recordTrendingEvent } from "@/lib/trending";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ip = getClientIp(req);
    const viewLimit = await rateLimit({
      key: `view:ip:${ip}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!viewLimit.allowed) {
      return rateLimitResponse(60, viewLimit);
    }

    const { id: projectId } = await params;
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return NextResponse.json(
        { error: "Invalid project ID." },
        { status: 400 },
      );
    }

    await dbConnect();
    const project = await Project.findById(projectId)
      .select("status")
      .lean<{ status?: string } | null>();

    if (!project) {
      return NextResponse.json(
        { error: "Project not found." },
        { status: 404 },
      );
    }

    if (project.status !== "Live") {
      return new NextResponse(null, { status: 204 });
    }

    const session = await getSession();
    const viewerKey = session?.id || ip;

    await recordTrendingEvent({
      type: "view",
      projectId,
      viewerKey,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("View Beacon Error:", error);
    return NextResponse.json(
      { error: "Failed to record view." },
      { status: 500 },
    );
  }
}
