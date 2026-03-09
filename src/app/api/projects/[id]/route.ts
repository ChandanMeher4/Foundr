import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import Project from '@/models/Project';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    
    // Await params in Next.js 15
    const resolvedParams = await params;
    const body = await request.json();
    
    // Find the project and update it with the new status/verification
    const updatedProject = await Project.findByIdAndUpdate(
      resolvedParams.id,
      { 
        status: body.status,
        isVerified: body.isVerified 
      },
      { new: true } // Returns the updated document
    );

    if (!updatedProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json(updatedProject);
  } catch (error) {
    console.error("Update Error:", error);
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}