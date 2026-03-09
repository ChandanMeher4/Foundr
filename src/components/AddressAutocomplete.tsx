"use client";

import { useState, useEffect, useRef } from "react";

interface Suggestion {
  properties: {
    formatted: string;
    lon: number;
    lat: number;
  };
}

interface AddressAutocompleteProps {
  onSelect: (address: string, coordinates: [number, number]) => void;
}

export default function AddressAutocomplete({ onSelect }: AddressAutocompleteProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const fetchSuggestions = async (text: string) => {
    setQuery(text);
    if (text.length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }
    setIsLoading(true);
    try {
      const apiKey = process.env.NEXT_PUBLIC_GEOAPIFY_KEY;
      const res = await fetch(
        `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(text)}&apiKey=${apiKey}&filter=countrycode:in`
      );
      const data = await res.json();
      setSuggestions(data.features || []);
      setIsOpen(true);
    } catch (error) {
      console.error("Geocoding error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelect = (suggestion: Suggestion) => {
    const { formatted, lon, lat } = suggestion.properties;
    setQuery(formatted);
    setIsOpen(false);
    onSelect(formatted, [lon, lat]);
  };

  return (
    <div ref={wrapperRef} className="relative w-full">
      {/* Input */}
      <div className="relative group">
        <svg
          className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 group-focus-within:text-amber-500 transition-colors pointer-events-none"
          fill="currentColor" viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => fetchSuggestions(e.target.value)}
          placeholder="Search location (e.g. Indiranagar, Bengaluru)..."
          className="w-full bg-stone-50 border border-stone-200 rounded-xl pl-11 pr-10 py-3 text-sm font-medium text-stone-900 placeholder:text-stone-400 outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 transition-all"
          required
        />

        {/* Spinner */}
        {isLoading && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
            <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <ul className="absolute z-50 w-full bg-white border border-stone-200 rounded-xl shadow-xl mt-1.5 max-h-60 overflow-y-auto divide-y divide-stone-100">
          {suggestions.map((s, index) => (
            <li
              key={index}
              onClick={() => handleSelect(s)}
              className="flex items-start gap-3 px-4 py-3 hover:bg-stone-50 cursor-pointer transition-colors group/item"
            >
              <svg
                className="w-3.5 h-3.5 mt-0.5 shrink-0 text-stone-300 group-hover/item:text-amber-500 transition-colors"
                fill="currentColor" viewBox="0 0 20 20"
              >
                <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
              </svg>
              <span className="text-xs font-medium text-stone-600 group-hover/item:text-stone-900 transition-colors leading-relaxed">
                {s.properties.formatted}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}