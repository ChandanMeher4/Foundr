import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { revalidatePath } from "next/cache";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { requireRole } from "@/lib/auth";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRole("Admin");
    if (auth.response) return auth.response;

    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
    }

    await dbConnect();

    const deletedProject = await Project.findByIdAndDelete(id);
    if (!deletedProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    revalidatePath("/");
    revalidatePath(`/projects/${id}`);
    revalidatePath("/admin");
    revalidatePath("/developer");

    return NextResponse.json(
      { message: "Project deleted successfully", id },
      { status: 200 },
    );
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json(
      { error: "Failed to delete project" },
      { status: 500 },
    );
  }
}
