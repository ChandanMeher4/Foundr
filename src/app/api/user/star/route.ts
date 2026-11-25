import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { requireRole } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const auth = await requireRole();
    if (auth.response) return auth.response;

    const { projectId } = await req.json();
    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return NextResponse.json(
        { error: "Valid Project ID is required" },
        { status: 400 },
      );
    }

    await dbConnect();
    const user = await User.findById(auth.session.id);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const isAlreadyStarred = user.starredProjects.some(
      (id: mongoose.Types.ObjectId) => id.toString() === projectId,
    );

    if (isAlreadyStarred) {
      user.starredProjects.pull(projectId);
    } else {
      user.starredProjects.push(projectId);
    }

    await user.save();

    return NextResponse.json({
      isStarred: !isAlreadyStarred,
      message: !isAlreadyStarred ? "Added to Profile" : "Removed from Profile",
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Starring Error:", msg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
