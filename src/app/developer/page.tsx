import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { redirect } from "next/navigation";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import "@/models/User";
import Link from "next/link";

export default async function DeveloperDashboard() {
  const cookieStore = await cookies();
  const token = cookieStore.get("foundr_token")?.value;
  if (!token) redirect("/login");

  const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "fallback_secret");
  let payload;
  try {
    const verified = await jwtVerify(token, SECRET);
    payload = verified.payload;
  } catch (err) {
    redirect("/login");
  }

  if (payload.role !== "Developer") redirect("/");

  await dbConnect();
  const myProjects = await Project.find({ developerName: payload.id })
    .populate("investors.userId", "name email")
    .sort({ createdAt: -1 })
    .lean();

  const totalRaised = myProjects.reduce((sum: number, p: any) => sum + (p.currentFunding || 0), 0);
  const totalInvestors = myProjects.reduce((sum: number, p: any) => sum + (p.investors?.length || 0), 0);
  const liveCount = myProjects.filter((p: any) => p.status === "Live").length;

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* ── Page Header ───────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-10">
          <div>
            <p className="text-[10px] font-bold text-amber-500 tracking-[0.35em] uppercase mb-2">◆ Developer Panel</p>
            <h1
              className="text-4xl font-black text-stone-900 tracking-tight"
              style={{ fontFamily: "'Georgia', serif" }}
            >
              Developer Portfolio
            </h1>
            <p className="text-stone-400 text-sm mt-1">Manage your listings and track investor commitments.</p>
          </div>
          <Link
            href="/list-project"
            className="inline-flex items-center gap-2 bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 px-6 py-3 rounded-xl font-bold text-xs tracking-widest uppercase transition-all duration-200 shadow-md group"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            List New Opportunity
          </Link>
        </div>

        {/* ── Stats Row ─────────────────────────────────────────── */}
        {myProjects.length > 0 && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Total Raised", value: `₹${totalRaised.toLocaleString("en-IN")}` },
              { label: "Live Projects", value: `${liveCount} / ${myProjects.length}` },
              { label: "Total Commitments", value: `${totalInvestors}` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-white border border-stone-200 rounded-2xl px-6 py-5 shadow-sm">
                <p className="text-[9px] font-bold text-stone-400 uppercase tracking-[0.2em] mb-1">{label}</p>
                <p className="text-2xl font-black text-stone-900" style={{ fontFamily: "'Georgia', serif" }}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Project List ──────────────────────────────────────── */}
        <div className="space-y-5">
          {myProjects.length === 0 ? (
            <div className="bg-white py-20 text-center rounded-2xl border border-stone-200 border-dashed shadow-sm">
              <div className="text-4xl mb-4">🏗️</div>
              <p className="text-stone-900 font-bold mb-1">No projects listed yet</p>
              <p className="text-stone-400 text-sm mb-6">Submit your first opportunity to get started.</p>
              <Link
                href="/list-project"
                className="inline-flex items-center gap-2 bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 px-6 py-2.5 rounded-xl font-bold text-xs tracking-widest uppercase transition-all duration-200"
              >
                List an Opportunity
              </Link>
            </div>
          ) : (
            myProjects.map((project: any) => {
              const progress = Math.min((project.currentFunding / project.totalValuation) * 100, 100);
              return (
                <div
                  key={project._id.toString()}
                  className="bg-white rounded-2xl border border-stone-200 shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden"
                >
                  {/* Status accent bar */}
                  <div className={`h-1 w-full ${project.status === "Live" ? "bg-gradient-to-r from-emerald-400 to-emerald-500" : "bg-gradient-to-r from-amber-400 to-amber-500"}`} />

                  <div className="p-6 flex flex-col md:flex-row gap-6">
                    {/* Cover image */}
                    <div className="relative w-full md:w-48 h-36 shrink-0 rounded-xl overflow-hidden bg-stone-100 shadow-sm">
                      <img
                        src={project.imageUrls?.[0] || "https://placehold.co/400x300?text=No+Image"}
                        alt={project.title}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Title row */}
                      <div className="flex justify-between items-start gap-3 mb-1">
                        <h2
                          className="text-xl font-black text-stone-900 tracking-tight"
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

                      {/* Progress bar */}
                      <div className="mb-4">
                        <div className="flex justify-between text-[11px] font-bold mb-1.5">
                          <span className="text-amber-600">₹{project.currentFunding.toLocaleString("en-IN")} raised</span>
                          <span className="text-stone-400">{progress.toFixed(1)}%</span>
                        </div>
                        <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-amber-500 to-amber-400 h-1.5 rounded-full"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>

                      {/* Stats */}
                      <div className="grid grid-cols-3 gap-4 border-t border-stone-100 pt-4">
                        <div>
                          <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">Raised</p>
                          <p className="font-black text-stone-900 text-sm">₹{project.currentFunding.toLocaleString("en-IN")}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">Target</p>
                          <p className="font-black text-stone-900 text-sm">₹{project.totalValuation.toLocaleString("en-IN")}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.15em] mb-1">Commitments</p>
                          <p className="font-black text-amber-600 text-sm">{project.investors?.length || 0}</p>
                        </div>
                      </div>

                      {/* Investor list */}
                      {project.investors && project.investors.length > 0 && (
                        <div className="mt-5 bg-stone-50 border border-stone-100 rounded-xl p-4">
                          <p className="text-[9px] font-bold text-stone-400 uppercase tracking-[0.2em] mb-3">Recent Commitments</p>
                          <div className="space-y-2">
                            {project.investors.map((inv: any, idx: number) => (
                              <div
                                key={idx}
                                className="flex justify-between items-center bg-white px-4 py-3 rounded-xl border border-stone-200"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-7 h-7 rounded-full bg-amber-400 text-stone-900 flex items-center justify-center text-[10px] font-black shrink-0">
                                    {inv.userId?.name?.charAt(0)?.toUpperCase() || "?"}
                                  </div>
                                  <div>
                                    <p className="text-xs font-bold text-stone-900">{inv.userId?.name || "Unknown Investor"}</p>
                                    <p className="text-[10px] text-stone-400">{inv.userId?.email || "No email"}</p>
                                  </div>
                                </div>
                                <span className="text-xs font-black text-emerald-600">
                                  +₹{inv.amount.toLocaleString("en-IN")}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}