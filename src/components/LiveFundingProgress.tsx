"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import InvestButton from "./InvestButton";

interface FundingStreamPayload {
  projectId: string;
  currentFunding: number;
  totalValuation: number;
  status: string;
  percentage: number;
}

export default function LiveFundingProgress({
  projectId,
  initialFunding,
  reservedFunding = 0,
  totalValuation,
  minInvestment,
  initialStatus,
  paymentsEnabled = false,
}: {
  projectId: string;
  initialFunding: number;
  reservedFunding?: number;
  totalValuation: number;
  minInvestment: number;
  initialStatus: string;
  paymentsEnabled?: boolean;
}) {
  const router = useRouter();
  const [currentFunding, setCurrentFunding] = useState(initialFunding);
  const [status, setStatus] = useState(initialStatus);
  const [reconnectTick, setReconnectTick] = useState(0);

  const workerBaseUrl =
    process.env.NEXT_PUBLIC_WORKER_URL ||
    (typeof window !== "undefined" && window.location.hostname === "localhost"
      ? "http://localhost:4000"
      : "");

  useEffect(() => {
    if (!workerBaseUrl) return;

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const es = new EventSource(`${workerBaseUrl}/projects/${projectId}/stream`);

    const onFunding = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as FundingStreamPayload;
        if (typeof data.currentFunding === "number") {
          setCurrentFunding(data.currentFunding);
        }
        if (typeof data.status === "string") {
          setStatus(data.status);
          if (data.status === "Funded") {
            router.refresh();
          }
        }
      } catch {
        // Ignore malformed frames
      }
    };

    const onError = () => {
      if (disposed) return;
      // EventSource stays permanently dead once CLOSED; re-instantiate after backoff
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        retryTimer = setTimeout(() => {
          if (!disposed) {
            setReconnectTick((n) => n + 1);
          }
        }, 2000);
      }
    };

    es.addEventListener("funding", onFunding);
    es.addEventListener("error", onError);
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es.removeEventListener("funding", onFunding);
      es.removeEventListener("error", onError);
      es.close();
    };
  }, [projectId, workerBaseUrl, router, reconnectTick]);

  const fundingPercentage = Math.min(
    (currentFunding / totalValuation) * 100,
    100,
  ).toFixed(0);
  const isFunded = status === "Funded" || currentFunding >= totalValuation;
  const isExpired = status === "Expired";

  return (
    <>
      <div className="pb-5 border-b border-stone-100">
        <div className="flex justify-between text-[11px] font-bold mb-2">
          <span className="text-amber-600">{fundingPercentage}% Funded</span>
          <span className="text-stone-400">
            ₹{currentFunding.toLocaleString("en-IN")} raised
          </span>
        </div>
        <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-gradient-to-r from-amber-500 to-amber-400 h-1.5 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${fundingPercentage}%` }}
          />
        </div>
        {reservedFunding > 0 && !isFunded && !isExpired && (
          <p className="text-[10px] text-amber-600 font-semibold mt-2">
            ₹{reservedFunding.toLocaleString("en-IN")} temporarily held by active checkouts
          </p>
        )}
      </div>

      <div>
        {isExpired ? (
          <button
            disabled
            className="w-full bg-stone-700 text-white font-bold py-4 rounded-xl shadow-md text-xs tracking-widest uppercase flex items-center justify-center cursor-not-allowed opacity-90"
          >
            Listing Expired
          </button>
        ) : (
          <InvestButton
            projectId={projectId}
            minInvestment={minInvestment}
            isFunded={isFunded}
            paymentsEnabled={paymentsEnabled}
          />
        )}
        <p className="text-[10px] text-center text-stone-400 mt-3 leading-relaxed">
          {paymentsEnabled
            ? "Test mode - no real money. Simulated fractional checkout only."
            : "Committing sends an inquiry to the developer. No money is transferred yet."}
        </p>
      </div>
    </>
  );
}
