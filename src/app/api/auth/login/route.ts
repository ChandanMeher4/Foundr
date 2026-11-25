import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { signSessionToken, setSessionCookie, type UserRole } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    await dbConnect();
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 },
      );
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    const jwt = await signSessionToken({
      id: user._id.toString(),
      role: user.role as UserRole,
      name: user.name,
      city: user.city,
    });

    await setSessionCookie(jwt);

    return NextResponse.json({
      message: "Logged in successfully",
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        city: user.city,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Login Error:", msg);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
