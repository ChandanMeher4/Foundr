import { NextResponse } from "next/server";
import dbConnect from "@/lib/db"; 
import User from "@/models/User";
import { SignJWT } from "jose"; 
import { cookies } from "next/headers";

export async function POST(req: Request) {
  try {
    await dbConnect();
    const { email, otp } = await req.json();

    // 1. Find the user with the matching email and valid OTP
    const user = await User.findOne({ 
      email, 
      otp, 
      otpExpiry: { $gt: new Date() } 
    });

    if (!user) {
      return NextResponse.json({ error: "Invalid or expired OTP." }, { status: 400 });
    }

    // 2. Clear OTP after successful use so a hacker can't reuse it
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();

    // 3. Generate the Secure JWT Token
    const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");
    
    const token = await new SignJWT({ 
      id: user._id.toString(), 
      role: user.role, 
      name: user.name 
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d") 
      .sign(SECRET);

    // 4. Set the HTTP-Only Cookie (This actually logs them in!)
    const cookieStore = await cookies();
    cookieStore.set("foundr_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24 * 7, 
      path: "/",
    });
    
    return NextResponse.json(
      { message: "Login successful!", role: user.role }, 
      { status: 200 }
    );

  } catch (error: any) {
    console.error("OTP Verification Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during verification." }, 
      { status: 500 }
    );
  }
}