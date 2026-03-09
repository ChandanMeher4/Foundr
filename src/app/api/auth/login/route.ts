import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { cookies } from "next/headers";
import dbConnect from "@/lib/db";
import User from "@/models/User";

export async function POST(req: Request) {
  try {
    await dbConnect();
    const { email, password } = await req.json();

    // 1. Validate input
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // 3. Verify the password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // 4. Create the JWT Payload
    const secret = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");
    const alg = "HS256";
    
    const jwt = await new SignJWT({ 
      id: user._id.toString(), 
      role: user.role, 
      city: user.city 
    })
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime("7d") 
      .sign(secret);

    // 5. Set the HTTP-Only Cookie
    const cookieStore = await cookies();
    cookieStore.set("foundr_token", jwt, {
      httpOnly: true, 
      secure: process.env.NODE_ENV === "production", 
      sameSite: "strict", 
      maxAge: 60 * 60 * 24 * 7, 
      path: "/",
    });

    // 6. Return success
    return NextResponse.json({
      message: "Logged in successfully",
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        city: user.city
      }
    });

  } catch (error: any) {
    console.error("Login Error:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}