"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function InvestButton({
  projectId,
  minInvestment,
}: {
  projectId: string;
  minInvestment: number;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [amount, setAmount] = useState<number | "">("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleInvest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (Number(amount) < minInvestment) {
      setError(`Minimum investment is ₹${minInvestment.toLocaleString("en-IN")}`);
      return;
    }
    setIsSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/invest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number(amount) }),
      });
      if (!res.ok) throw new Error("Failed to process investment");
      setSuccess(true);
      setTimeout(() => {
        setIsOpen(false);
        router.refresh();
      }, 2000);
    } catch (err) {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-4 rounded-xl transition-all duration-200 shadow-md text-xs tracking-widest uppercase flex items-center justify-center gap-2 group"
      >
        Commit to Invest
        <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </button>

      {/* Modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl overflow-hidden max-w-md w-full shadow-2xl">

            {/* Modal header band */}
            <div className="bg-stone-950 px-7 py-6 relative">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
              {!success && (
                <button
                title="back"
                  onClick={() => setIsOpen(false)}
                  className="absolute top-4 right-4 w-7 h-7 rounded-full bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-white flex items-center justify-center transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <p className="text-[9px] font-bold text-amber-400 tracking-[0.4em] uppercase mb-1">
                ◆ Investment
              </p>
              <h3 className="text-xl font-black text-white" style={{ fontFamily: "'Georgia', serif" }}>
                {success ? "Commitment Secured" : "Commitment Details"}
                <span className="text-amber-400">.</span>
              </h3>
            </div>

            <div className="px-7 py-6">
              {success ? (
                <div className="text-center py-4">
                  <div className="w-14 h-14 bg-emerald-50 border-2 border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <p className="text-stone-500 text-sm">The developer will contact you shortly with the term sheet.</p>
                </div>
              ) : (
                <>
                  <p className="text-stone-400 text-xs mb-5">
                    Enter your commitment amount. Minimum required:{" "}
                    <span className="font-bold text-amber-600">₹{minInvestment.toLocaleString("en-IN")}</span>
                  </p>

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
                          value={amount}
                          onChange={(e) => setAmount(Number(e.target.value) || "")}
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
                        <>Confirm Commitment <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
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