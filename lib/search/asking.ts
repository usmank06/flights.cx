import { AIRPORTS, nearbyAirports } from "@/lib/airports";
import { isPlaceId, type FlightBackend } from "@/lib/flights/backend";
import { FlightsError } from "@/lib/flights/errors";
import type { DatePricePoint } from "@/lib/flights/types";
import { PLACE_NAMES } from "./core";
import { metroCodes } from "./intake";

/**
 * Retries provider calls until they answer or the caller's deadline passes. Anything left unanswered is recorded, and the
 * caller ends with an error instead of showing partial results.
 */

/** Attempts per call before it counts as unanswered (`must`), and the base pause between attempts, which grows each time. */
export const ASKS = 4;
export const ASK_AGAIN_MS = 600;
/** Asks of an incomplete calendar before it counts as unanswered (`settleCalendar`). */
export const CALENDAR_ASKS = 4;
/** Airports asked per end of a round trip: the place's own plus grouped or nearby ones. */
export const AIRPORTS_PER_END = 3;

/** Thrown when calls never answered, so nothing is built from partial answers. */
export class Unanswered extends Error {
  constructor(readonly what: string[]) {
    super(`${what.length} calls never answered (${what.slice(0, 3).join("; ")}${what.length > 3 ? "; …" : ""})`);
    this.name = "Unanswered";
  }
}

type Log = (text: string, kind?: "info" | "action" | "success" | "error") => void;

export type Asker = {
  /** Runs one provider call until it answers. Returns null if it never does, and records it in `unanswered`. */
  must: <T>(fn: (signal: AbortSignal) => Promise<T>, what: string) => Promise<T | null>;
  /** Asks a calendar until it is complete (see below). */
  settleCalendar: (what: string, call: (signal: AbortSignal, enough?: number) => Promise<DatePricePoint[]>, expected: number, onAnswer: (pts: DatePricePoint[]) => void, counts?: (p: DatePricePoint) => boolean) => Promise<void>;
  /** A pause the caller's deadline cuts short. */
  pause: (ms: number) => Promise<void>;
  /** Calls that never answered, in the order they gave up. */
  readonly unanswered: string[];
  /** Throws `Unanswered` when anything never answered. */
  allAnswered: () => void;
};

/**
 * `signal` is the caller's deadline, the only clock over every call. `onAsk` counts each attempt for stats. With `bestEffort`,
 * misses are logged but not recorded as unanswered, for optional extras such as long-stay grid cells.
 */
