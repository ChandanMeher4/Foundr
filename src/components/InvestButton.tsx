"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface RazorpayHandlerResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayModalOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  handler: (response: RazorpayHandlerResponse) => void;
  modal?: {
    ondismiss?: () => void;
  };
  theme?: {
    color?: string;
  };
}

interface RazorpayBrowserInstance {
  open(): void;
}

type RazorpayConstructor = new (
  options: RazorpayModalOptions,
) => RazorpayBrowserInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let razorpayScriptPromise: Promise<boolean> | null = null;

function loadRazorpayCheckoutScript(): Promise<boolean> {
  if (typeof window === "undefined") {
    return Promise.resolve(false);
  }
  if (window.Razorpay) {
    return Promise.resolve(true);
  }
  if (razorpayScriptPromise) {
    return razorpayScriptPromise;
  }

  razorpayScriptPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => {
      razorpayScriptPromise = null;
      resolve(false);
    };
    document.body.appendChild(script);
  });

  return razorpayScriptPromise;
}

async function pollPaymentUntilSettled(
  reservationId: string,
): Promise<{ status: string; lastError?: string }> {
  let lastStatus = "authorized";
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`/api/payments/${reservationId}/status`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        status: string;
        lastError?: string;
      };
      if (data.status) {
        lastStatus = data.status;
      }
      if (
        data.status === "captured" ||
        data.status === "refund_pending" ||
        data.status === "refunded" ||
        data.status === "failed" ||
        data.status === "expired"
      ) {
        return data;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { status: lastStatus };
}

