import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST() {
  try {
    const cookieStore = await cookies();
    
    // Destroy the secure cookie
    cookieStore.delete("foundr_token");

    return NextResponse.json({ message: "Logged out successfully" }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: "Failed to log out" }, { status: 500 });
  }
}