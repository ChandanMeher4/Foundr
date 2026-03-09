"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

// We pass the whole project object in so the AI has context
export default function AiCopilot({ project }: { project: any }) {
  const [analysis, setAnalysis] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const analyzeProperty = async () => {
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send only the necessary data to save tokens
        body: JSON.stringify({
          title: project.title,
          description: project.description,
          location: project.location,
          minInvestment: project.minInvestment,
          totalValuation: project.totalValuation,
        }),
      });

      if (!res.ok) throw new Error("Failed to fetch AI analysis");

      const data = await res.json();
      setAnalysis(data.analysis);
    } catch (err) {
      setError("AI Copilot is currently unavailable.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-stone-900 to-black rounded-2xl p-6 shadow-xl border border-stone-800 my-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-600/20 flex items-center justify-center">
            <span className="text-blue-400 text-lg">✨</span>
          </div>
          <h3 className="text-white font-bold text-lg">Foundr AI Analyst</h3>
        </div>

        {!analysis && (
          <button
            onClick={analyzeProperty}
            disabled={isLoading}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold py-2 px-4 rounded-lg transition-colors disabled:opacity-50"
          >
            {isLoading ? "Analyzing..." : "Generate Risk Report"}
          </button>
        )}
      </div>

      {error && <p className="text-red-400 text-sm font-medium">{error}</p>}

      {analysis && (
        <div className="mt-6 p-6 bg-white border border-stone-200 rounded-xl shadow-sm prose prose-stone max-w-none">
          <ReactMarkdown
            components={{
              // This customizes how the "stars" (bold text) look
              strong: ({ node, ...props }) => (
                <span
                  className="block text-sm font-black text-stone-900 uppercase tracking-wider mb-2 mt-4 first:mt-0"
                  {...props}
                />
              ),
              // This makes the bullet points look clean
              li: ({ node, ...props }) => (
                <li
                  className="text-sm text-stone-600 mb-3 ml-4 list-disc marker:text-amber-500"
                  {...props}
                />
              ),
            }}
          >
            {analysis}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
