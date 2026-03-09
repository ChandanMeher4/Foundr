import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import "@/models/Project"; // Required so Mongoose can populate the starred projects

// Helper function to securely get the user ID from the cookie
async function getUserIdFromToken() {
  const cookieStore = await cookies();
  const token = cookieStore.get("foundr_token")?.value;
  if (!token) return null;

  try {
    const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");
    const { payload } = await jwtVerify(token, SECRET);
    return payload.id; // Return the user's MongoDB _id
  } catch (error) {
    return null;
  }
}

// 1. GET: Fetch Profile & Starred Projects
export async function GET() {
  try {
    await dbConnect();
    const userId = await getUserIdFromToken();
    
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find the user and populate the projects they have starred
    const user = await User.findById(userId)
      .populate("starredProjects")
      .lean();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error: any) {
    console.error("Profile GET Error:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// 2. PATCH: Update User Settings (Like their City)
export async function PATCH(req: Request) {
  try {
    await dbConnect();
    const userId = await getUserIdFromToken();
    
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { city } = await req.json();

    if (!city) {
      return NextResponse.json({ error: "City is required" }, { status: 400 });
    }

    // Update the user's city in the database
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { city },
      { new: true } // Returns the updated document
    ).lean();

    return NextResponse.json({ 
      message: "Profile updated successfully", 
      user: updatedUser 
    });
  } catch (error: any) {
    console.error("Profile PATCH Error:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}