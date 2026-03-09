import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Project from '@/models/Project';
// IMPORT THE USER MODEL HERE (even if you aren't using it directly)
import "@/models/User"; 

export async function GET() {
  try {
    await dbConnect();
    
    // If the error persists, temporarily remove .populate to see if data flows
    const projects = await Project.find({})
      .populate('developerName', 'name') 
      .sort({ createdAt: -1 });

    return NextResponse.json(projects);
  } catch (error: any) {
    console.error("ADMIN FETCH ERROR:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch admin data", details: error.message }, 
      { status: 500 }
    );
  }
}