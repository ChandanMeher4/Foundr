import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import "@/models/User";
import { requireRole } from "@/lib/auth";

export async function GET() {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    await dbConnect();

    const projects = await Project.find({})
      .populate("developerName", "name")
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json(projects);
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : "Unknown error";
    console.error("ADMIN FETCH ERROR:", details);
    return NextResponse.json(
      { error: "Failed to fetch admin data", details },
      { status: 500 },
    );
  }
}
