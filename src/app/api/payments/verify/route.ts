import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Payment from "@/models/Payment";
import { requireRole } from "@/lib/auth";
import { transitionPaymentStatus } from "@/lib/payments";
import { enqueuePaymentFinalize } from "@/lib/queue";
import {
  RazorpayConfigError,
  getRazorpayClient,
  verifyRazorpayCheckoutSignature,
} from "@/lib/razorpay";

export async function POST(req: Request) {
  try {
    const auth = await requireRole("Investor");
    if (auth.response) return auth.response;

    try {
      getRazorpayClient();
    } catch (err) {
      if (err instanceof RazorpayConfigError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      throw err;
    }

    const body = (await req.json().catch(() => ({}))) as {
      orderId?: unknown;
      paymentId?: unknown;
      signature?: unknown;
    };

    const orderId =
      typeof body.orderId === "string" ? body.orderId.trim() : "";
    const paymentId =
      typeof body.paymentId === "string" ? body.paymentId.trim() : "";
    const signature =
      typeof body.signature === "string" ? body.signature.trim() : "";

    if (!orderId || !paymentId || !signature) {
      return NextResponse.json(
        { error: "orderId, paymentId, and signature are required." },
        { status: 400 },
      );
    }

    if (
      !verifyRazorpayCheckoutSignature({
        orderId,
        paymentId,
        signature,
      })
    ) {
      return NextResponse.json(
        { error: "Invalid payment signature." },
        { status: 400 },
      );
    }

    await dbConnect();

    const payment = await Payment.findOne({ orderId }).lean<{
      reservationId: string;
      orderId: string;
      userId: { toString(): string };
      amountPaise: number;
      status: string;
    } | null>();

    if (!payment) {
      return NextResponse.json(
        { error: "Payment order not found." },
        { status: 404 },
      );
    }

    if (payment.userId.toString() !== auth.session.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const updated = await transitionPaymentStatus({
      reservationId: payment.reservationId,
      to: "authorized",
      setFields: { paymentId },
      logContext: "client_verify",
    });

    if (process.env.REDIS_URL) {
      try {
        await enqueuePaymentFinalize({
          reservationId: payment.reservationId,
          orderId,
          paymentId,
        });
      } catch (queueErr) {
        console.warn(
          "[Payments Verify WARNING] Could not enqueue finalize:",
          queueErr instanceof Error ? queueErr.message : queueErr,
        );
      }
    }

    return NextResponse.json({
      verified: true,
      reservationId: payment.reservationId,
      status: updated?.status ?? payment.status,
    });
  } catch (error) {
    console.error("Verify Payment Error:", error);
    return NextResponse.json(
      { error: "Failed to verify payment signature." },
      { status: 500 },
    );
  }
}
