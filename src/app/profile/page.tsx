"use client";

import { useState, useEffect } from "react";
import ProjectCard from "@/components/ProjectCard";
import AddressAutocomplete from "@/components/AddressAutocomplete";

export default function ProfilePage() {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState({ text: "", type: "" });
  const [selectedCity, setSelectedCity] = useState("");

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await fetch("/api/user/profile");
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setSelectedCity(data.user.city);
        } else {
          setMessage({ text: "Failed to load profile.", type: "error" });
        }
      } catch (error) {
        setMessage({ text: "An unexpected error occurred.", type: "error" });
      } finally {
        setIsLoading(false);
      }
    };
    fetchProfile();
  }, []);

  // 2. Handle City Update
  const handleUpdateCity = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdating(true);
    setMessage({ text: "", type: "" });
    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: selectedCity }),
      });
      if (res.ok) {
        setMessage({ text: "Location updated successfully!", type: "success" });
        setTimeout(() => { window.location.href = "/"; }, 1000);
      } else {
        setMessage({ text: "Failed to update location.", type: "error" });
      }
    } catch (error) {
      setMessage({ text: "An error occurred.", type: "error" });
    } finally {
      setIsUpdating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col justify-center items-center gap-4">
        <div className="w-10 h-10 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-amber-400/70 text-xs font-semibold tracking-[0.3em] uppercase">Loading Profile</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-[10px] font-bold text-amber-500 tracking-[0.35em] uppercase mb-3">◆ Access Required</p>
          <p className="text-stone-500 text-sm">Please log in to view your profile.</p>
        </div>
      </div>
    );
  }

  const initials = user.name
    ? user.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : "U";

  const roleColor =
    user.role === "Developer" ? "text-amber-600 bg-amber-50 border-amber-200" :
    user.role === "Admin" ? "text-violet-600 bg-violet-50 border-violet-200" :
    "text-emerald-600 bg-emerald-50 border-emerald-200";

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-5xl mx-auto px-6 py-10 space-y-10">

        {/* ── Page Header ───────────────────────────────────────── */}
        <div>
          <p className="text-[10px] font-bold text-amber-500 tracking-[0.35em] uppercase mb-2">◆ My Account</p>
          <h1
            className="text-4xl font-black text-stone-900 tracking-tight"
            style={{ fontFamily: "'Georgia', serif" }}
          >
            Your Dashboard
          </h1>
        </div>

        {/* ── Profile + Settings Card ───────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-md">

          {/* Dark header band */}
          <div className="bg-stone-950 px-8 py-6 relative">
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="flex items-center gap-4">
                {/* Avatar */}
                <div className="w-14 h-14 rounded-full bg-amber-400 text-stone-900 flex items-center justify-center text-lg font-black shadow-md shrink-0">
                  {initials}
                </div>
                <div>
                  <h2
                    className="text-xl font-black text-white tracking-tight"
                    style={{ fontFamily: "'Georgia', serif" }}
                  >
                    {user.name}
                  </h2>
                  <p className="text-stone-400 text-xs mt-0.5">{user.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`text-[10px] font-bold px-3 py-1 rounded-full border tracking-wider uppercase ${roleColor}`}>
                  {user.role}
                </span>
                {user.companyName && (
                  <span className="text-[10px] font-semibold text-stone-400 bg-stone-800 px-3 py-1 rounded-full border border-stone-700">
                    {user.companyName}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Settings body */}
          <div className="px-8 py-7">
            <h3
              className="text-base font-black text-stone-900 mb-5"
              style={{ fontFamily: "'Georgia', serif" }}
            >
              Investment Location Preferences
            </h3>

            {message.text && (
              <div className={`px-4 py-3 rounded-xl mb-5 text-xs font-semibold flex items-center gap-2 border ${
                message.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-red-50 text-red-600 border-red-200"
              }`}>
                {message.type === "success" ? (
                  <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                ) : (
                  <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                )}
                {message.text}
              </div>
            )}

            <form onSubmit={handleUpdateCity} className="flex flex-col gap-4 max-w-md">
              <div>
                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-[0.15em] mb-1.5">
                  Update Primary Location
                </label>
                <AddressAutocomplete
                  onSelect={(address) => setSelectedCity(address)}
                />
                {selectedCity && (
                  <p className="text-[10px] text-amber-600 font-semibold mt-1.5 flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" /></svg>
                    {selectedCity}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={isUpdating || !selectedCity || selectedCity === user.city}
                  className="bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 px-7 py-2.5 rounded-xl font-bold text-xs tracking-widest uppercase transition-all duration-200 shadow-md disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 group"
                >
                  {isUpdating ? (
                    <><div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Saving...</>
                  ) : (
                    <>Update Location <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
                  )}
                </button>
              </div>
              <p className="text-[10px] text-stone-400 -mt-1">
                Updating your city tailors your homepage marketplace feed.
              </p>
            </form>
          </div>
        </div>

        {/* ── Starred Projects ──────────────────────────────────── */}
        <div>
          <div className="flex items-baseline gap-3 mb-6">
            <h3
              className="text-2xl font-black text-stone-900 tracking-tight"
              style={{ fontFamily: "'Georgia', serif" }}
            >
              Starred Opportunities
            </h3>
            {user.starredProjects?.length > 0 && (
              <span className="text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full">
                {user.starredProjects.length}
              </span>
            )}
          </div>

          {user.starredProjects && user.starredProjects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {user.starredProjects.map((project: any) => (
                <ProjectCard key={project._id.toString()} project={project} />
              ))}
            </div>
          ) : (
            <div className="text-center py-16 bg-white rounded-2xl border border-stone-200 border-dashed shadow-sm">
              <div className="text-4xl mb-4">⭐</div>
              <p className="text-stone-900 font-bold text-base mb-1">No starred projects yet</p>
              <p className="text-stone-400 text-sm">Browse the marketplace and star opportunities you're interested in.</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}