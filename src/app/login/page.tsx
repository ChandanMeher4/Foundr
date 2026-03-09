"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [view, setView] = useState<"password" | "request_otp" | "verify_otp">("password");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // 1. Standard Password Login
  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = await res.json();
        router.push(data.role === "Admin" ? "/admin" : data.role === "Developer" ? "/developer" : "/");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Login failed");
      }
    } catch (err) {
      setError("An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Request OTP
  const handleRequestOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setMessage("A 6-digit secure code has been sent to your email.");
        setView("verify_otp");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send OTP.");
      }
    } catch (err) {
      setError("An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  // 3. Verify OTP
  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      if (res.ok) {
        const data = await res.json();
        router.push(data.role === "Admin" ? "/admin" : data.role === "Developer" ? "/developer" : "/");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || "Invalid or expired OTP.");
      }
    } catch (err) {
      setError("An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass =
    "w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-900 placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all";
  const labelClass =
    "block text-[10px] font-bold text-stone-500 uppercase tracking-[0.15em] mb-1.5";

  const viewMeta = {
    password: { eyebrow: "Welcome Back", title: "Log In", subtitle: "Access your investment dashboard." },
    request_otp: { eyebrow: "Account Recovery", title: "Reset Access", subtitle: "We'll send a secure code to your inbox." },
    verify_otp: { eyebrow: "Verification", title: "Enter Code", subtitle: `Code sent to ${email}` },
  };

  const { eyebrow, title, subtitle } = viewMeta[view];

  return (
    <div className="min-h-screen bg-stone-50 flex items-start justify-center py-16 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-md">

          {/* Dark header band */}
          <div className="bg-stone-950 px-8 py-7 relative">
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
            <p className="text-[9px] font-bold text-amber-400 tracking-[0.4em] uppercase mb-2">
              ◆ {eyebrow}
            </p>
            <h1
              className="text-3xl font-black text-white tracking-tight"
              style={{ fontFamily: "'Georgia', serif" }}
            >
              {title}<span className="text-amber-400">.</span>
            </h1>
            <p className="text-stone-400 text-sm mt-1">{subtitle}</p>
          </div>

          <div className="px-8 py-7">

            {/* Alerts */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl mb-6 text-xs font-semibold flex items-center gap-2">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}
            {message && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-xl mb-6 text-xs font-semibold flex items-center gap-2">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                {message}
              </div>
            )}

            {/* ── VIEW 1: PASSWORD LOGIN ── */}
            {view === "password" && (
              <form onSubmit={handlePasswordLogin} className="space-y-5">
                <div>
                  <label className={labelClass}>Email Address</label>
                  <input
                    type="email" required placeholder="arjun@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className={labelClass} style={{ marginBottom: 0 }}>Password</label>
                    <button
                      type="button"
                      onClick={() => { setError(""); setView("request_otp"); }}
                      className="text-[10px] font-bold text-amber-600 hover:text-amber-500 tracking-wide uppercase transition-colors"
                    >
                      Forgot Password?
                    </button>
                  </div>
                  <input
                    type="password" required placeholder="••••••••"
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <button
                  type="submit" disabled={isLoading}
                  className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-3.5 rounded-xl transition-all duration-200 text-xs tracking-widest uppercase shadow-md disabled:opacity-50 disabled:cursor-not-allowed mt-2 flex items-center justify-center gap-2 group"
                >
                  {isLoading ? (
                    <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Authenticating...</>
                  ) : (
                    <>Log In <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
                  )}
                </button>
              </form>
            )}

            {/* ── VIEW 2: REQUEST OTP ── */}
            {view === "request_otp" && (
              <form onSubmit={handleRequestOTP} className="space-y-5">
                <div>
                  <label className={labelClass}>Email Address</label>
                  <input
                    type="email" required placeholder="arjun@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <button
                  type="submit" disabled={isLoading}
                  className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-3.5 rounded-xl transition-all duration-200 text-xs tracking-widest uppercase shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
                >
                  {isLoading ? (
                    <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Sending Code...</>
                  ) : (
                    <>Send Secure Code <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setError(""); setView("password"); }}
                  className="w-full text-center text-[10px] font-bold text-stone-400 hover:text-stone-700 tracking-widest uppercase transition-colors flex items-center justify-center gap-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" /></svg>
                  Back to Login
                </button>
              </form>
            )}

            {/* ── VIEW 3: VERIFY OTP ── */}
            {view === "verify_otp" && (
              <form onSubmit={handleVerifyOTP} className="space-y-5">
                <div>
                  <label className={labelClass}>6-Digit Code</label>
                  <input
                    type="text" required maxLength={6}
                    value={otp} onChange={(e) => setOtp(e.target.value)}
                    className={`${inputClass} text-center text-2xl tracking-[0.6em] font-black`}
                    placeholder="000000"
                  />
                  <p className="text-[10px] text-stone-400 mt-2 text-center">
                    Didn't receive it?{" "}
                    <button
                      type="button"
                      onClick={() => { setError(""); setMessage(""); setView("request_otp"); }}
                      className="text-amber-600 font-bold hover:text-amber-500 transition-colors"
                    >
                      Resend code
                    </button>
                  </p>
                </div>
                <button
                  type="submit" disabled={isLoading}
                  className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-3.5 rounded-xl transition-all duration-200 text-xs tracking-widest uppercase shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
                >
                  {isLoading ? (
                    <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Verifying...</>
                  ) : (
                    <>Verify & Log In <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
                  )}
                </button>
              </form>
            )}

            {/* Footer */}
            <p className="mt-6 text-center text-xs text-stone-400 border-t border-stone-100 pt-6">
              Don't have an account?{" "}
              <Link href="/register" className="text-amber-600 hover:text-amber-500 font-bold transition-colors">
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}