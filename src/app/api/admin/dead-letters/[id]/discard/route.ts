import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/db";
import DeadLetter from "@/models/DeadLetter";
import { requireRole } from "@/lib/auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: "Invalid dead-letter ID." },
        { status: 400 },
      );
    }

    await dbConnect();

    const discarded = await DeadLetter.findOneAndUpdate(
      { _id: id, status: "open" },
      { $set: { status: "discarded" } },
      { returnDocument: "after" },
    ).lean<{ _id: mongoose.Types.ObjectId; status: string } | null>();

    if (!discarded) {
      const existing = await DeadLetter.findById(id)
        .select("status")
        .lean<{ status: string } | null>();
      if (!existing) {
        return NextResponse.json(
          { error: "Dead letter not found." },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          error: `Dead letter cannot be discarded (current status: ${existing.status}).`,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ discarded: true, id });
  } catch (error) {
    console.error("Dead Letter Discard Error:", error);
    return NextResponse.json(
      { error: "Failed to discard dead letter." },
      { status: 500 },
    );
  }
}
