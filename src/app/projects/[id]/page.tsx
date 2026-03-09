import { notFound } from "next/navigation";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import Link from "next/link";
import StarButton from "@/components/StarButton";
import ImageCarousel from "@/components/ImageCarousel";
import InvestButton from "@/components/InvestButton";
import AiCopilot from "@/components/AiCopilot";
import "@/models/User";

export default async function ProjectDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;
  const projectId = resolvedParams.id;

  await dbConnect();
  const project = await Project.findById(projectId)
    .populate("developerName", "name isVerifiedDeveloper")
    .lean();

  if (!project) {
    notFound();
  }

  const devName = project.developerName?.name || "Verified Developer";
  const fundingPercentage = Math.min(
    (project.currentFunding / project.totalValuation) * 100,
    100,
  ).toFixed(0);

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="py-10 max-w-6xl mx-auto px-6">

        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-bold text-stone-400 hover:text-amber-500 tracking-widest uppercase transition-colors mb-8 group"
        >
          <svg className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Marketplace
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">

          {/* ── Left Column ──────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-8">
            <ImageCarousel imageUrls={project.imageUrls} title={project.title} />

            <div>
              {/* Category tag */}
              <p className="text-[10px] font-bold text-amber-600 tracking-[0.35em] uppercase mb-3">
                ◆ {project.category || "Real Estate"}
              </p>

              <h1
                className="text-4xl font-black text-stone-900 mb-3 leading-tight tracking-tight"
                style={{ fontFamily: "'Georgia', serif" }}
              >
                {project.title}
              </h1>

              <p className="text-sm text-stone-400 mb-8 flex items-center gap-2 font-medium">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                </svg>
                {project.location.address}
              </p>

              {/* Divider */}
              <div className="h-px bg-stone-200 mb-8" />

              <h3
                className="text-lg font-black text-stone-900 mb-4"
                style={{ fontFamily: "'Georgia', serif" }}
              >
                About the Project
              </h3>
              <p className="text-stone-600 leading-relaxed whitespace-pre-line text-sm">
                {project.description}
              </p>

              <div className="mt-8">
                <StarButton projectId={project._id.toString()} />
              </div>
            </div>
            <AiCopilot project={JSON.parse(JSON.stringify(project))} />
          </div>

          {/* ── Right Column: Investment Dashboard ───────────────── */}
          <div className="lg:col-span-1">
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-md sticky top-24">

              {/* Card header */}
              <div className="bg-stone-950 px-6 py-5">
                <p className="text-[9px] font-bold text-amber-400 tracking-[0.35em] uppercase mb-1">
                  Investment Dashboard
                </p>
                <p className="text-white text-xs font-medium text-stone-300">
                  Review and commit to this opportunity
                </p>
              </div>

              <div className="p-6 space-y-6">

                {/* Developer */}
                <div className="pb-5 border-b border-stone-100">
                  <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.2em] mb-2">
                    Developed By
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-amber-400 text-stone-900 flex items-center justify-center text-xs font-black shrink-0">
                      {devName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-base font-black text-stone-900" style={{ fontFamily: "'Georgia', serif" }}>
                      {devName}
                    </span>
                    {project.isVerified && (
                      <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px] px-2 py-0.5 rounded-full font-bold tracking-wide">
                        Verified
                      </span>
                    )}
                  </div>
                </div>

                {/* Financials */}
                <div className="grid grid-rows-2 gap-4 pb-5 border-b border-stone-100">
                  <div>
                    <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.2em] mb-1">
                      Total Valuation
                    </p>
                    <p className="text-xl font-black text-stone-900">
                      ₹{project.totalValuation.toLocaleString("en-IN")}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-stone-400 uppercase font-bold tracking-[0.2em] mb-1">
                      Min. Investment
                    </p>
                    <p className="text-xl font-black text-stone-900">
                      ₹{project.minInvestment.toLocaleString("en-IN")}
                    </p>
                  </div>
                </div>

                {/* Funding Progress */}
                <div className="pb-5 border-b border-stone-100">
                  <div className="flex justify-between text-[11px] font-bold mb-2">
                    <span className="text-amber-600">{fundingPercentage}% Funded</span>
                    <span className="text-stone-400">
                      ₹{project.currentFunding.toLocaleString("en-IN")} raised
                    </span>
                  </div>
                  <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-amber-500 to-amber-400 h-1.5 rounded-full transition-all duration-1000 ease-out"
                      style={{ width: `${fundingPercentage}%` }}
                    />
                  </div>
                </div>

                {/* CTA */}
                <div>
                  <InvestButton
                    projectId={project._id.toString()}
                    minInvestment={project.minInvestment}
                  />
                  <p className="text-[10px] text-center text-stone-400 mt-3 leading-relaxed">
                    Committing sends an inquiry to the developer.
                    No money is transferred yet.
                  </p>
                </div>

              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}