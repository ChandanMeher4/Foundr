// src/components/ProjectCard.tsx
import Link from "next/link";
import { IProject } from "@/types";

export default function ProjectCard({ project }: { project: IProject }) {
  // Calculate the funding progress percentage
  const fundingPercentage = Math.min(
    (project.currentFunding / project.totalValuation) * 100,
    100,
  ).toFixed(0);

  const devName = project.developerName?.name || "Verified Developer";

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 flex flex-col group">
      
      {/* ── Top Image & Badges ─────────────────────────────────── */}
      <div className="relative h-52 w-full bg-stone-100 overflow-hidden">
        <img
          src={project.imageUrls?.[0]}
          alt={project.title}
          className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-700 ease-out"
        />

        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

        {/* Stage Badge */}
        <div className="absolute top-4 left-4 bg-stone-900/85 backdrop-blur-sm px-3 py-1 rounded-full">
          <span className="text-[10px] font-bold text-amber-400 tracking-widest uppercase">
            {project.constructionStage}
          </span>
        </div>

        {/* Verified Badge */}
        {project.isVerified && (
          <div className="absolute top-4 right-4 bg-emerald-500 text-white px-2.5 py-1 rounded-full flex items-center gap-1 shadow-md">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-[10px] font-bold tracking-wide">Verified</span>
          </div>
        )}

        {/* Funding % pill on image */}
        <div className="absolute bottom-4 right-4 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-full shadow">
          <span className="text-[11px] font-black text-stone-900">
            {fundingPercentage}%
            <span className="text-stone-400 font-medium"> funded</span>
          </span>
        </div>
      </div>

      {/* ── Content Section ───────────────────────────────────── */}
      <div className="p-5 grow flex flex-col">

        {/* Title & Meta */}
        <div className="mb-4">
          <h3
            className="text-lg font-black text-stone-900 tracking-tight leading-snug mb-1"
            style={{ fontFamily: "'Georgia', serif" }}
          >
            {project.title}
          </h3>

          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <p className="text-xs text-stone-400 font-medium flex items-center gap-1">
              <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
              </svg>
              {devName} · {project.location.address}
            </p>

            {/* Distance Badge */}
            {project.distance !== undefined && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                {(project.distance / 1000).toFixed(1)} km away
              </span>
            )}
          </div>
        </div>

        {/* Financial Metrics */}
        <div className="grid grid-cols-2 gap-4 border-t border-stone-100 pt-4">
          <div>
            <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
              Min. Investment
            </p>
            <p className="text-base font-black text-stone-900">
              ₹{project.minInvestment.toLocaleString("en-IN")}
            </p>
          </div>
          <div>
            <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
              Valuation
            </p>
            <p className="text-base font-black text-stone-900">
              ₹{project.totalValuation.toLocaleString("en-IN")}
            </p>
          </div>
        </div>

        {/* Funding Progress Bar */}
        <div className="mt-5 mb-4">
          <div className="flex justify-between text-[11px] font-bold mb-2">
            <span className="text-amber-600">
              ₹{project.currentFunding.toLocaleString("en-IN")} raised
            </span>
            <span className="text-stone-400">
              of ₹{project.totalValuation.toLocaleString("en-IN")}
            </span>
          </div>
          <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-gradient-to-r from-amber-500 to-amber-400 h-1.5 rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${fundingPercentage}%` }}
            />
          </div>
        </div>

        {/* Action Button */}
        <div className="mt-auto pt-4 border-t border-stone-100">
          <Link
            href={`/projects/${project._id}`}
            className="flex items-center justify-center gap-2 w-full text-center bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 py-3 rounded-xl text-xs font-bold tracking-widest uppercase transition-all duration-200 group/btn"
          >
            View Opportunity
            <svg
              className="w-3.5 h-3.5 group-hover/btn:translate-x-1 transition-transform"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </div>
    </div>
  );
}