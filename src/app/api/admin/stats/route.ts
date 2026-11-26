import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import PlatformStats from "@/models/PlatformStats";
import { requireRole } from "@/lib/auth";

export async function GET() {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    await dbConnect();
    const stats = await PlatformStats.findOne({ key: "latest" }).lean();

    return NextResponse.json({ stats: stats ?? null });
  } catch (error) {
    console.error("Admin Stats Fetch Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch platform statistics" },
      { status: 500 },
    );
  }
}
