import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { signSessionToken, setSessionCookie, type UserRole } from "@/lib/auth";

export async function POST(req: Request) {
  if (process.env.OTP_LOGIN_ENABLED !== "true") {
    return NextResponse.json(
      { error: "OTP login is disabled" },
      { status: 404 },
    );
  }

  try {
    await dbConnect();
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";

    if (!email || !otp) {
      return NextResponse.json(
        { error: "Email and OTP are required." },
        { status: 400 },
      );
    }

    const user = await User.findOne({
      email,
      otp,
      otpExpiry: { $gt: new Date() },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Invalid or expired OTP." },
        { status: 400 },
      );
    }

    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();

    const token = await signSessionToken({
      id: user._id.toString(),
      role: user.role as UserRole,
      name: user.name,
      city: user.city,
    });

    await setSessionCookie(token);

    return NextResponse.json(
      { message: "Login successful!", role: user.role },
      { status: 200 },
    );
  } catch (error: unknown) {
    console.error("OTP Verification Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during verification." },
      { status: 500 },
    );
  }
}
