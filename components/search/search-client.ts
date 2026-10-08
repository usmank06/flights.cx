"use client";

import { useSyncExternalStore } from "react";
import { TODAY_HEADER } from "@/lib/search/intake";
import type { SearchPhase, SearchRecord, SearchRequest } from "@/lib/types";
import { countLine, NO_TALLY, phaseSeen, type Tally } from "@/lib/search/tally";
import { todayDay } from "./dates";
import { rememberKey } from "@/lib/history";

/**
 * Starts and follows searches. `POST /api/search` streams the slug, progress, then the finished record into module state that
 * outlives the page, so the app can go to `/s/<slug>` as soon as the slug arrives while the results page keeps reading the stream.
 * After a hard reload the page polls the record instead, which the server writes either way.
 */
export type LiveLine = { text: string; kind: "info" | "action" | "success" | "error" };

export type LiveSearch = {
  slug: string;
  phase: SearchPhase;
  /** When each phase started, in ms after `startedAt`. Recorded per frame, so a phase shorter than a render still gets a time. */
  began: Partial<Record<SearchPhase, number>>;
  /** The latest lines, for what the current step is doing. */
  lines: LiveLine[];
  /** Running totals counted from every line (lib/search/tally.ts). */
  found: Tally;
  record: SearchRecord | null;
  error: string | null;
  running: boolean;
  startedAt: number;
};

const lives = new Map<string, LiveSearch>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const patch = (slug: string, p: Partial<LiveSearch>) => {
  const prev = lives.get(slug);
  if (!prev) return;
  lives.set(slug, { ...prev, ...p });
  notify();
};

/** The live view of a search this browser started, or null. Stable between updates. */
export function useLiveSearch(slug: string): LiveSearch | null {
  return useSyncExternalStore(subscribe, () => lives.get(slug) ?? null, () => null);
}

declare global {
  interface Window {
    grecaptcha?: {
      ready(cb: () => void): void;
      execute(siteKey: string, opts: { action: string }): Promise<string>;
    };
  }
}

const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
const RECAPTCHA_LOAD_MS = 5_000;

/**
 * A reCAPTCHA v3 token for a paid request, minted at submit time since tokens expire after two minutes. Null without a site key (the
 * server then skips verification). `action` must match an *_ACTION constant in lib/abuse/recaptcha.ts, since scores are per action.
 */
export async function recaptchaToken(action: "search" | "sign_in" | "ask" | "more" | "grid" | "intake" = "search"): Promise<string | null> {
  // Mirrors recaptchaOffLocally() on the server: outside production the script isn't loaded, so don't wait for it.
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_RECAPTCHA_LOCAL !== "1") return null;
  if (!RECAPTCHA_SITE_KEY) return null;
  const deadline = Date.now() + RECAPTCHA_LOAD_MS;
  while (!window.grecaptcha && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const grecaptcha = window.grecaptcha;
  if (!grecaptcha) return null;
  try {
    await new Promise<void>((resolve) => grecaptcha.ready(resolve));
    return await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
  } catch {
    return null;
  }
}

/** Headers for every paid POST: the reCAPTCHA token if any, and the traveller's local date so "today" means theirs. */
export async function recaptchaHeaders(action: Parameters<typeof recaptchaToken>[0]): Promise<Record<string, string>> {
  const token = await recaptchaToken(action);
  return { [TODAY_HEADER]: todayDay(), ...(token ? { "x-recaptcha-token": token } : {}) };
}

type Frame =
  | { t: "slug"; slug: string; key?: string }
  | { t: "phase"; phase: SearchPhase }
  | { t: "log"; text: string; kind: LiveLine["kind"] }
  | { t: "done"; record: SearchRecord }
  | { t: "error"; message: string; record?: SearchRecord };

/** Starts a search. Resolves with the slug as soon as it arrives; the rest keeps streaming into the live store. */
export function startSearch(request: SearchRequest): Promise<string> {
  return openSearch(request);
}

/** Re-runs a search from the request the server stored (the page's copy lacks the traveller's words), optionally in `currency`. */
export function rerunSearch(slug: string, currency?: string): Promise<string> {
  return openSearch({ rerun: slug, currency });
}

const NOT_STARTED = "We couldn’t start your search. Give it a moment and try again.";

async function openSearch(body: SearchRequest | { rerun: string; currency?: string }): Promise<string> {
  const headers = await recaptchaHeaders("search");
  // XHR progress instead of a fetch body stream: Chrome reports a streamed fetch as cancelled (net::ERR_ABORTED) when it ends,
  // even though every line arrived.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/search");
  xhr.setRequestHeader("content-type", "application/json");
  for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
  return new Promise<string>((resolve, reject) => {
    let slug: string | null = null;
    let read = 0;
    let finished = false;
    const handle = (f: Frame) => {
      if (f.t === "slug") {
        slug = f.slug;
        // This key lets the browser delete the search later from Your trips, even without an account.
        if (f.key) rememberKey(f.slug, f.key);
        lives.set(slug, { slug, phase: "starting", began: {}, lines: [], found: NO_TALLY, record: null, error: null, running: true, startedAt: Date.now() });
        notify();
        resolve(slug);
        return;
      }
      if (!slug) return;
      const now = lives.get(slug);
      if (!now) return;
      if (f.t === "phase") patch(slug, { phase: f.phase, began: phaseSeen(now.began, f.phase, Date.now() - now.startedAt) });
      else if (f.t === "log") patch(slug, { lines: [...now.lines, { text: f.text, kind: f.kind }].slice(-60), found: countLine(now.found, f.text) });
      else if (f.t === "done") {
        finished = true;
        patch(slug, { record: f.record, running: false, phase: "done" });
      } else if (f.t === "error") {
        finished = true;
        patch(slug, { record: f.record ?? null, error: f.message, running: false, phase: "error" });
      }
    };
    // Handle complete lines received since the last call; the last may be partial. A refusal is plain JSON, read in onload.
    const take = () => {
      if (xhr.status !== 200) return;
      const text = xhr.responseText;
      const upTo = text.lastIndexOf("\n") + 1;
      if (upTo <= read) return;
      for (const line of text.slice(read, upTo).split("\n")) {
        if (!line.trim()) continue;
        try {
          handle(JSON.parse(line) as Frame);
        } catch {
          /* not a frame; skip it */
        }
      }
      read = upTo;
    };
    const ended = () => {
      // Ended without a final frame, so the connection dropped. The server keeps writing the record and the page polls for it.
      if (slug && !finished) patch(slug, { running: false, error: null });
      if (!slug) reject(new Error(NOT_STARTED));
    };
    xhr.onprogress = take;
    xhr.onload = () => {
      if (xhr.status !== 200) {
        let said: unknown = null;
        try {
          said = (JSON.parse(xhr.responseText) as { error?: unknown }).error;
        } catch {
          /* no reason given */
        }
        return reject(new Error(typeof said === "string" ? said : NOT_STARTED));
      }
      take();
      ended();
    };
    xhr.onerror = ended;
    xhr.onabort = ended;
    xhr.send(JSON.stringify(body));
  });
}
