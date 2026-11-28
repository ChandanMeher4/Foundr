import crypto from "node:crypto";
import Razorpay from "razorpay";

export const RAZORPAY_TEST_KEY_PREFIX = "rzp_test_";
const DEFAULT_RESERVATION_TTL_MINUTES = 15;
const DEMO_RESERVATION_TTL_MS = 30 * 1000;

export interface RazorpayOrderCreateInput {
  amount: number;
  currency: "INR";
  receipt: string;
  notes?: Record<string, string>;
  payment?: {
    capture: "automatic" | "manual";
    capture_options?: {
      automatic_expiry_period: number;
      manual_expiry_period: number;
      refund_speed: "optimum" | "normal";
    };
  };
}

export interface RazorpayOrderSummary {
  id: string;
  status: string;
  amount: number;
  amount_paid?: number;
  currency?: string;
  receipt?: string;
}

export interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  currency?: string;
  captured?: boolean;
  error_description?: string | null;
}

export interface RazorpayOrderPaymentItem extends Partial<RazorpayPaymentEntity> {
  id: string;
  status: string;
  amount: number;
}

export interface RazorpayRefundResult {
  id: string;
  payment_id?: string;
  amount?: number;
  status?: string;
}

export interface RazorpayClientLike {
  orders: {
    create(params: RazorpayOrderCreateInput): Promise<RazorpayOrderSummary>;
    fetch(orderId: string): Promise<RazorpayOrderSummary>;
    fetchPayments: (orderId: string) => Promise<{
      items?: RazorpayOrderPaymentItem[];
    }>;
  };
  payments: {
    fetch: (paymentId: string) => Promise<RazorpayPaymentEntity>;
    refund(
      paymentId: string,
      params?: { amount?: number; notes?: Record<string, string> },
    ): Promise<RazorpayRefundResult>;
  };
}

export class RazorpayConfigError extends Error {
  status = 503 as const;
  constructor(message: string) {
    super(message);
    this.name = "RazorpayConfigError";
  }
}

let testClientOverride: RazorpayClientLike | null = null;
let cachedLivePair: { keyId: string; keySecret: string; client: RazorpayClientLike } | null =
  null;

/** Injects a mock Razorpay client for isolated Vitest integration suites. */
export function setRazorpayClientForTest(client: RazorpayClientLike | null): void {
  testClientOverride = client;
}

export function isPaymentsEnabled(): boolean {
  return process.env.PAYMENTS_ENABLED === "true";
}

export function getReservationTtlMinutes(): number {
  const parsed = Number(process.env.RESERVATION_TTL_MINUTES);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_RESERVATION_TTL_MINUTES;
}

export function getReservationTtlMs(): number {
  if (process.env.PAYMENTS_DEMO_MODE === "true") {
    return DEMO_RESERVATION_TTL_MS;
  }
  return Math.round(getReservationTtlMinutes() * 60 * 1000);
}

/** Ensures BullMQ job IDs never contain colons (`:`). */
export function sanitizeJobIdSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function assertTestKeyIdFormat(keyId: string | undefined): string {
  const trimmed = keyId?.trim();
  if (!trimmed) {
    console.error("[Razorpay FATAL] Missing RAZORPAY_KEY_ID environment variable.");
    throw new RazorpayConfigError("Razorpay test gateway is not configured.");
  }
  if (!trimmed.startsWith(RAZORPAY_TEST_KEY_PREFIX)) {
    console.error(
      `[Razorpay FATAL] Refusing non-test RAZORPAY_KEY_ID (${trimmed.slice(0, 8)}...). TEST MODE ONLY.`,
    );
    throw new RazorpayConfigError(
      "Razorpay gateway disabled: only rzp_test_ keys are allowed in simulation mode.",
    );
  }
  return trimmed;
}

/**
 * Lazy-initialized Razorpay client with strict TEST MODE guard.
 * Never executes at module import time so `next build`, CI, and worker boot stay safe.
 */
export function getRazorpayClient(): {
  client: RazorpayClientLike;
  keyId: string;
  keySecret: string;
} {
  if (testClientOverride) {
    const rawKeyId = process.env.RAZORPAY_KEY_ID?.trim();
    if (rawKeyId && !rawKeyId.startsWith(RAZORPAY_TEST_KEY_PREFIX)) {
      assertTestKeyIdFormat(rawKeyId);
    }
    return {
      client: testClientOverride,
      keyId: rawKeyId || "rzp_test_mocked",
      keySecret: process.env.RAZORPAY_KEY_SECRET?.trim() || "rzp_test_mock_secret",
    };
  }

  const keyId = assertTestKeyIdFormat(process.env.RAZORPAY_KEY_ID);
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keySecret) {
    console.error("[Razorpay FATAL] Missing RAZORPAY_KEY_SECRET environment variable.");
    throw new RazorpayConfigError("Razorpay test gateway is not configured.");
  }

  if (
    !cachedLivePair ||
    cachedLivePair.keyId !== keyId ||
    cachedLivePair.keySecret !== keySecret
  ) {
    const sdkInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
    cachedLivePair = {
      keyId,
      keySecret,
      client: sdkInstance as unknown as RazorpayClientLike,
    };
  }

  return {
    client: cachedLivePair.client,
    keyId,
    keySecret,
  };
}

/**
 * Validates test-mode Razorpay + webhook configuration lazily for webhook handling.
 */
export function assertWebhookTestConfig(): { webhookSecret: string } {
  const rawKeyId = process.env.RAZORPAY_KEY_ID?.trim();
  if (testClientOverride) {
    if (rawKeyId && !rawKeyId.startsWith(RAZORPAY_TEST_KEY_PREFIX)) {
      assertTestKeyIdFormat(rawKeyId);
    }
  } else {
    assertTestKeyIdFormat(rawKeyId);
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    console.error("[Razorpay FATAL] Missing RAZORPAY_WEBHOOK_SECRET environment variable.");
    throw new RazorpayConfigError("Razorpay webhook secret is not configured.");
  }

  return { webhookSecret };
}

/** Timing-safe verification for Razorpay Checkout handler `{ orderId, paymentId, signature }`. */
export function verifyRazorpayCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const { keySecret } = getRazorpayClient();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.from(input.signature.trim(), "utf8");
  return (
    expectedBuf.length === candidateBuf.length &&
    crypto.timingSafeEqual(expectedBuf, candidateBuf)
  );
}

/** Timing-safe verification for raw webhook body against X-Razorpay-Signature. */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.from(signatureHeader.trim(), "utf8");
  return (
    expectedBuf.length === candidateBuf.length &&
    crypto.timingSafeEqual(expectedBuf, candidateBuf)
  );
}
