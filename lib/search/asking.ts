import { AIRPORTS, nearbyAirports } from "@/lib/airports";
import { isPlaceId, type Calendar, type CallOptions, type FlightBackend } from "@/lib/flights/backend";
import { asFlightsError } from "@/lib/flights/retry";
import type { DatePricePoint, SearchInput, ShoppingPayload } from "@/lib/flights/types";
import { PLACE_NAMES } from "./core";
import { metroCodes } from "./intake";

/**
 * Makes provider calls under a clock and records the ones that never answered. A search continues without them and says
 * so. A grid cell's flights, the chat's grid and a follow-up end with an error instead. Retrying happens inside the provider
 * (lib/flights/retry.ts), so each call is made once here and given the clock.
 */

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
  /** Makes one provider call with the clock. Returns null if it never answers, and records it in `unanswered`. */
  must: <T>(fn: (opts: CallOptions) => Promise<T>, what: string) => Promise<T | null>;
  /** Records a call that answered short of what was asked (a calendar that never settled) as a miss. */
  record: (what: string) => void;
  /** Removes a recorded miss when another source answered it. */
  covered: (what: string) => void;
  /** A pause the clock cuts short. */
  pause: (ms: number) => Promise<void>;
  /** Calls that never answered, in the order they gave up. */
  readonly unanswered: string[];
  /** Throws `Unanswered` when anything never answered. */
  allAnswered: () => void;
};

/**
 * `signal` is the only clock for every call: the caller's deadline, or when a search stage stops waiting. `onAsk` counts each
 * request the provider sends, for stats. With `bestEffort`, misses are logged but not recorded as unanswered (for optional
 * extras such as long-stay grid cells).
 */
export function asker(opts: { signal: AbortSignal; log?: Log; onAsk?: () => void; bestEffort?: boolean }): Asker {
  const { signal } = opts;
  const log: Log = opts.log ?? (() => {});
  const unanswered: string[] = [];
  const missed = (what: string) => {
    if (!opts.bestEffort) unanswered.push(what);
  };
  const missKind = opts.bestEffort ? "info" : "error";
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const without = opts.bestEffort ? " — going on without it" : "";

  const pause = (ms: number) =>
    new Promise<void>((done) => {
      const stop = () => (clearTimeout(t), done());
      const t = setTimeout(() => (signal.removeEventListener("abort", stop), done()), ms);
      signal.addEventListener("abort", stop, { once: true });
    });

  const must = async <T>(fn: (opts: CallOptions) => Promise<T>, what: string): Promise<T | null> => {
    if (!signal.aborted) {
      try {
        return await fn({
          signal,
          onAsk: opts.onAsk,
          onRetry: (why) => log(`  ${what} ✗ ${why.kind}: ${why.message.slice(0, 160)} — asking again`, missKind),
          note: (text) => log(`${cap(what)}: ${text}`, "info"),
        });
      } catch (e) {
        if (!signal.aborted) {
          missed(what);
          log(`  ${what}: ${asFlightsError(e).message.slice(0, 200)}${without}`, missKind);
          return null;
        }
      }
    }
    missed(what);
    log(`  ${what}: no answer in time${without}`, missKind);
    return null;
  };

  return {
    must,
    record: missed,
    covered: (what) => {
      const i = unanswered.indexOf(what);
      if (i >= 0) unanswered.splice(i, 1);
    },
    pause,
    unanswered,
    allAnswered: () => {
      if (unanswered.length) throw new Unanswered([...unanswered]);
    },
  };
}

/**
 * Asks a calendar through `ask`, passing what it holds to `take` as it fills in. Returns false when it never answered or
 * never settled, which counts as a miss. Returns true when the provider has no such calendar, since a feature that's off
 * isn't a gap.
 */
export async function askCalendar(ask: Asker, what: string, call: ((opts: CallOptions) => Promise<Calendar>) | null, take: (pts: DatePricePoint[]) => void): Promise<boolean> {
  if (!call) return true;
  let handed = false;
  const cal = await ask.must(
    (o) =>
      call({
        ...o,
        onProgress: (pts) => {
          handed = true;
          take(pts);
        },
      }),
    what
  );
  if (!cal) return false;
  if (!handed) take(cal.points);
  if (!cal.settled) ask.record(`${what}, still changing when the provider stopped asking`);
  return cal.settled;
}