export function asker(opts: { signal: AbortSignal; log?: Log; onAsk?: () => void; bestEffort?: boolean }): Asker {
  const { signal } = opts;
  const log: Log = opts.log ?? (() => {});
  const unanswered: string[] = [];
  const missed = (what: string) => {
    if (!opts.bestEffort) unanswered.push(what);
  };
  const missKind = opts.bestEffort ? "info" : "error";

  const pause = (ms: number) =>
    new Promise<void>((done) => {
      const stop = () => (clearTimeout(t), done());
      const t = setTimeout(() => (signal.removeEventListener("abort", stop), done()), ms);
      signal.addEventListener("abort", stop, { once: true });
    });

  const must = async <T>(fn: (signal: AbortSignal) => Promise<T>, what: string): Promise<T | null> => {
    for (let ask = 1; ask <= ASKS && !signal.aborted; ask++) {
      try {
        opts.onAsk?.();
        return await fn(signal);
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof FlightsError ? e : new FlightsError("HTTP_ERROR", (e as Error).message);
        log(`  ${what} ✗ ${err.kind}: ${err.message.slice(0, 160)}${ask < ASKS ? " — asking again" : ""}`, missKind);
        await pause(ASK_AGAIN_MS * ask);
      }
    }
    missed(what);
    log(`  ${what}: no answer ${signal.aborted ? "before the deadline" : `after ${ASKS} asks`}${opts.bestEffort ? " — going on without it" : ""}`, missKind);
    return null;
  };

  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  /**
   * Asks a calendar until every day is priced or a repeat ask adds nothing, since the provider omits days it won't price.
   * Still changing after CALENDAR_ASKS means unanswered. A mostly full calendar is re-asked with the cheaper `enough`.
   * `counts` limits what counts toward `expected` (a grid: stays up to GRID_MAX_STAY); `onAnswer` still gets every point.
   */
  const settleCalendar: Asker["settleCalendar"] = async (what, call, expected, onAnswer, counts) => {
    const held = new Set<string>();
    for (let ask = 1; ; ask++) {
      const enough = ask > 1 && held.size >= expected * 0.6 ? held.size : undefined;
      const pts = await must((s) => call(s, enough), ask > 1 ? `${what}, ask ${ask}` : what);
      if (!pts) return; // unanswered, already recorded
      const fresh = new Set(pts.filter((p) => p.price != null && (!p.returnDate || p.returnDate > p.outDate) && (!counts || counts(p))).map((p) => `${p.outDate}~${p.returnDate ?? ""}`));
      const added = [...fresh].filter((k) => !held.has(k)).length;
      const covers = fresh.size >= held.size * 0.9;
      for (const k of fresh) held.add(k);
      onAnswer(pts);
      if (held.size >= expected) return;
      if (ask > 1 && !added && covers) {
        log(`${cap(what)}: ${held.size} of ${expected}, and nothing new when asked again, so that's all of it`, "info");
        return;
      }
      if (ask >= CALENDAR_ASKS) {
        missed(`${what}, still changing after ${CALENDAR_ASKS} asks`);
        log(`${cap(what)}: ${held.size} of ${expected}, still changing after ${CALENDAR_ASKS} asks${opts.bestEffort ? " — keeping what came back" : ""}`, missKind);
        return;
      }
      log(`${cap(what)}: ${held.size} of ${expected}, asking again to make sure that's all`, "info");
      await pause(ASK_AGAIN_MS);
    }
  };

  return {
    must,
    settleCalendar,
    pause,
    unanswered,
    allAnswered: () => {
      if (unanswered.length) throw new Unanswered([...unanswered]);
    },
  };
}

/* -------------------------------- Endpoints ------------------------------- */

/** A place as queries use it: a place id or airport code (`q`), and the airports it covers. */
export type Endpoint = { q: string; airports: Set<string> };

/** Place → endpoint, one lookup per place. The live backend is rebuilt per search, so live lookups share a process-wide map. */
const LIVE_ENDPOINTS = new Map<string, Endpoint>();
const ENDPOINT_CACHES = new WeakMap<FlightBackend, Map<string, Endpoint>>();
function cacheFor(backend: FlightBackend): Map<string, Endpoint> {
  if (backend.live) return LIVE_ENDPOINTS;
  let cache = ENDPOINT_CACHES.get(backend);
  if (!cache) ENDPOINT_CACHES.set(backend, (cache = new Map()));
  return cache;
}

/**
 * Resolves a place to a query endpoint. A city grouping several airports becomes a place id that prices them all in one call;
 * anything else stays the airport code. An unanswered lookup falls back to the code and isn't cached.
 */
export async function resolveEndpoint(backend: FlightBackend, must: Asker["must"], place: { code: string; name: string }): Promise<Endpoint> {
  const fallback = { q: place.code, airports: metroCodes(place.code) };
  // Look up the table's city name, since a full airport name resolves to that airport alone.
  const name = AIRPORTS[place.code]?.city ?? place.name;
  const key = `${place.code}~${name.trim().toLowerCase()}`;
  const cache = cacheFor(backend);
  const cached = cache.get(key);
  if (cached) return cached;
  const hits = await must((signal) => backend.places(name, { signal, timeoutMs: 5_000 }), `places for ${name}`);
  if (!hits) return fallback;
  const hit = hits.find((h) => h.kind === "city" && h.airports.length >= 2 && h.airports.some((a) => a.code === place.code));
  const resolved = hit ? { q: hit.id, airports: new Set(hit.airports.map((a) => a.code)) } : fallback;
  if (hit) PLACE_NAMES.set(hit.id, name);
  cache.set(key, resolved);
  return resolved;
}

/** Airports a place's round trips are asked from: its own first, then grouped ones or those within 120 km, three at most. */
export function airportsOf(code: string, end: Endpoint | null | undefined): string[] {
  const near = end && isPlaceId(end.q) ? [...end.airports] : nearbyAirports(code, 120).map((a) => a.code);
  return [code, ...near.filter((c) => c !== code)].slice(0, AIRPORTS_PER_END);
}
