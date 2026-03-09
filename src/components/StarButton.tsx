"use client";

import { useState } from "react";

export default function StarButton({ projectId }: { projectId: string }) {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [starred, setStarred] = useState(false);

  const toggleStar = async () => {
    setIsLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/user/star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessage(data.message);
        setStarred((prev) => !prev);
        setTimeout(() => setMessage(""), 3000);
      } else if (res.status === 401) {
        setMessage("Please log in to star projects.");
      } else {
        setMessage("Failed to update.");
      }
    } catch (error) {
      setMessage("An error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3 mt-6">
      <button
        onClick={toggleStar}
        disabled={isLoading}
        className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs tracking-widest uppercase transition-all duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed group border ${
          starred
            ? "bg-amber-400 text-stone-900 border-amber-400 hover:bg-amber-300"
            : "bg-white text-stone-700 border-stone-200 hover:border-amber-400 hover:text-amber-600"
        }`}
      >
        {isLoading ? (
          <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg
            className="w-4 h-4 transition-transform group-hover:scale-110"
            fill={starred ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={starred ? 0 : 1.5}
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        )}
        {isLoading ? "Saving..." : starred ? "Starred" : "Star this Opportunity"}
      </button>

      {message && (
        <span className="text-[10px] font-bold text-stone-500 bg-stone-100 border border-stone-200 px-3 py-1.5 rounded-full tracking-wide">
          {message}
        </span>
      )}
    </div>
  );
}