/**
 * Asks the live provider for fares through `ask`, with a fallback provider in reserve. The fallback starts as soon as the
 * live provider first asks again (its `onRetry`) and is used only when the live one never answers. With `checkEmpty`, a live
 * answer with no fares is checked against the fallback too, since a provider can answer "no flights" for a search it hasn't
 * finished. A miss the fallback covers is removed from `unanswered`.
 */
export function faresAsker(x: { backend: FlightBackend; fallback: FlightBackend | null | undefined; ask: Asker; spare: Asker | null; log?: Log; onFallback?: () => void }) {
  const { backend, fallback, ask, spare } = x;
  const log: Log = x.log ?? (() => {});
  return async (input: SearchInput, what: string, o: { checkEmpty?: boolean } = {}): Promise<ShoppingPayload | null> => {
    const can = Boolean(fallback && spare && (fallback.covers?.(input) ?? true));
    let reserve: Promise<ShoppingPayload | null> | null = null;
    const askSpare = () => (reserve ??= spare!.must((co) => fallback!.shopping(input, co), `${what} (${fallback!.name})`));
    const live = await ask.must(
      (co) =>
        backend.shopping(input, {
          ...co,
          onRetry: (why) => {
            co.onRetry?.(why);
            if (can) askSpare();
          },
        }),
      what
    );
    if (!can) return live;
    if (live?.itineraries.length || (live && !o.checkEmpty)) return live;
    const other = await (reserve ?? askSpare());
    if (!other?.itineraries.length) return live;
    if (live) log(`  ${what}: ${backend.name} has no fares, ${fallback!.name} has ${other.itineraries.length}`, "info");
    else {
      ask.covered(what);
      log(`  ${what}: answered by ${fallback!.name} instead, ${other.itineraries.length} fares`, "info");
    }
    x.onFallback?.();
    return other;
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
/** The airports a place id covers, for a provider that doesn't know the id (the fallback). */
const PLACE_AIRPORTS = new Map<string, string[]>();
export const airportsOfPlace = (id: string): string[] | null => PLACE_AIRPORTS.get(id) ?? null;

/**
 * Resolves a place to a query endpoint. A city grouping several airports becomes a place id that prices them all in one call;
 * anything else stays the airport code. An unanswered lookup, or a provider without one, falls back to the code and isn't cached.
 */
export async function resolveEndpoint(backend: FlightBackend, must: Asker["must"], place: { code: string; name: string }): Promise<Endpoint> {
  const fallback = { q: place.code, airports: metroCodes(place.code) };
  if (!backend.places) return fallback;
  // Look up the table's city name, since a full airport name resolves to that airport alone.
  const name = AIRPORTS[place.code]?.city ?? place.name;
  const key = `${place.code}~${name.trim().toLowerCase()}`;
  const cache = cacheFor(backend);
  const cached = cache.get(key);
  if (cached) return cached;
  const hits = await must((o) => backend.places!(name, o), `places for ${name}`);
  if (!hits) return fallback;
  const hit = hits.find((h) => h.kind === "city" && h.airports.length >= 2 && h.airports.some((a) => a.code === place.code));
  const resolved = hit ? { q: hit.id, airports: new Set(hit.airports.map((a) => a.code)) } : fallback;
  if (hit) {
    PLACE_NAMES.set(hit.id, name);
    PLACE_AIRPORTS.set(hit.id, hit.airports.map((a) => a.code));
  }
  cache.set(key, resolved);
  return resolved;
}

/** Airports a place's round trips are asked from: its own first, then grouped ones or those within 120 km, three at most. */
export function airportsOf(code: string, end: Endpoint | null | undefined): string[] {
  const near = end && isPlaceId(end.q) ? [...end.airports] : nearbyAirports(code, 120).map((a) => a.code);
  return [code, ...near.filter((c) => c !== code)].slice(0, AIRPORTS_PER_END);
}