export default function InvestButton({
  projectId,
  minInvestment,
  isFunded = false,
  paymentsEnabled = false,
}: {
  projectId: string;
  minInvestment: number;
  isFunded?: boolean;
  paymentsEnabled?: boolean;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [amount, setAmount] = useState<number | "">("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const openModal = () => {
    setError("");
    setStatusMessage("");
    setIsConfirming(false);
    setSuccess(false);
    setIdempotencyKey(crypto.randomUUID());
    setIsOpen(true);
  };

  const handleAmountChange = (val: string) => {
    const next = Number(val) || "";
    if (next !== amount) {
      // Regenerate key if amount changes so intentional edits aren't blocked by 422
      setIdempotencyKey(crypto.randomUUID());
    }
    setAmount(next);
  };

  const handleDirectInvest = async () => {
    const res = await fetch(`/api/projects/${projectId}/invest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey || crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: Number(amount) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter =
          res.headers.get("Retry-After") || data.retryAfterSeconds || "60";
        throw new Error(`Too many attempts. Try again in ${retryAfter} seconds.`);
      }
      throw new Error(data.error || "Failed to process investment");
    }
    setSuccess(true);
    setTimeout(() => {
      setIsOpen(false);
      router.refresh();
    }, 2000);
  };

  const handleRazorpayCheckout = async () => {
    const checkoutRes = await fetch(`/api/projects/${projectId}/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey || crypto.randomUUID(),
      },
      body: JSON.stringify({ amount: Number(amount) }),
    });

    const data = (await checkoutRes.json().catch(() => ({}))) as {
      error?: string;
      retryAfterSeconds?: number;
      orderId?: string;
      amountPaise?: number;
      currency?: string;
      keyId?: string;
      reservationId?: string;
    };

    if (!checkoutRes.ok) {
      if (checkoutRes.status === 429) {
        const retryAfter =
          checkoutRes.headers.get("Retry-After") ||
          data.retryAfterSeconds ||
          "60";
        throw new Error(`Too many attempts. Try again in ${retryAfter} seconds.`);
      }
      throw new Error(data.error || "Failed to start test checkout.");
    }

    if (
      !data.orderId ||
      !data.amountPaise ||
      !data.keyId ||
      !data.reservationId
    ) {
      throw new Error("Incomplete checkout response from server.");
    }

    const loaded = await loadRazorpayCheckoutScript();
    if (!loaded || !window.Razorpay) {
      throw new Error("Could not load Razorpay Checkout SDK.");
    }

    const reservationId = data.reservationId;
    const keyId = data.keyId;

    await new Promise<void>((resolve, reject) => {
      const rzp = new window.Razorpay!({
        key: keyId,
        amount: data.amountPaise!,
        currency: data.currency || "INR",
        order_id: data.orderId!,
        name: "Foundr (Test Mode)",
        description: "Test mode - no real money",
        theme: { color: "#1c1917" },
        handler: async (response: RazorpayHandlerResponse) => {
          try {
            setStatusMessage("Verifying test payment signature...");
            const verifyRes = await fetch("/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              }),
            });

            if (!verifyRes.ok) {
              const vErr = (await verifyRes.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(
                vErr.error || "Payment signature verification failed.",
              );
            }

            setStatusMessage("Confirming test commitment via worker...");
            const settled = await pollPaymentUntilSettled(reservationId);
            if (settled.status === "captured") {
              setSuccess(true);
              setStatusMessage("");
              setTimeout(() => {
                setIsOpen(false);
                router.refresh();
              }, 1800);
              resolve();
              return;
            }
            if (
              settled.status === "refund_pending" ||
              settled.status === "refunded"
            ) {
              reject(
                new Error(
                  "Reservation expired before capture and capacity filled; test refund initiated.",
                ),
              );
              return;
            }
            if (settled.status === "failed" || settled.status === "expired") {
              reject(
                new Error(
                  settled.lastError ||
                    `Payment ended with status: ${settled.status}.`,
                ),
              );
              return;
            }
            setIsConfirming(true);
            setSuccess(true);
            setStatusMessage(
              "Payment received - confirming (this can take a minute). Your investment will appear in your profile.",
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        modal: {
          ondismiss: () => {
            setStatusMessage("");
            reject(
              new Error(
                "Checkout dismissed. Your temporary capacity reservation will expire automatically.",
              ),
            );
          },
        },
      });
      rzp.open();
    });
  };

  const handleInvest = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      setError("Please enter a valid whole-rupee integer amount.");
      return;
    }
    if (numericAmount < minInvestment) {
      setError(`Minimum investment is ₹${minInvestment.toLocaleString("en-IN")}`);
      return;
    }
    setIsSubmitting(true);
    setError("");
    setStatusMessage("");
    setIsConfirming(false);
    try {
      if (paymentsEnabled) {
        await handleRazorpayCheckout();
      } else {
        await handleDirectInvest();
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isFunded) {
    return (
      <button
        disabled
        className="w-full bg-emerald-600 text-white font-bold py-4 rounded-xl shadow-md text-xs tracking-widest uppercase flex items-center justify-center gap-2 cursor-not-allowed opacity-95"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Opportunity Fully Funded
      </button>
    );
  }

  return (
    <>
      <button
        onClick={openModal}
        className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-4 rounded-xl transition-all duration-200 shadow-md text-xs tracking-widest uppercase flex items-center justify-center gap-2 group"
      >
        {paymentsEnabled ? "Proceed to Test Checkout" : "Commit to Invest"}
        <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl overflow-hidden max-w-md w-full shadow-2xl">
            <div className="bg-stone-950 px-7 py-6 relative">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
              {(!success || isConfirming) && (
                <button
                  title="back"
                  onClick={() => {
                    setIsOpen(false);
                    if (isConfirming) router.refresh();
                  }}
                  className="absolute top-4 right-4 w-7 h-7 rounded-full bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-white flex items-center justify-center transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <p className="text-[9px] font-bold text-amber-400 tracking-[0.4em] uppercase mb-1">
                {paymentsEnabled ? "◆ Test mode - no real money" : "◆ Investment"}
              </p>
              <h3 className="text-xl font-black text-white" style={{ fontFamily: "'Georgia', serif" }}>
                {isConfirming
                  ? "Payment Received"
                  : success
                    ? "Commitment Secured"
                    : "Commitment Details"}
                <span className="text-amber-400">.</span>
              </h3>
            </div>

            <div className="px-7 py-6">
              {paymentsEnabled && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3.5 py-2 rounded-xl mb-4 text-[11px] font-bold tracking-wide">
                  Test mode - no real money. Simulated Razorpay checkout only.
                </div>
              )}

              {success ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 bg-emerald-50 border-2 border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <p className="text-stone-500 text-sm">
                    {statusMessage || "Your commitment has been recorded."}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-stone-400 text-xs mb-5">
                    Enter your commitment amount. Minimum required:{" "}
                    <span className="font-bold text-amber-600">₹{minInvestment.toLocaleString("en-IN")}</span>
                  </p>

                  {statusMessage && (
                    <div className="bg-stone-100 border border-stone-200 text-stone-700 px-4 py-3 rounded-xl mb-5 text-xs font-semibold">
                      {statusMessage}
                    </div>
                  )}

                  {error && (
                    <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl mb-5 text-xs font-semibold flex items-center gap-2">
                      <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                      {error}
                    </div>
                  )}

                  <form onSubmit={handleInvest} className="space-y-5">
                    <div>
                      <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-[0.15em] mb-1.5">
                        Investment Amount (₹)
                      </label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400 font-bold text-sm">₹</span>
                        <input
                          type="number"
                          required
                          step={1}
                          min={1}
                          value={amount}
                          onChange={(e) => handleAmountChange(e.target.value)}
                          className="w-full bg-stone-50 border border-stone-200 rounded-xl pl-8 pr-4 py-3 text-lg font-black text-stone-900 placeholder:text-stone-300 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all"
                          placeholder={minInvestment.toString()}
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-3.5 rounded-xl transition-all duration-200 text-xs tracking-widest uppercase shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
                    >
                      {isSubmitting ? (
                        <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Processing...</>
                      ) : (
                        <>
                          {paymentsEnabled ? "Pay in Test Mode" : "Confirm Commitment"}
                          <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                        </>
                      )}
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
