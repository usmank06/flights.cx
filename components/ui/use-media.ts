"use client";

import { useSyncExternalStore } from "react";

/** A media query as an external store. The server snapshot is `false` (desktop layout), and React reconciles after hydration. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

export const usePhone = () => useMedia("(max-width: 767px)");
