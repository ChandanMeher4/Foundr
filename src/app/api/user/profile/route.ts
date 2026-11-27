import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Payment from "@/models/Payment";
import User from "@/models/User";
import "@/models/Project";
import { requireRole } from "@/lib/auth";

export async function GET() {
  try {
    const auth = await requireRole();
    if (auth.response) return auth.response;

    await dbConnect();

    const [user, payments] = await Promise.all([
      User.findById(auth.session.id).populate("starredProjects").lean(),
      Payment.find({ userId: auth.session.id })
        .populate("projectId", "title category status")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ user, payments });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Profile GET Error:", msg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireRole();
    if (auth.response) return auth.response;

    const body = await req.json();
    const city = typeof body.city === "string" ? body.city.trim() : "";

    if (!city) {
      return NextResponse.json({ error: "City is required" }, { status: 400 });
    }

    await dbConnect();

    const updatedUser = await User.findByIdAndUpdate(
      auth.session.id,
      { city },
      { new: true },
    ).lean();

    return NextResponse.json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Profile PATCH Error:", msg);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
