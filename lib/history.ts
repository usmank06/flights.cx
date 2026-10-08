"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { SearchRequest } from "@/lib/types";

/**
 * The searches this browser started, kept in localStorage so history works without an account. Opening someone else's share link
 * doesn't add it here.
 */
/** Exported for the landing page's pre-paint script, which runs before this module loads. */
export const SEARCHES_KEY = "flights.searches.v1";
const KEY = SEARCHES_KEY;
const LIMIT = 60;

export function ownedSlugs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return []; // private mode, cleared storage or a corrupt value: history is optional
  }
}

export function remember(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    const next = [slug, ...ownedSlugs().filter((s) => s !== slug)].slice(0, LIMIT);
    window.localStorage.setItem(KEY, JSON.stringify(next));
    notify();
  } catch {
    /* the search still works, it just isn't listed */
  }
}

/** Each search's owner key (lib/search/owner.ts), which lets this browser delete a search no account owns. Dropped with its slug. */
const KEYS_KEY = "flights.keys.v1";

function allKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEYS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberKey(slug: string, key: string): void {
  if (typeof window === "undefined" || !key) return;
  try {
    const listed = new Set([slug, ...ownedSlugs()]);
    const kept = Object.entries(allKeys()).filter(([s]) => listed.has(s));
    window.localStorage.setItem(KEYS_KEY, JSON.stringify(Object.fromEntries([...kept, [slug, key]])));
  } catch {
    /* the search still works, but this browser can't delete it */
  }
}

export const keyFor = (slug: string): string | null => (typeof window === "undefined" ? null : (allKeys()[slug] ?? null));

/** Searches started here that still have their key, offered to the account on sign-in (app/api/auth/verify). */
export function heldSearches(): { slug: string; key: string }[] {
  if (typeof window === "undefined") return [];
  const keys = allKeys();
  return ownedSlugs().flatMap((slug) => (typeof keys[slug] === "string" ? [{ slug, key: keys[slug] }] : []));
}

export function forget(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ownedSlugs().filter((s) => s !== slug)));
    const keys = allKeys();
    if (slug in keys) {
      delete keys[slug];
      window.localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
    }
    const words = allWords();
    if (slug in words) {
      delete words[slug];
      window.localStorage.setItem(WORDS_KEY, JSON.stringify(words));
    }
    notify();
  } catch {
    /* ignore */
  }
}

/**
 * The traveller's own words for a search they started (first box, answers, notes). Public records omit them (`publicRecord`,
 * lib/store), so this browser keeps a copy for Edit to start from. Dropped with the slug.
 */
export type OwnWords = Pick<SearchRequest, "brief" | "turns" | "notes" | "flexibilityNote">;

const WORDS_KEY = "flights.words.v1";

function readWords(): string | null {
  try {
    return window.localStorage.getItem(WORDS_KEY);
  } catch {
    return null;
  }
}

function parseWords(raw: string | null): Record<string, OwnWords> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const allWords = (): Record<string, OwnWords> => (typeof window === "undefined" ? {} : parseWords(readWords()));

export function wordsFor(slug: string): OwnWords | null {
  const w = allWords()[slug];
  return w && typeof w === "object" && typeof w.brief === "string" ? w : null;
}

export function rememberWords(slug: string, words: OwnWords | null): void {
  if (typeof window === "undefined" || !words?.brief) return;
  try {
    const listed = new Set(ownedSlugs());
    const kept = Object.entries(allWords()).filter(([s]) => listed.has(s) && s !== slug);
    const { brief, turns, notes, flexibilityNote } = words;
    window.localStorage.setItem(WORDS_KEY, JSON.stringify(Object.fromEntries([...kept, [slug, { brief, turns, notes, flexibilityNote }]])));
    notify();
  } catch {
    /* the search still works; Edit starts from what it understood */
  }
}

/** This browser's words for a search. Null on the server and the first render, so hydration matches. */
export function useOwnWords(slug: string): OwnWords | null {
  // Snapshot the raw string: equal strings compare equal, while a parsed object would be new on every call.
  const raw = useSyncExternalStore(subscribe, readWords, () => null);
  return useMemo(() => {
    const w = parseWords(raw)[slug];
    return w && typeof w === "object" && typeof w.brief === "string" ? w : null;
  }, [raw, slug]);
}

/**
 * localStorage as an external store for `useSyncExternalStore`, so hydration matches the server without an extra render. The
 * `storage` event only fires for other tabs, so this tab's own writes call `notify`.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

// Snapshots are compared by identity, so this returns a boolean. A fresh array would re-render forever.
const snapshot = (): boolean => ownedSlugs().length > 0;
const serverSnapshot = (): boolean => false;

/** True once this browser has started at least one search. */
export function useHasSearched(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
