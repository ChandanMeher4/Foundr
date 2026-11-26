import crypto from "node:crypto";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import User from "@/models/User";
import { sendAppEmail } from "@/lib/email";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { computeOtpHmac, storeHashedOtp } from "@/lib/otp";

const GENERIC_OTP_RESPONSE = {
  message: "If an account exists for that email, a login code has been sent.",
};

export async function POST(req: Request) {
  if (process.env.OTP_LOGIN_ENABLED !== "true") {
    return NextResponse.json(
      { error: "OTP login is disabled" },
      { status: 404 },
    );
  }

  try {
    const ip = getClientIp(req);
    const ipLimit = await rateLimit({
      key: `otp-send:ip:${ip}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!ipLimit.allowed) {
      return rateLimitResponse(10, ipLimit);
    }

    const body = await req.json();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const emailLimit = await rateLimit({
      key: `otp-send:email:${email}`,
      limit: 3,
      windowSeconds: 900,
    });
    if (!emailLimit.allowed) {
      return rateLimitResponse(3, emailLimit);
    }

    await dbConnect();
    const user = await User.findOne({ email }).select("_id email").lean();

    const otp = crypto.randomInt(100000, 1000000).toString();
    // Always compute HMAC regardless of user existence to keep response timing uniform
    computeOtpHmac(email, otp);

    if (user) {
      try {
        await storeHashedOtp(email, otp);
        await sendAppEmail({
          from: "Foundr Auth <onboarding@resend.dev>",
          to: email,
          subject: `Your Login Code: ${otp}`,
          html: `<h2>Your Foundr Login Code is: <strong>${otp}</strong></h2><p>This code expires in 10 minutes.</p>`,
        });
      } catch (dispatchErr) {
        console.error("[OTP Send] Failed to store or email code:", dispatchErr);
      }
    }

    return NextResponse.json(GENERIC_OTP_RESPONSE, { status: 200 });
  } catch (error) {
    console.error("Send OTP Error:", error);
    return NextResponse.json(
      { error: "Failed to process OTP request" },
      { status: 500 },
    );
  }
}
