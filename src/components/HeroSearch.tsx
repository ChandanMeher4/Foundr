"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AddressAutocomplete from "./AddressAutocomplete";

export default function HeroSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("query") || "");
  const [category, setCategory] = useState(searchParams.get("category") || "All");
  const [coords, setCoords] = useState<[number, number] | null>(null);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (category !== "All") params.set("category", category);
    if (coords) {
      params.set("lng", coords[0].toString());
      params.set("lat", coords[1].toString());
    }
    router.push(`/?${params.toString()}`);
  };

  const inputClass =
    "w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-900 placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all";

  return (
    <form
      onSubmit={handleSearch}
      className="mt-6 flex flex-col md:flex-row gap-3 bg-white p-3 rounded-2xl shadow-md border border-stone-200"
    >
      {/* Project name search */}
      <div className="flex-1 relative group">
        <svg
          className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 group-focus-within:text-amber-500 transition-colors pointer-events-none"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search project names..."
          className={`${inputClass} pl-11`}
        />
      </div>

      {/* Location autocomplete */}
      <div className="flex-1">
        <AddressAutocomplete
          onSelect={(address, coordinates) => setCoords(coordinates)}
        />
      </div>

      {/* Category select */}
      <div className="relative shrink-0 md:w-44">
        <select
          aria-label="category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={`${inputClass} appearance-none cursor-pointer pr-9`}
        >
          <option value="All">All Categories</option>
          <option value="Residential">Residential</option>
          <option value="Commercial">Commercial</option>
          <option value="Plot">Plot</option>
        </select>
        <svg
          className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Submit */}
      <button
        type="submit"
        className="shrink-0 bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 px-7 py-3 rounded-xl font-bold text-xs tracking-widest uppercase transition-all duration-200 shadow-sm flex items-center gap-2 group"
      >
        Search Radius
        <svg
          className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </button>
    </form>
  );
}