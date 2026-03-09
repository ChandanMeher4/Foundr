import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

export async function GET() {
  try {
    await dbConnect();

    //fetch projects that are approved and live
    const projects = await Project.find({ status: "Live" })
      .populate("developerName", "name")
      .lean();

    return NextResponse.json(projects);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch marketplace data" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("foundr_token")?.value;

    if (!token) {
      return NextResponse.json(
        { error: "Unauthorized. Please log in." },
        { status: 401 },
      );
    }

    const SECRET = new TextEncoder().encode(
      process.env.JWT_SECRET || "fallback_secret",
    );
    const { payload } = await jwtVerify(token, SECRET);

    // Parse the incoming form data
    const body = await req.json();

    await dbConnect();

    // Mold the data into the Mongoose Schema format
    const newProject = await Project.create({
      title: body.title,
      description: body.description,
      developerName: payload.id, 

      // Formatting for the 2dsphere index
      location: {
        type: "Point",
        coordinates: body.location.coordinates, 
        address: body.location.address,
      },

      category: body.category,
      constructionStage: body.constructionStage,
      totalValuation: body.totalValuation,
      minInvestment: body.minInvestment,
      expectedCompletion: body.expectedCompletion,

      imageUrls: body.imageUrls,
      status: "Pending Review", 
    });

    return NextResponse.json(
      { message: "Project submitted successfully", project: newProject },
      { status: 201 },
    );
  } catch (error: any) {
    console.error("Submission Error:", error.message);
    return NextResponse.json(
      { error: "Failed to submit project. Please check your data." },
      { status: 500 },
    );
  }
}
