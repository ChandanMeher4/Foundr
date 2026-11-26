import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { requireRole, revokeAllUserSessions } from "@/lib/auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }

    await dbConnect();
    const user = await User.findById(id).select("_id email role").lean();
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const tokensValidAfter = await revokeAllUserSessions(id);

    return NextResponse.json({
      message: "All user sessions revoked successfully.",
      userId: id,
      tokensValidAfter,
    });
  } catch (error) {
    console.error("Revoke Sessions Error:", error);
    return NextResponse.json(
      { error: "Failed to revoke user sessions" },
      { status: 500 },
    );
  }
}
