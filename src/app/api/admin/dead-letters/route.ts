import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import DeadLetter from "@/models/DeadLetter";
import { requireRole } from "@/lib/auth";

export async function GET() {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    await dbConnect();

    const deadLetters = await DeadLetter.find({ status: "open" })
      .sort({ failedAt: -1 })
      .limit(50)
      .lean();

    return NextResponse.json({ deadLetters });
  } catch (error) {
    console.error("Admin Dead Letters Fetch Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dead letters." },
      { status: 500 },
    );
  }
}
