"use client";

import { useSyncExternalStore } from "react";
import { coerceLocale } from "@/lib/format";

/**
 * The browser locale as an external store. The server renders with en-US and React reconciles after hydration instead of
 * reporting a mismatch. The locale doesn't change while the page is open, so `subscribe` is a no-op.
 */
const FALLBACK = "en-US";

const subscribe = () => () => {};
// Some browsers report a tag Intl rejects ("en-US@posix" from headless Chrome), which would make every date and price throw,
// so it's cleaned up the same way the server cleans a request's locale.
let browser: string | undefined;
const snapshot = () => (typeof navigator === "undefined" ? FALLBACK : (browser ??= coerceLocale(navigator.language, FALLBACK)));
const serverSnapshot = () => FALLBACK;

export function useBrowserLocale(): string {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
