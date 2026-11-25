import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { sendAppEmail } from "@/lib/email";

export async function POST(req: Request) {
  try {
    await dbConnect();
    const body = await req.json();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    user.otp = otp;
    user.otpExpiry = expiry;
    await user.save();

    await sendAppEmail({
      from: "Foundr Auth <onboarding@resend.dev>",
      to: email,
      subject: `Your Login Code: ${otp}`,
      html: `<h2>Your Foundr Login Code is: <strong>${otp}</strong></h2><p>This code expires in 10 minutes.</p>`,
    });

    return NextResponse.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send OTP Error:", error);
    return NextResponse.json(
      { error: "Failed to send OTP" },
      { status: 500 },
    );
  }
}
