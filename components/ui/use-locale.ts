"use client";

import { useSyncExternalStore } from "react";

/**
 * The browser locale as an external store. The server renders with en-US and React reconciles after hydration instead of
 * reporting a mismatch. The locale doesn't change while the page is open, so `subscribe` is a no-op.
 */
const FALLBACK = "en-US";

const subscribe = () => () => {};
const snapshot = () =>
  typeof navigator !== "undefined" && navigator.language ? navigator.language : FALLBACK;
const serverSnapshot = () => FALLBACK;

export function useBrowserLocale(): string {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
