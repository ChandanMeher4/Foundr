import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import dbConnect from "@/lib/db";
import User from "@/models/User";

export async function POST(req: Request) {
  try {
    // 1. Authenticate the User
    const cookieStore = await cookies();
    const token = cookieStore.get("foundr_token")?.value;
    
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");
    const { payload } = await jwtVerify(token, SECRET);
    const userId = payload.id;

    // 2. Get the Project ID from the request body
    const { projectId } = await req.json();
    if (!projectId) {
      return NextResponse.json({ error: "Project ID is required" }, { status: 400 });
    }

    await dbConnect();
    const user = await User.findById(userId);
    
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // 3. Toggle Logic: Check if the project is already starred
    const isAlreadyStarred = user.starredProjects.includes(projectId);

    if (isAlreadyStarred) {
      // If it's there, remove it ($pull)
      user.starredProjects.pull(projectId);
    } else {
      // If it's not there, add it ($push)
      user.starredProjects.push(projectId);
    }

    await user.save();

    return NextResponse.json({ 
      isStarred: !isAlreadyStarred, 
      message: !isAlreadyStarred ? "Added to Profile" : "Removed from Profile" 
    });

  } catch (error: any) {
    console.error("Starring Error:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}