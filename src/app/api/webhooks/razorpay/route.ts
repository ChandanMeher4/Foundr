import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import WebhookEvent from "@/models/WebhookEvent";
import { enqueuePaymentWebhook } from "@/lib/queue";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  RazorpayConfigError,
  assertWebhookTestConfig,
  verifyRazorpayWebhookSignature,
} from "@/lib/razorpay";

export async function POST(req: Request) {
  try {
    let webhookSecret: string;
    try {
      ({ webhookSecret } = assertWebhookTestConfig());
    } catch (err) {
      if (err instanceof RazorpayConfigError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      throw err;
    }

    const ip = getClientIp(req);
    const webhookLimit = await rateLimit({
      key: `webhook:ip:${ip}`,
      limit: 300,
      windowSeconds: 60,
      failClosed: false,
    });
    if (!webhookLimit.allowed) {
      return rateLimitResponse(300, webhookLimit);
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature")?.trim();
    if (
      !signature ||
      !verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret)
    ) {
      return NextResponse.json(
        { error: "Invalid or missing Razorpay webhook signature." },
        { status: 400 },
      );
    }

    const eventId = req.headers.get("x-razorpay-event-id")?.trim();
    if (!eventId) {
      return NextResponse.json(
        { error: "Missing x-razorpay-event-id header." },
        { status: 400 },
      );
    }

    let parsed: { event?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as { event?: unknown; [key: string]: unknown };
    } catch {
      return NextResponse.json(
        { error: "Invalid webhook JSON payload." },
        { status: 400 },
      );
    }

    const eventName =
      typeof parsed.event === "string" ? parsed.event.trim() : "";
    if (!eventName) {
      return NextResponse.json(
        { error: "Webhook payload missing event name." },
        { status: 400 },
      );
    }

    await dbConnect();

    try {
      await WebhookEvent.create({
        eventId,
        event: eventName,
        payload: parsed,
        receivedAt: new Date(),
        processedAt: null,
        attempts: 0,
      });
    } catch (dbErr: unknown) {
      const code =
        dbErr && typeof dbErr === "object" && "code" in dbErr
          ? (dbErr as { code?: unknown }).code
          : undefined;
      if (code === 11000) {
        return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
      }
      console.error("[Webhook Outbox Insert Error]:", dbErr);
      return NextResponse.json(
        { error: "Failed to persist webhook event." },
        { status: 500 },
      );
    }

    if (process.env.REDIS_URL) {
      try {
        await enqueuePaymentWebhook(eventId);
      } catch (queueErr) {
        // Outbox sweeper repairs missed Redis enqueues within minutes
        console.warn(
          `[Webhook Outbox WARNING] Enqueue failed for ${eventId}; sweeper will recover:`,
          queueErr instanceof Error ? queueErr.message : queueErr,
        );
      }
    }

    return NextResponse.json({ received: true, eventId }, { status: 200 });
  } catch (error) {
    console.error("Razorpay Webhook Error:", error);
    return NextResponse.json(
      { error: "Webhook handler error." },
      { status: 500 },
    );
  }
}
