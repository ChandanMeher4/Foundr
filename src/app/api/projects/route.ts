import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import "@/models/User";
import { requireRole } from "@/lib/auth";
import { scheduleReviewReminder } from "@/lib/queue";

export async function GET() {
  try {
    await dbConnect();

    const projects = await Project.find({ status: { $in: ["Live", "Funded"] } })
      .populate("developerName", "name")
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json(projects);
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : "Unknown error";
    console.error("Fetch Marketplace Data Error:", details);
    return NextResponse.json(
      { error: "Failed to fetch marketplace data", details },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["Developer", "Admin"]);
    if (auth.response) return auth.response;

    const body = await req.json();
    const totalValuation = Number(body.totalValuation);
    const minInvestment = Number(body.minInvestment);
    const coords = body.location?.coordinates;
    const address = typeof body.location?.address === "string" ? body.location.address.trim() : "";
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls.filter((u: unknown) => typeof u === "string" && u.trim().length > 0)
      : [];

    if (
      !body.title ||
      !body.description ||
      !address ||
      !Array.isArray(coords) ||
      coords.length !== 2 ||
      !Number.isFinite(totalValuation) ||
      totalValuation <= 0 ||
      !Number.isFinite(minInvestment) ||
      minInvestment <= 0 ||
      minInvestment > totalValuation ||
      imageUrls.length === 0
    ) {
      return NextResponse.json(
        { error: "Invalid project details. Check valuation, minimum investment, location, and images." },
        { status: 400 },
      );
    }

    await dbConnect();

    const newProject = await Project.create({
      title: String(body.title).trim(),
      description: String(body.description).trim(),
      developerName: auth.session.id,
      location: {
        type: "Point",
        coordinates: [Number(coords[0]), Number(coords[1])],
        address,
      },
      category: body.category,
      constructionStage: body.constructionStage,
      totalValuation,
      minInvestment,
      expectedCompletion: body.expectedCompletion,
      imageUrls,
      status: "Pending Review",
    });

    if (process.env.REDIS_URL) {
      try {
        await scheduleReviewReminder(newProject._id.toString());
      } catch (queueErr) {
        console.error("[BullMQ Review Reminder Error]:", queueErr);
      }
    }

    return NextResponse.json(
      { message: "Project submitted successfully", project: newProject },
      { status: 201 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Submission Error:", msg);
    return NextResponse.json(
      { error: "Failed to submit project. Please check your data." },
      { status: 500 },
    );
  }
}
