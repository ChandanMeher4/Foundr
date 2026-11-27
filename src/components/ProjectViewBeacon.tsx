"use client";

import { useEffect, useRef } from "react";

export default function ProjectViewBeacon({ projectId }: { projectId: string }) {
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    if (sentRef.current === projectId) {
      return;
    }
    sentRef.current = projectId;

    void fetch(`/api/projects/${projectId}/view`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  }, [projectId]);

  return null;
}
