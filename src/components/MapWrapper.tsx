"use client";

import dynamic from "next/dynamic";

const DynamicMap = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-stone-100 rounded-2xl flex flex-col items-center justify-center gap-3 border border-stone-200">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      <p className="text-[10px] font-bold text-amber-400/70 tracking-[0.3em] uppercase">Loading Map Engine</p>
    </div>
  ),
});

export default function MapWrapper({ projects }: { projects: any[] }) {
  return <DynamicMap projects={projects} />;
}