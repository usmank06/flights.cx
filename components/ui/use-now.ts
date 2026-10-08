"use client";

import { useSyncExternalStore } from "react";

/**
 * The current time as an external store, so relative times don't cause hydration mismatches. Snapshots are rounded to the
 * tick to stay stable between renders. The server snapshot is 0, which callers treat as unknown.
 */
function makeClock(tickMs: number) {
  const subscribe = (onChange: () => void) => {
    const id = setInterval(onChange, tickMs);
    return () => clearInterval(id);
  };
  const snapshot = () => Math.floor(Date.now() / tickMs) * tickMs;
  return () => useSyncExternalStore(subscribe, snapshot, () => 0);
}

/** Updates once a second. For elapsed timers. */
export const useNowSecond = makeClock(1_000);
/** Updates once a minute. For "captured 3h ago". */
export const useNowMinute = makeClock(60_000);
