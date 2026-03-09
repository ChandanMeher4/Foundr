"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import Link from "next/link";

const customIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export default function Map({ projects }: { projects: any[] }) {
  const defaultCenter: [number, number] = [20.5937, 78.9629];

  return (
    <MapContainer
      center={defaultCenter}
      zoom={5}
      className="h-full w-full rounded-2xl z-0"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
      />

      {projects.map((project) => {
        if (!project.location?.coordinates || project.location.coordinates.length !== 2) return null;
        const lat = project.location.coordinates[1];
        const lng = project.location.coordinates[0];

        return (
          <Marker key={project._id} position={[lat, lng]} icon={customIcon}>
            <Popup className="rounded-xl overflow-hidden !p-0">
              <div className="w-52 font-sans overflow-hidden rounded-xl">
                <div className="relative h-28 overflow-hidden">
                  <img
                    src={project.imageUrls?.[0] || "https://placehold.co/400x300"}
                    alt={project.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                </div>
                <div className="p-3 bg-white">
                  <h3 className="font-black text-stone-900 text-sm leading-tight mb-1"
                    style={{ fontFamily: "'Georgia', serif" }}>
                    {project.title}
                  </h3>
                  <p className="text-[10px] text-amber-600 font-bold mb-3">
                    ₹{project.minInvestment?.toLocaleString("en-IN")} Min Investment
                  </p>
                  <Link
                    href={`/projects/${project._id}`}
                    className="flex items-center justify-center gap-1.5 w-full text-center bg-stone-900 hover:bg-amber-400 text-white hover:text-stone-900 text-[10px] font-bold py-2 rounded-lg tracking-widest uppercase transition-all duration-200"
                  >
                    View Opportunity
                  </Link>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}