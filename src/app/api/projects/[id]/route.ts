import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { revalidatePath } from "next/cache";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { requireRole } from "@/lib/auth";

const ALLOWED_STATUSES = ["Pending Review", "Live", "Funded", "Rejected"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    const body = await request.json();
    const update: Record<string, unknown> = {};

    if (body.status !== undefined) {
      if (!ALLOWED_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: "Invalid project status" }, { status: 400 });
      }
      update.status = body.status;
    }

    if (body.isVerified !== undefined) {
      if (typeof body.isVerified !== "boolean") {
        return NextResponse.json({ error: "isVerified must be a boolean" }, { status: 400 });
      }
      update.isVerified = body.isVerified;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: "No valid fields provided for update" },
        { status: 400 },
      );
    }

    await dbConnect();

    const updatedProject = await Project.findByIdAndUpdate(id, update, {
      new: true,
    });

    if (!updatedProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    revalidatePath("/");
    revalidatePath(`/projects/${id}`);
    revalidatePath("/admin");
    revalidatePath("/developer");

    return NextResponse.json(updatedProject);
  } catch (error) {
    console.error("Update Error:", error);
    return NextResponse.json(
      { error: "Failed to update project" },
      { status: 500 },
    );
  }
}
