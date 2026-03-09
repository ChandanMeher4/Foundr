"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import MapWrapper from "@/components/MapWrapper";

export default function Marketplace() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  // UI State
  const [viewMode, setViewMode] = useState<"list" | "map">("list");

  // RESTORED: Search & Filter State
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          const data = await res.json();
          setProjects(data);
        }
      } catch (error) {
        console.error("Failed to fetch projects:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchProjects();
  }, []);

  // THE FILTER ENGINE: This runs instantly every time a user types or changes a dropdown
  const filteredProjects = projects.filter((project: any) => {
    const matchesSearch =
      project.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.location?.address?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCategory =
      selectedCategory === "All" || project.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex flex-col justify-center items-center min-h-[60vh] bg-stone-950 gap-4">
        <div className="w-10 h-10 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-amber-400/70 text-xs font-semibold tracking-[0.3em] uppercase">
          Loading Marketplace
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50">

      {/* ── Hero Header ─────────────────────────────────────────── */}
      <div className="bg-stone-950 px-6 pt-16 pb-12 relative overflow-hidden">
        {/* Subtle grid texture */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(#d6d3d1 1px, transparent 1px), linear-gradient(90deg, #d6d3d1 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        {/* Gold accent line */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

        <div className="max-w-7xl mx-auto relative z-10">
          <p className="text-amber-400 text-[10px] font-bold tracking-[0.4em] uppercase mb-4">
            ◆ Fractional Real Estate
          </p>
          <h1
            className="text-5xl md:text-6xl font-black text-white tracking-tight leading-none mb-4"
            style={{ fontFamily: "'Georgia', serif", letterSpacing: "-0.02em" }}
          >
            Live
            <span className="text-amber-400"> Opportunities</span>
          </h1>
          <p className="text-stone-400 text-base font-normal max-w-md">
            Discover and invest in premium fractional real estate across India's fastest-growing markets.
          </p>
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Toolbar ─────────────────────────────────────────── */}
        <div className="flex flex-col lg:flex-row gap-3 mb-10 items-stretch lg:items-center">

          {/* Search */}
          <div className="flex-1 relative group">
            <svg
              className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 group-focus-within:text-amber-500 transition-colors"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search by city, address, or title..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-5 py-3.5 bg-white border border-stone-200 rounded-xl text-sm font-medium text-stone-900 placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all shadow-sm"
            />
          </div>

          {/* Category Dropdown */}
          <div className="relative w-full lg:w-52 shrink-0">
            <select
              title="category"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full appearance-none px-5 py-3.5 bg-white border border-stone-200 rounded-xl text-sm font-semibold text-stone-900 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all shadow-sm cursor-pointer"
            >
              <option value="All">All Categories</option>
              <option value="Residential">Residential</option>
              <option value="Commercial">Commercial</option>
              <option value="Industrial">Industrial</option>
              <option value="Mixed-Use">Mixed-Use</option>
            </select>
            <svg
              className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>

          {/* List / Map Toggle */}
          <div className="bg-stone-900 p-1 rounded-xl flex items-center shrink-0 shadow-md">
            <button
              onClick={() => setViewMode("list")}
              className={`px-7 py-2.5 rounded-lg text-xs font-bold tracking-widest uppercase transition-all ${
                viewMode === "list"
                  ? "bg-amber-400 text-stone-900 shadow"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              List
            </button>
            <button
              onClick={() => setViewMode("map")}
              className={`px-7 py-2.5 rounded-lg text-xs font-bold tracking-widest uppercase transition-all ${
                viewMode === "map"
                  ? "bg-amber-400 text-stone-900 shadow"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              Map
            </button>
          </div>
        </div>

        {/* Results count */}
        {viewMode === "list" && (
          <p className="text-xs text-stone-400 font-semibold tracking-widest uppercase mb-6">
            {filteredProjects.length} {filteredProjects.length === 1 ? "Property" : "Properties"} Found
          </p>
        )}

        {/* ── Conditional Rendering Engine ─────────────────────── */}
        {viewMode === "map" ? (

          /* ── MAP VIEW ── */
          <div className="w-full h-[650px] bg-stone-100 rounded-2xl border border-stone-200 overflow-hidden shadow-lg relative z-0">
            <MapWrapper projects={filteredProjects} />
          </div>

        ) : (

          /* ── LIST VIEW ── */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.length === 0 ? (

              <div className="col-span-full text-center py-28 bg-white rounded-2xl border border-stone-200 shadow-sm">
                <div className="text-5xl mb-5">🏜️</div>
                <p className="text-stone-900 font-bold text-lg mb-2">No opportunities found</p>
                <p className="text-stone-400 text-sm">Try adjusting your search filters or clearing the category.</p>
                <button
                  onClick={() => { setSearchQuery(""); setSelectedCategory("All"); }}
                  className="mt-6 inline-flex items-center gap-2 px-6 py-2.5 bg-stone-900 text-amber-400 text-xs font-bold tracking-wider uppercase rounded-full hover:bg-amber-400 hover:text-stone-900 transition-all"
                >
                  Clear all filters
                </button>
              </div>

            ) : (
              filteredProjects.map((project: any) => {
                const progress = Math.min((project.currentFunding / project.totalValuation) * 100, 100) || 0;

                return (
                  <Link
                    href={`/projects/${project._id}`}
                    key={project._id}
                    className="group bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 block"
                  >
                    {/* Cover Image */}
                    <div className="relative h-52 overflow-hidden bg-stone-100">
                      <img
                        src={project.imageUrls?.[0] || "https://placehold.co/600x400?text=No+Image"}
                        alt={project.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
                      />
                      {/* Dark gradient overlay */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

                      {/* Category Badge */}
                      <div className="absolute top-4 left-4 bg-stone-900/90 backdrop-blur-sm px-3 py-1 rounded-full">
                        <span className="text-[10px] font-bold text-amber-400 tracking-widest uppercase">
                          {project.category}
                        </span>
                      </div>

                      {/* Progress badge on image */}
                      <div className="absolute bottom-4 right-4 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-full shadow">
                        <span className="text-[11px] font-black text-stone-900">
                          {progress.toFixed(1)}%
                          <span className="text-stone-400 font-medium"> funded</span>
                        </span>
                      </div>
                    </div>

                    {/* Card Body */}
                    <div className="p-5">
                      <h2 className="text-lg font-black text-stone-900 mb-1 line-clamp-1 tracking-tight"
                          style={{ fontFamily: "'Georgia', serif" }}>
                        {project.title}
                      </h2>
                      <p className="text-xs text-stone-400 mb-5 line-clamp-1 font-medium flex items-center gap-1.5">
                        <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                        </svg>
                        {project.location?.address}
                      </p>

                      {/* Progress Bar */}
                      <div className="mb-5">
                        <div className="flex justify-between text-[11px] font-bold mb-2">
                          <span className="text-amber-600">
                            ₹{project.currentFunding?.toLocaleString("en-IN") || 0} raised
                          </span>
                          <span className="text-stone-400">
                            of ₹{project.totalValuation?.toLocaleString("en-IN")}
                          </span>
                        </div>
                        <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-amber-500 to-amber-400 h-1.5 rounded-full transition-all duration-1000 ease-out"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>

                      {/* Stats */}
                      <div className="grid grid-cols-2 gap-4 border-t border-stone-100 pt-4">
                        <div>
                          <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
                            Min. Investment
                          </p>
                          <p className="font-black text-stone-900 text-sm">
                            ₹{project.minInvestment?.toLocaleString("en-IN")}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">
                            Total Target
                          </p>
                          <p className="font-black text-stone-900 text-sm">
                            ₹{project.totalValuation?.toLocaleString("en-IN")}
                          </p>
                        </div>
                      </div>

                      {/* CTA */}
                      <div className="mt-4 pt-4 border-t border-stone-100">
                        <span className="inline-flex items-center gap-2 text-[11px] font-bold text-stone-900 group-hover:text-amber-600 tracking-widest uppercase transition-colors">
                          View Details
                          <svg className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}