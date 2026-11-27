import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { revalidatePath } from "next/cache";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { requireRole } from "@/lib/auth";
import { invalidateMarketplaceCache } from "@/lib/cache";
import { cancelLifecycleJobs, scheduleExpireListing } from "@/lib/queue";

const ALLOWED_STATUSES = [
  "Pending Review",
  "Live",
  "Funded",
  "Rejected",
  "Expired",
] as const;

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
      if (body.status === "Live") {
        update.approvedAt = new Date();
      }
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
      returnDocument: "after",
    });

    if (!updatedProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await invalidateMarketplaceCache();

    if (process.env.REDIS_URL && body.status !== undefined) {
      try {
        if (updatedProject.status === "Live" && updatedProject.approvedAt) {
          await scheduleExpireListing({
            projectId: id,
            approvedAt: new Date(updatedProject.approvedAt).toISOString(),
          });
        } else if (
          updatedProject.status === "Funded" ||
          updatedProject.status === "Rejected" ||
          updatedProject.status === "Expired"
        ) {
          await cancelLifecycleJobs(id);
        }
      } catch (queueErr) {
        console.error("[BullMQ Lifecycle Patch Error]:", queueErr);
      }
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
