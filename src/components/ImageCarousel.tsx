"use client";

import { useState } from "react";

export default function ImageCarousel({
  imageUrls,
  title,
}: {
  imageUrls: string[];
  title: string;
}) {
  const [currentImg, setCurrentImg] = useState(0);

  if (!imageUrls || imageUrls.length === 0) {
    return (
      <div className="h-96 w-full bg-stone-100 rounded-2xl shadow-sm flex items-center justify-center">
        <p className="text-[10px] font-bold text-stone-400 tracking-widest uppercase">
          No Images
        </p>
      </div>
    );
  }

  const nextImg = () => setCurrentImg((prev) => (prev + 1) % imageUrls.length);
  const prevImg = () =>
    setCurrentImg((prev) => (prev === 0 ? imageUrls.length - 1 : prev - 1));

  return (
    <div className="relative h-96 w-full bg-stone-100 rounded-2xl overflow-hidden shadow-md group">
      {/* Image */}
      <img
        src={imageUrls[currentImg]}
        alt={`${title} - Image ${currentImg + 1}`}
        className="object-cover w-full h-full transition-opacity duration-500"
      />

      {/* Bottom gradient */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent pointer-events-none" />

      {imageUrls.length > 1 && (
        <>
          {/* Prev Button */}
          <button
            title="current"
            onClick={prevImg}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-stone-950/70 hover:bg-amber-400 text-white hover:text-stone-900 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 backdrop-blur-sm shadow-lg"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>

          {/* Next Button */}
          <button
            title="next"
            onClick={nextImg}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-stone-950/70 hover:bg-amber-400 text-white hover:text-stone-900 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 backdrop-blur-sm shadow-lg"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>

          {/* Dot indicators */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {imageUrls.map((_, i) => (
              <button
                title="set"
                key={i}
                onClick={() => setCurrentImg(i)}
                className={`rounded-full transition-all duration-200 ${
                  i === currentImg
                    ? "w-5 h-1.5 bg-amber-400"
                    : "w-1.5 h-1.5 bg-white/50 hover:bg-white/80"
                }`}
              />
            ))}
          </div>

          {/* Counter pill */}
          <div className="absolute bottom-4 right-4 bg-stone-950/75 backdrop-blur-sm px-3 py-1.5 rounded-full">
            <span className="text-[10px] font-bold text-white tracking-widest">
              {currentImg + 1}
              <span className="text-stone-400"> / {imageUrls.length}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
