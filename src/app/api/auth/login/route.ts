import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { signSessionToken, setSessionCookie, type UserRole } from "@/lib/auth";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const ipLimit = await rateLimit({
      key: `login:ip:${ip}`,
      limit: 20,
      windowSeconds: 900,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(20, ipLimit);
    }

    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 },
      );
    }

    const acctLimit = await rateLimit({
      key: `login:acct:${ip}:${email}`,
      limit: 5,
      windowSeconds: 900,
    });
    if (!acctLimit.allowed) {
      return rateLimitResponse(5, acctLimit);
    }

    await dbConnect();

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
