"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function AdminDashboard() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const res = await fetch("/api/admin/projects");
        if (res.ok) {
          const data = await res.json();
          setProjects(data);
        }
      } catch (error) {
        console.error("Failed to fetch projects", error);
      } finally {
        setLoading(false);
      }
    };
    fetchProjects();
  }, []);

  const handleApprove = async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Live", isVerified: true }),
      });
      if (res.ok) {
        setProjects((prev: any) =>
          prev.map((p: any) =>
            p._id === id ? { ...p, status: "Live", isVerified: true } : p,
          ),
        );
      }
    } catch (error) {
      alert("Failed to approve project");
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm("Are you sure you want to permanently delete this project submission?")) return;
    try {
      const res = await fetch(`/api/admin/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev: any) => prev.filter((p: any) => p._id !== id));
      } else {
        alert("Failed to delete project. Make sure your DELETE API route is set up!");
      }
    } catch (error) {
      console.error("Failed to reject project");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col justify-center items-center gap-4">
        <div className="w-10 h-10 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-amber-400/70 text-xs font-semibold tracking-[0.3em] uppercase">Loading Console</p>
      </div>
    );
  }

  const pending = projects.filter((p: any) => p.status !== "Live").length;
  const live = projects.filter((p: any) => p.status === "Live").length;

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* ── Page Header ───────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-10">
          <div>
            <p className="text-[10px] font-bold text-violet-500 tracking-[0.35em] uppercase mb-2">◆ Admin Panel</p>
            <h1
              className="text-4xl font-black text-stone-900 tracking-tight"
              style={{ fontFamily: "'Georgia', serif" }}
            >
              Admin Console
            </h1>
            <p className="text-stone-400 text-sm mt-1">Review and manage marketplace listings.</p>
          </div>

          <div className="flex items-center gap-4">
            {/* Stats pills */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                {pending} Pending
              </span>
              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-full">
                {live} Live
              </span>
            </div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-[10px] font-bold text-stone-400 hover:text-amber-500 tracking-widest uppercase transition-colors group"
            >
              View Live Site
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>
        </div>

        {/* ── Project List ──────────────────────────────────────── */}
        <div className="space-y-5">
          {projects.length === 0 ? (
            <div className="bg-white py-20 text-center rounded-2xl border border-stone-200 shadow-sm">
              <div className="text-4xl mb-4">🗂️</div>
              <p className="text-stone-900 font-bold">No projects found</p>
              <p className="text-stone-400 text-sm mt-1">No submissions in the database yet.</p>
            </div>
          ) : (
            projects.map((project: any) => (
              <div
                key={project._id}
                className="bg-white rounded-2xl border border-stone-200 shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden"
              >
                {/* Status bar accent */}
                <div className={`h-1 w-full ${project.status === "Live" ? "bg-gradient-to-r from-emerald-400 to-emerald-500" : "bg-gradient-to-r from-amber-400 to-amber-500"}`} />

                <div className="p-6 flex flex-col md:flex-row gap-6">

                  {/* ── Image Inspector ───────────────────────── */}
                  <div className="w-full md:w-60 flex-shrink-0 flex flex-col gap-2">
                    <div className="relative h-40 w-full rounded-xl overflow-hidden bg-stone-100 shadow-sm">
                      <img
                        src={project.imageUrls?.[0] || "https://placehold.co/400x300?text=No+Image"}
                        alt={project.title}
                        className="w-full h-full object-cover"
                      />
                      {project.imageUrls?.length > 1 && (
                        <div className="absolute bottom-2 right-2 bg-stone-950/80 backdrop-blur-sm px-2.5 py-1 rounded-full">
                          <span className="text-[9px] font-bold text-amber-400 tracking-wider">
                            {project.imageUrls.length} Photos
                          </span>
                        </div>
                      )}
                    </div>

                    {project.imageUrls?.length > 1 && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {project.imageUrls.map((url: string, idx: number) => (
                          <a
                            key={idx}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-shrink-0 group"
                            title="Click to view full size"
                          >
                            <img
                              src={url}
                              alt={`Thumbnail ${idx + 1}`}
                              className="h-11 w-14 object-cover rounded-lg border border-stone-200 group-hover:border-amber-400 group-hover:opacity-80 transition-all"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* ── Project Details ───────────────────────── */}
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-2 gap-3">
                      <h2
                        className="text-xl font-black text-stone-900 tracking-tight leading-snug"
                        style={{ fontFamily: "'Georgia', serif" }}
                      >
                        {project.title}
                      </h2>
                      <span className={`shrink-0 text-[10px] font-bold px-3 py-1 rounded-full border tracking-wider uppercase ${
                        project.status === "Live"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}>
                        {project.status}
                      </span>
                    </div>

                    <p className="text-xs text-stone-400 font-medium mb-4 flex items-center gap-1.5">
                      <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                      </svg>
                      {project.location?.address}
                    </p>

                    {/* Description */}
                    <div className="bg-stone-50 border border-stone-100 rounded-xl p-4 mb-4">
                      <p className="text-[9px] font-bold text-stone-400 uppercase tracking-[0.2em] mb-1.5">
                        Project Description
                      </p>
                      <p className="text-xs text-stone-600 leading-relaxed line-clamp-3">
                        {project.description}
                      </p>
                    </div>

                    {/* Financials */}
                    <div className="grid grid-cols-2 gap-4 border-t border-stone-100 pt-4 mb-5">
                      <div>
                        <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
                          Total Valuation
                        </p>
                        <p className="font-black text-stone-900 text-sm">
                          ₹{project.totalValuation?.toLocaleString("en-IN") || 0}
                        </p>
                      </div>
                      <div>
                        <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
                          Min Investment
                        </p>
                        <p className="font-black text-stone-900 text-sm">
                          ₹{project.minInvestment?.toLocaleString("en-IN") || 0}
                        </p>
                      </div>
                    </div>

                    {/* Admin Actions */}
                    <div className="flex gap-3 flex-wrap">
                      {project.status !== "Live" && (
                        <button
                          onClick={() => handleApprove(project._id)}
                          className="inline-flex items-center gap-2 bg-stone-900 hover:bg-emerald-500 text-white font-bold px-5 py-2.5 rounded-xl text-xs tracking-widest uppercase transition-all duration-200 shadow-sm group"
                        >
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          Approve & Publish
                        </button>
                      )}
                      <button
                        onClick={() => handleReject(project._id)}
                        className="inline-flex items-center gap-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-bold px-5 py-2.5 rounded-xl text-xs tracking-widest uppercase transition-all duration-200"
                      >
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" />
                        </svg>
                        Reject & Delete
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}