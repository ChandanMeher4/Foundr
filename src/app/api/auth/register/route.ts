import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import bcrypt from "bcryptjs";
import { signSessionToken, setSessionCookie } from "@/lib/auth";

const PUBLIC_ROLES = ["Investor", "Developer"] as const;
type PublicRole = (typeof PUBLIC_ROLES)[number];

export async function POST(req: Request) {
  try {
    await dbConnect();

    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const city = typeof body.city === "string" && body.city.trim() ? body.city.trim() : "Bengaluru";
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
    const requestedRole = body.role ?? "Investor";

    if (!name || !email || password.length < 8) {
      return NextResponse.json(
        { error: "Valid name, email, and password (min 8 chars) are required." },
        { status: 400 },
      );
    }

    if (!PUBLIC_ROLES.includes(requestedRole as PublicRole)) {
      return NextResponse.json(
        { error: "Invalid account type specified." },
        { status: 400 },
      );
    }

    const role = requestedRole as PublicRole;

    const existingUser = await User.findOne({ email });
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
      email,
      password: hashedPassword,
      role,
      city,
      companyName: role === "Developer" ? companyName : undefined,
    });

    const token = await signSessionToken({
      id: newUser._id.toString(),
      role,
      name: newUser.name,
      city: newUser.city,
    });

    await setSessionCookie(token);

    return NextResponse.json(
      { message: "Account created successfully!", role: newUser.role },
      { status: 201 },
    );
  } catch (error: unknown) {
    console.error("Signup Error:", error);
    return NextResponse.json(
      { error: "Failed to create account. Please try again." },
      { status: 500 },
    );
  }
}
