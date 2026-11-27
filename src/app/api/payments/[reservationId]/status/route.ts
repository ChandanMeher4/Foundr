import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Payment from "@/models/Payment";
import { requireRole } from "@/lib/auth";
import { RazorpayConfigError, getRazorpayClient } from "@/lib/razorpay";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ reservationId: string }> },
) {
  try {
    const auth = await requireRole();
    if (auth.response) return auth.response;

    try {
      getRazorpayClient();
    } catch (err) {
      if (err instanceof RazorpayConfigError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      throw err;
    }

    const { reservationId } = await params;
    await dbConnect();

    const payment = await Payment.findOne({ reservationId })
      .select(
        "reservationId orderId paymentId projectId userId amountPaise currency status refundId lastError expiresAt createdAt updatedAt",
      )
      .lean<{
        reservationId: string;
        orderId: string;
        paymentId?: string;
        projectId: { toString(): string };
        userId: { toString(): string };
        amountPaise: number;
        currency?: string;
        status: string;
        refundId?: string;
        lastError?: string;
        expiresAt?: Date;
      } | null>();

    if (!payment) {
      return NextResponse.json(
        { error: "Payment record not found." },
        { status: 404 },
      );
    }

    if (payment.userId.toString() !== auth.session.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    return NextResponse.json({
      reservationId: payment.reservationId,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      projectId: payment.projectId.toString(),
      amountPaise: payment.amountPaise,
      currency: payment.currency || "INR",
      status: payment.status,
      refundId: payment.refundId,
      lastError: payment.lastError,
      expiresAt: payment.expiresAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Payment Status Fetch Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment status." },
      { status: 500 },
    );
  }
}
