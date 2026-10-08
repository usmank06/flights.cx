"use client";

import { useEffect } from "react";
import { searchTitle } from "@/lib/search/titles";
import type { SearchRecord } from "@/lib/types";

/**
 * Keeps the tab title in sync with the record. `generateMetadata` sets it once on the server, so a search that finishes after load
 * would still say "Searching" in the tab and in what Share sends. Matches the title a reload gives.
 */
export function useTitle(record: SearchRecord) {
  const title = `${searchTitle(record)} · flights.cx`;
  useEffect(() => {
    document.title = title;
  }, [title]);
}
