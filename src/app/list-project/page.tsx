"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AddressAutocomplete from "@/components/AddressAutocomplete";

export default function ListProjectPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [error, setError] = useState("");

  const [formData, setFormData] = useState({
    title: "",
    description: "",
    location: { address: "", coordinates: [0, 0] },
    category: "Residential",
    constructionStage: "Planning",
    totalValuation: "",
    minInvestment: "",
    expectedCompletion: "",
    imageUrl: [] as string[],
  });

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploadingImage(true);
    setError("");
    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET as string;
    try {
      const uploadPromises = Array.from(files).map(async (file) => {
        const data = new FormData();
        data.append("file", file);
        data.append("upload_preset", uploadPreset);
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
          method: "POST", body: data,
        });
        const uploadedImage = await res.json();
        return uploadedImage.secure_url;
      });
      const uploadedUrls = await Promise.all(uploadPromises);
      setFormData((prev) => ({ ...prev, imageUrls: [...prev.imageUrl, ...uploadedUrls] }));
    } catch (err) {
      setError("Failed to upload one or more images.");
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.imageUrl) { setError("Please upload a project image before submitting."); return; }
    setIsSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          totalValuation: Number(formData.totalValuation),
          minInvestment: Number(formData.minInvestment),
        }),
      });
      if (!response.ok) throw new Error("Failed to submit project");
      router.push("/?success=true");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    "w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-sm font-medium text-stone-900 placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all";
  const labelClass =
    "block text-[10px] font-bold text-stone-500 uppercase tracking-[0.15em] mb-1.5";
  const selectClass =
    `${inputClass} appearance-none cursor-pointer`;

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-3xl mx-auto px-6 py-10">

        {/* ── Page Header ─────────────────────────────── */}
        <div className="mb-8">
          <p className="text-[10px] font-bold text-amber-500 tracking-[0.35em] uppercase mb-2">◆ Developer Panel</p>
          <h1
            className="text-4xl font-black text-stone-900 tracking-tight"
            style={{ fontFamily: "'Georgia', serif" }}
          >
            List an Opportunity
          </h1>
          <p className="text-stone-400 text-sm mt-1">
            Submit your early-stage project for verification and funding.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl mb-6 text-xs font-semibold flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-md">

          {/* Dark form header */}
          <div className="bg-stone-950 px-8 py-5 relative">
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
            <p className="text-[9px] font-bold text-amber-400 tracking-[0.4em] uppercase">Project Submission Form</p>
          </div>

          <div className="px-8 py-8 space-y-7">

            {/* Title + Location */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label htmlFor="title" className={labelClass}>Project Title</label>
                <input
                  id="title" required type="text" name="title"
                  onChange={handleChange} placeholder="e.g. Azure Heights"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Precise Location</label>
                <AddressAutocomplete
                  onSelect={(address, coordinates) =>
                    setFormData({ ...formData, location: { address, coordinates } })
                  }
                />
              </div>
            </div>

            {/* Image Upload */}
            <div>
              <label className={labelClass}>Project Image Gallery</label>
              <div className={`${inputClass} p-0 overflow-hidden`}>
                <label className="flex items-center gap-3 cursor-pointer px-4 py-3 hover:bg-stone-100 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-stone-900 flex items-center justify-center shrink-0">
                    {isUploadingImage ? (
                      <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold text-stone-700">
                      {isUploadingImage ? "Uploading gallery..." : "Choose images to upload"}
                    </p>
                    <p className="text-[10px] text-stone-400">Select multiple files, first image becomes the cover</p>
                  </div>
                  <input
                    type="file" accept="image/*" multiple
                    onChange={handleImageUpload} disabled={isUploadingImage}
                    className="hidden"
                  />
                </label>
              </div>

              {formData.imageUrl.length > 0 && (
                <div className="mt-3 grid grid-cols-4 gap-3">
                  {formData.imageUrl.map((url, index) => (
                    <div key={index} className="relative h-20 rounded-xl overflow-hidden border border-stone-200 shadow-sm">
                      <img src={url} alt={`Preview ${index + 1}`} className="w-full h-full object-cover" />
                      {index === 0 && (
                        <div className="absolute top-1.5 left-1.5 bg-stone-950/80 backdrop-blur-sm px-2 py-0.5 rounded-full">
                          <span className="text-[9px] font-bold text-amber-400 tracking-wider">Cover</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label htmlFor="description" className={labelClass}>Description</label>
              <textarea
                id="description" required name="description" rows={4}
                onChange={handleChange} placeholder="Describe the project, highlights, and investment rationale..."
                className={`${inputClass} resize-none`}
              />
            </div>

            {/* Category + Stage */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="relative">
                <label htmlFor="category" className={labelClass}>Category</label>
                <select id="category" name="category" onChange={handleChange} className={selectClass}>
                  <option value="Residential">Residential</option>
                  <option value="Commercial">Commercial</option>
                  <option value="Plot">Plot</option>
                </select>
                <svg className="absolute right-4 bottom-3.5 w-4 h-4 text-stone-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              <div className="relative">
                <label htmlFor="constructionStage" className={labelClass}>Construction Stage</label>
                <select id="constructionStage" name="constructionStage" onChange={handleChange} className={selectClass}>
                  <option value="Planning">Planning</option>
                  <option value="Foundation">Foundation</option>
                  <option value="Structural">Structural</option>
                  <option value="Finishing">Finishing</option>
                </select>
                <svg className="absolute right-4 bottom-3.5 w-4 h-4 text-stone-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {/* Financials */}
            <div className="border-t border-stone-100 pt-6">
              <p className="text-[9px] font-bold text-stone-400 uppercase tracking-[0.2em] mb-4">Financial Details</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div>
                  <label htmlFor="totalValuation" className={labelClass}>Total Valuation (₹)</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400 font-bold text-sm pointer-events-none">₹</span>
                    <input
                      id="totalValuation" required type="number" name="totalValuation"
                      onChange={handleChange} placeholder="50000000"
                      className={`${inputClass} pl-8`}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="minInvestment" className={labelClass}>Min Investment (₹)</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400 font-bold text-sm pointer-events-none">₹</span>
                    <input
                      id="minInvestment" required type="number" name="minInvestment"
                      onChange={handleChange} placeholder="500000"
                      className={`${inputClass} pl-8`}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="expectedCompletion" className={labelClass}>Expected Completion</label>
                  <input
                    id="expectedCompletion" required type="date" name="expectedCompletion"
                    onChange={handleChange}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting || isUploadingImage}
              className="w-full bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 font-bold py-4 rounded-xl transition-all duration-200 text-xs tracking-widest uppercase shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
            >
              {isSubmitting ? (
                <><div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Submitting...</>
              ) : (
                <>Submit for Review <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}