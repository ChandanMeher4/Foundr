import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: Request) {
  try {
    await dbConnect();
    const { email } = await req.json();

    const user = await User.findOne({ email });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); 

    user.otp = otp;
    user.otpExpiry = expiry;
    await user.save();

    // Send the email
    await resend.emails.send({
      from: 'Foundr Auth <onboarding@resend.dev>',
      to: email, 
      subject: `Your Login Code: ${otp}`,
      html: `<h2>Your Foundr Login Code is: <strong>${otp}</strong></h2><p>This code expires in 10 minutes.</p>`
    });

    return NextResponse.json({ message: "OTP sent successfully" });
  } catch (error) {
    return NextResponse.json({ error: "Failed to send OTP" }, { status: 500 });
  }
}