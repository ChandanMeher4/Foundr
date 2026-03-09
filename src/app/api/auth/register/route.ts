import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose"; // <-- NEW IMPORT
import { cookies } from "next/headers"; // <-- NEW IMPORT

export async function POST(req: Request) {
  try {
    await dbConnect();

    const { name, email, password, role, city, companyName } = await req.json();

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 400 },
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      role,
      city,
      companyName: role === "Developer" ? companyName : undefined,
    });

    // --- NEW LOGIC: INSTANT LOGIN ---
    const SECRET = new TextEncoder().encode(
      process.env.JWT_SECRET || "fallback_secret",
    );

    const token = await new SignJWT({
      id: newUser._id.toString(),
      role: newUser.role,
      name: newUser.name,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(SECRET);

    const cookieStore = await cookies();
    cookieStore.set("foundr_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });
    // ---------------------------------

    // Return the role so the frontend knows where to route them!
    return NextResponse.json(
      { message: "Account created successfully!", role: newUser.role },
      { status: 201 },
    );
  } catch (error: any) {
    console.error("Signup Error:", error);
    return NextResponse.json(
      { error: "Failed to create account. Please try again." },
      { status: 500 },
    );
  }
}
