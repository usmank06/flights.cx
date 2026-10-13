import { isPlaceId, type FlightBackend } from "@/lib/flights/backend";
import { countsInGrid, gridCellCount, longStays } from "@/lib/flights/calendar";
import { bookingFor } from "@/lib/flights/provider";
import type { BookingContext, DatePricePoint, ExploreDestination, SearchInput, ShoppingPayload } from "@/lib/flights/types";
import { AIRPORTS } from "@/lib/airports";
import { countryCode, countryName } from "@/lib/countries";
import { dayRange, money, shortDate } from "@/lib/format";
import type {
  DestinationView,
  FlightPlan,
  GridCell,
  GridVia,
  GridView,
  HintsView,
  Incomplete,
  InsightsView,
  PlanView,
  SearchPhase,
  SearchRequest,
  SearchStats,
  SearchView,
  SessionState,
  UnencodedField,
  Verdict,
} from "@/lib/types";
import { seatedTravellers } from "@/lib/types";
import { noteRouteSwaps } from "./assemble";
import { airportsOf as airportsFor, asker, resolveEndpoint as lookUpEndpoint, SHOPPING_TIMEOUT_MS, type Asker } from "./asking";
import { bookableFor, CandidatePool, stayNights } from "./candidates";
import { compactForLLM, daysBetween, describeInput, PLACE_NAMES, itinToLeg, languageTag, queryFor, shiftDay, tripFacts, type IndexedItin } from "./core";
import { metroCodes } from "./intake";
import type { JevClient } from "./jev";
import type { ModelOption } from "./models";
import { DEFAULT_LABEL, hoursScore, pickPlans, type Pairing, type PickOutcome, type SlotPick } from "./pick";
import { describesAPlace, requestFromPlan, TravellerError, type PlanOutcome, type TripPlan } from "./plan";
import { tierWord, type ExploreAgent, type KnownPlace } from "./explore-agent";
import { areaOf, gatewaysOf, inArea } from "./area";
import { narrate } from "./voice";

/**
 * Runs one search. The planner reads the trip, then code prices it in stages (plan, price, widen, pick, write, assemble).
 * Provider calls retry until they answer or their stage stops waiting. The search continues without anything that never
 * answered and says so on the page. Model calls have their own timeouts and fall back to code.
 */

export type LogKind = "info" | "action" | "success" | "error";
export type EngineHooks = {
  log: (text: string, kind?: LogKind) => void;
  phase: (phase: SearchPhase) => void;
};
/** `again`: the retry after a failed plan, sampled so it can differ from the first answer. */
export type Planner = (req: SearchRequest, opts: { signal?: AbortSignal; timeoutMs?: number; again?: boolean }) => Promise<PlanOutcome>;
export type EngineDeps = {
  backend: FlightBackend;
  /** null: nothing can read the trip, so every search ends with an error. */
  planner: Planner | null;
  /** Open destinations: picks places to price (up to three rounds) and what to show. null: price the cheapest, Jev picks. */
  explorer?: ExploreAgent | null;
  /** null: code ranks. */
  jev: JevClient | null;
  /** null: code writes the lines. */
  voice: ModelOption | null;
  now?: () => number;
};
/**
 * A search that read the trip but found nothing to show. It carries the request and plan, so the failed search can still
 * show its trip and Edit can start from it.
 */
export class SearchFailure extends TravellerError {
  constructor(
    message: string,
    readonly ran: { request: SearchRequest; plan: PlanView }
  ) {
    super(message);
    this.name = "SearchFailure";
  }
}

export type EngineOutcome = {
  /** The request as run: fields a control set, the rest as the planner read them (requestFromPlan). */
  request: SearchRequest;
  plans: FlightPlan[];
  analysis: string;
  verdict: Verdict;
  view: SearchView;
  plan: PlanView;
  session: SessionState;
  stats: SearchStats;
  unencoded: UnencodedField[];
};

/** Search deadlines. Open-destination searches run several rounds, so they get longer. Both stay under the route's 200 s limit. */
export const DEFAULT_DEADLINE_MS = 120_000;
export const OPEN_DEADLINE_MS = 176_000;
/** Grid cells (and hinted dates) the engine buys real itineraries for. */
const CELLS_TO_PRICE = 6;
/** Extra cells for the stated preference (longest or shortest stays). */
const CELLS_FOR_PREFERENCE = 3;
/** Places the engine buys real itineraries for on an open search when no model is choosing. */
const PLACES_TO_PRICE = 8;
/** When fewer places than this are listed in a named country or region, its main airports from the table are added. */
const AREA_SEEDS = 4;
/** Open-destination agent limits: rounds, look-ups per round, places priced per round, plans shown. */
const EXPLORE_ROUNDS = 3;
const LOOKUPS_PER_ROUND = 8;
const PLACES_PER_ROUND = 12;
const MAX_PLACE_PLANS = 3;
/** One-way tickets each way kept for pairing. */
const ONE_WAYS_TO_PAIR = 8;
/**
 * When each stage stops waiting for its lookups, as a share of the deadline, so later stages keep their time (60, 90 and
 * 105 s of a named trip's 120). Anything unanswered by then is left out, and the page says so (`Verdict.incomplete`).
 */
const STOP_AT = { pricing: 0.5, widening: 0.75, returns: 0.875 } as const;
type Stage = keyof typeof STOP_AT;
/** How long stays past three weeks can keep the first stage waiting once its other calls are done, never past its stop. */
const LONG_STAYS_GRACE_MS = 4_000;

/** One origin × destination pair: airport codes to show (o, d) and query endpoints (oq, dq), which may be place ids. */
export type Combo = { o: string; d: string; oq: string; dq: string };
export type GridSource = { o: string; d: string; cells: Map<string, number> };

const cellKey = (out: string, ret: string) => `${out}~${ret}`;
const daysOf = (w: [string, string]): string[] => {
  const out: string[] = [];
  for (let d = w[0]; d <= w[1]; d = shiftDay(d, 1)) out.push(d);
  return out;
};
const union = (sets: Set<string>[]) => new Set(sets.flatMap((s) => [...s]));

export async function runSearch(
  req: SearchRequest,
  deps: EngineDeps,
  hooks: EngineHooks,
  opts: { deadlineMs?: number } = {}
): Promise<EngineOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const left = () => deadlineMs - (now() - t0);
  const killer = new AbortController();
  let killTimer = setTimeout(() => killer.abort(), deadlineMs);
  const { backend } = deps;
  const log = hooks.log;
  const fmt = (n: number) => money(n, req.currency, req.locale);

  const pool = new CandidatePool();
  /** City photos by airport code from shopping answers, for places missing from the explore list. */
  const photos = new Map<string, string>();
  let queries = 0;
  const notes: string[] = [];
  let jevUsage: { in: number; out: number; costUsd: number | null } | null = null;
  let voiceUsage: { in: number; out: number; costUsd: number | null } | null = null;
  const agentUsages: { in: number; out: number; costUsd: number | null }[] = [];
  /** The explore agent's short reason per place, shown on the cards. */
  const whyPlace: Record<string, string> = {};

  // Integer milliseconds: AbortSignal.timeout rejects a fractional delay, and the clock may be fractional.
  const untilMs = (stageEnd: number) => Math.floor(Math.max(500, Math.min(stageEnd - now(), left() - 500)));
  /** Runs a model call under the search deadline and its own timeout. Returns null instead of throwing. */
  const guarded = async <T>(stageEnd: number, fn: (signal: AbortSignal) => Promise<T>, what: string): Promise<T | null> => {
    if (left() <= 800 || stageEnd - now() <= 300) return null;
    try {
      return await fn(AbortSignal.any([killer.signal, AbortSignal.timeout(untilMs(stageEnd))]));
    } catch (e) {
      log(`  ${what} ✗ ${(e as Error).message.slice(0, 160)}`, "error");
      return null;
    }
  };

  // Each stage has its own asker, stopped at its share of the deadline (`STOP_AT`). Calls retry until they answer or their
  // stage stops, and the search continues without anything that never answered.
  const stops: Record<Stage, AbortController> = { pricing: new AbortController(), widening: new AbortController(), returns: new AbortController() };
  const stopTimers: ReturnType<typeof setTimeout>[] = [];
  const untilStop = (stage: Stage) => deadlineMs * STOP_AT[stage] - (now() - t0);
  const armStops = () => {
    for (const t of stopTimers.splice(0)) clearTimeout(t);
    for (const stage of Object.keys(STOP_AT) as Stage[]) stopTimers.push(setTimeout(() => stops[stage].abort(), Math.max(0, Math.floor(untilStop(stage)))));
  };
  armStops();
  const askerFor = (stage: Stage, bestEffort = false) => asker({ signal: AbortSignal.any([killer.signal, stops[stage].signal]), log, onAsk: () => queries++, bestEffort });
  const pricing = askerFor("pricing");
  // Widening's calls, including early cell buys, and an open search's places.
  const widening = askerFor("widening");
  const returning = askerFor("returns");
  // Stays past three weeks only add grid cells, and the provider answers them unreliably, so a miss isn't counted as a gap.
  const extra = askerFor("widening", true);
  /** Lookups that never answered in time, for the note on the page (`Verdict.incomplete`). Dates are keyed by days and route. */
  const gaps = { dates: new Map<string, { outDate: string; returnDate: string | null; o: string; d: string }>(), grid: false, other: 0 };
  const unconfirmed = (outDate: string, returnDate: string | null, o: string, d: string) => gaps.dates.set(`${outDate}~${returnDate ?? ""}~${o}~${d}`, { outDate, returnDate, o, d });
  /** Counts an unanswered lookup as a gap and passes the answer through. */
  const counted = <T>(answer: T | null): T | null => {
    if (answer == null) gaps.other++;
    return answer;
  };
  /** Marks the grid incomplete when one of its calendars never answered or never stopped changing. */
  const gridGap = (settled: boolean) => {
    if (!settled) gaps.grid = true;
  };

  try {
    hooks.phase("starting");

    /** A place as a query endpoint: a place id grouping several airports, or the airport code (asking.ts). */
    const resolveEndpoint = (place: { code: string; name: string }, ask = pricing) => lookUpEndpoint(backend, ask.must, place);
    /*
     * Round trips are asked by airport code, since a place id is much slower for them and often dearer for the same flights.
     * One-ways, grids and graphs use the place, where one call covers all its airports. See `roundTrips`.
     */
    /** Asks one shopping call through a stage's asker until it answers or the stage stops. */
    const askShopping = (ask: Asker, input: SearchInput, what: string, attempts = 2) =>
      ask.must((signal) => backend.shopping(input, { signal, hedgeMs: 2_000, timeoutMs: SHOPPING_TIMEOUT_MS, attempts }), what);
    /** Adds an answer's fares to the pool. */
    const take = (payload: ShoppingPayload, input: SearchInput, what: string, shift?: { out: number; ret: number }) => {
      const added = pool.add(payload.itineraries, input, queries, shift);
      for (const pl of payload.places ?? []) if (pl.image && !photos.has(pl.code)) photos.set(pl.code, pl.image);
      const cheapest = Math.min(...payload.itineraries.map((i) => i.price ?? Infinity));
      log(`  ${describeInput(input)} → ${payload.itineraries.length} itineraries${Number.isFinite(cheapest) ? ` from ${fmt(cheapest)}` : ""} — ${what}`, "info");
      return { payload, added };
    };
    const shop = (ask: Asker, input: SearchInput, what: string, shift?: { out: number; ret: number }, attempts = 2) =>
      askShopping(ask, input, what, attempts).then((payload) => (payload ? take(payload, input, what, shift) : null));

    // An object rather than `let`s: the payloads are assigned in callbacks, and narrowing would treat a `let` as always null.
    const got: { baseline: ShoppingPayload | null; bagless: ShoppingPayload | null } = { baseline: null, bagless: null };
    const oneWays: { out: IndexedItin[]; ret: IndexedItin[] } = { out: [], ret: [] };
    /** Destinations whose own search didn't fully answer in time (`ownSearch`). Widening can still buy those dates. */
    const ownUnanswered = new Set<string>();
    /** Own searches (on fixed dates, or from another origin) that never fully answered. Nothing retries them. */
    const ownMissing = new Set<string>();

    /* ---- Stage 0: plan ---- */
    hooks.phase("planning");
    log("Reading your trip…", "action");
    // Only the planner reads the trip. A failed plan gets one sampled retry, and a second failure ends the search. Timeouts
    // are 25 s, then 20 s, since a long request can take the planner up to 18 s.
    if (!deps.planner) throw new TravellerError("Search isn't working right now. Try again in a moment.");
    const t = now();
    const attempt = async (again = false): Promise<PlanOutcome> => {
      try {
        return await deps.planner!(req, { signal: killer.signal, timeoutMs: Math.floor(Math.max(2_000, Math.min(again ? 20_000 : 25_000, left() - 28_000))), again });
      } catch (err) {
        return { plan: null, usage: null, ms: now() - t, failure: `the planner failed: ${(err as Error).message}` };
      }
    };
    let planOutcome = await attempt();
    if (!planOutcome.plan) {
      log(`The planner did not give a plan that can be searched (${planOutcome.failure}) — asking once more`, "info");
      log("Taking another look at your trip…", "action");
      const first = planOutcome;
      const again = await attempt(true);
      if (!again.plan) {
        log(`Asked twice, no plan that can be searched (${again.failure})`, "error");
        // The planner's reason if the trip itself is unusable. Otherwise a generic message that doesn't blame the traveller.
        const said = again.said ?? first.said;
        throw new TravellerError(said ?? "We couldn't read your trip in time. Search again in a moment.", Boolean(said));
      }
      planOutcome = { ...again, ms: now() - t };
    }
    const plan = planOutcome.plan!;
    // Every query below uses the request as the planner read it.
    req = requestFromPlan(req, plan);
    log(`Understood: ${plan.understood}`, "success");
    const failed = (message: string) => new SearchFailure(message, { request: req, plan: toPlanView(plan) });
    /** With nothing to show, an unanswered lookup means the search couldn't finish, not that there are no flights. */
    const unfinished = () => (pricing.unanswered.length + widening.unanswered.length ? "We couldn't finish this search. Try it again in a moment." : null);
    notes.push("Brief read by the planner");

    const origins = plan.origins.map((p) => p.code);
    const dests = plan.destinations.map((p) => p.code);
    const open = dests.length === 0;
    if (open && opts.deadlineMs == null) {
      // Open searches run several rounds, so they switch to the longer deadline.
      deadlineMs = OPEN_DEADLINE_MS;
      clearTimeout(killTimer);
      killTimer = setTimeout(() => killer.abort(), Math.max(1_000, deadlineMs - (now() - t0)));
      armStops();
      log("An open destination may take up to three minutes", "info");
    }
    const from = origins[0];
    const outDate = plan.dates.anchor.out;
    const retDate = plan.dates.anchor.ret;
    const outWin = plan.dates.out;
    const retWin = plan.dates.ret;
    const flexible = outWin[0] !== outWin[1] || (!!retWin && retWin[0] !== retWin[1]);
    const kind: SearchView["kind"] = open ? "open" : flexible ? "flexible" : "closed";
    const ends = new Map<string, { q: string; airports: Set<string> }>();
    await Promise.all([...plan.origins, ...plan.destinations].map(async (p) => ends.set(p.code, await resolveEndpoint(p))));
    // If a place lookup never answered, the one-ways and the grid use the place's own airport.
    gaps.other += pricing.unanswered.length;
    const endpointOf = (code: string) => ends.get(code)?.q ?? code;
    const okFrom = union(origins.map((c) => ends.get(c)?.airports ?? metroCodes(c)));
    const okTo = open ? new Set<string>() : union(dests.map((c) => ends.get(c)?.airports ?? metroCodes(c)));
    const combos: Combo[] = open ? [] : origins.flatMap((o) => dests.map((d) => ({ o, d, oq: endpointOf(o), dq: endpointOf(d) })));
    const grouped = [...ends.values()].filter((x) => isPlaceId(x.q)).length;
    if (grouped) log(`${grouped} place${grouped > 1 ? "s" : ""} with several airports: one-ways and the grid asked for all of them at once, round trips by airport`, "info");
    const placeName = (code: string) => plan.origins.find((p) => p.code === code)?.name ?? plan.destinations.find((p) => p.code === code)?.name ?? AIRPORTS[code]?.city ?? code;
    const destsLine = plan.destinations.map((p) => p.name).join(" or ");
    const unencoded = backend.declareUnencoded(queryFor(req, from, dests[0] ?? "AAA", outDate, retDate));
    for (const u of unencoded) log(u.note, "info");

    // The provider omits insights and hints when a bag filter is set, so a bagless call supplies them. It never sets the baseline.
    const withInsights = (): ShoppingPayload | null =>
      got.baseline?.insights ? got.baseline : got.bagless?.insights ? got.bagless : (got.baseline ?? got.bagless);
    const grids: GridSource[] = [];
    const graphsOut = new Map<string, Map<string, number>>(); // `${o}~${d}` → date → price
    const graphsBack = new Map<string, Map<string, number>>(); // `${d}~${o}` → date → price
    let explore: ExploreDestination[] = [];
    /** Airports a place's round trips are asked from: its own first, then grouped or nearby ones, three at most. */
    const airportsOf = (code: string): string[] => airportsFor(code, ends.get(code));
    /** One round trip's calls, one per airport pair at both ends. An open-jaw trip keeps its own arrival and return airports. */
    const roundTripCalls = (o: string, d: string, out: string, ret: string | null, what: string, back?: string) =>
      airportsOf(o).flatMap((f) =>
        (back && back !== d ? [d] : airportsOf(d)).map((t) => ({ input: queryFor(req, f, t, out, ret, "", back && back !== d ? back : undefined), what: `${what}${f !== o ? ` from ${f}` : ""}${t !== d ? ` into ${t}` : ""}` }))
      );
    /** Buys one round trip, a call per airport pair at both ends. */
    const roundTrips = (ask: Asker, o: string, d: string, out: string, ret: string | null, what: string, shift: { out: number; ret: number }, attempts = 2, back?: string) =>
      Promise.all(roundTripCalls(o, d, out, ret, what, back).map((c) => shop(ask, c.input, c.what, shift, attempts)));
    /**
     * Their own search, for when the grid also prices the asked dates. Returns each airport's call and answer, or null if any
     * call never answered. All or nothing, so a dearer airport's fares can't stand in for the dates on their own.
     */
    const ownSearch = async (o: string, d: string, what: string) => {
      const calls = roundTripCalls(o, d, outDate, retDate, what);
      const answers = await Promise.all(calls.map((c) => askShopping(pricing, c.input, c.what)));
      return answers.every(Boolean) ? calls.map((c, i) => ({ ...c, payload: answers[i]! })) : null;
    };
    /** Of the answers for one trip from several airports, the one with the cheapest fare. */
    const cheapestOf = (rs: ({ payload: ShoppingPayload } | null)[]): ShoppingPayload | null => {
      const low = (p: ShoppingPayload) => Math.min(...p.itineraries.map((i) => i.price ?? Infinity));
      return rs.flatMap((r) => (r ? [r.payload] : [])).sort((a, b) => low(a) - low(b))[0] ?? null;
    };
    const noteBaseline = (payload: ShoppingPayload | null, d: string) => {
      if (!payload) return;
      const cheapest = Math.min(...payload.itineraries.map((i) => i.price ?? Infinity));
      if (!Number.isFinite(cheapest)) return;
      if (pool.baseline == null || cheapest < pool.baseline) {
        pool.baseline = cheapest;
        got.baseline = payload;
      }
      if (combos.length > 1) log(`  Your own search to ${placeName(d)} comes to ${fmt(cheapest)}`, "info");
    };

    /**
     * Buys a grid cell as one ticket, into the cell's airport and back from its return airport. A call that never answers
     * leaves the cell unconfirmed.
     */
    const buyCell = (c: GridCell, attempts: number) => {
      const ret = retWin ? c.returnDate : null;
      const shift = { out: daysBetween(outDate, c.outDate), ret: retDate && ret ? daysBetween(retDate, ret) : 0 };
      const to = c.via?.out ?? dests[0];
      const back = c.via?.back ?? to;
      const what = `dates ${c.outDate}${ret ? ` → ${ret}` : ""}${back !== to ? ` (back from ${back})` : combos.length > 1 ? ` to ${to}` : ""}`;
      return roundTrips(widening, from, to, c.outDate, ret, what, shift, attempts, back).then((rs) => {
        if (!rs.every(Boolean)) unconfirmed(c.outDate, ret, from, to);
        return rs;
      });
    };
    /** One direction on its own, kept with the one-ways for pairing. */
    const buyOneWay = (leg: "out" | "back", a: string, b: string, day: string, shift: number, attempts: number) => {
      const list = leg === "out" ? oneWays.out : oneWays.ret;
      return shop(widening, queryFor(req, a, b, day, null), leg === "out" ? `one-way to ${b} on ${day}` : `one-way back from ${a} on ${day}`, leg === "out" ? { out: shift, ret: 0 } : { out: 0, ret: shift }, attempts).then((r) => {
        if (r) list.push(...r.added);
        else gaps.other++;
      });
    };
    /** A fare the trip as asked could book: asked airports, on days the plan allows. Fares for nearby-airport hints fail this. */
    const usable = (x: IndexedItin) => bookableFor(x, req, okFrom, okTo, { out: outWin, ret: retWin });
    /** The cheapest fares bought for a grid cell's days and airports: as one ticket, and each direction alone. */
    const faresOn = (c: GridCell) => {
      const near = (code: string) => (metroCodes(code).size ? metroCodes(code) : new Set([code]));
      const into = near(c.via?.out ?? dests[0]);
      const outOf = near(c.via?.back ?? c.via?.out ?? dests[0]);
      const day = (x: IndexedItin) => x.itin.departure.slice(0, 10);
      const cheapest = (xs: IndexedItin[]) => Math.min(...xs.map((x) => x.itin.price ?? Infinity));
      return {
        one: retWin
          ? cheapest(pool.all().filter((x) => x.rt && usable(x) && x.retDate === c.returnDate && day(x) === c.outDate && into.has(x.itin.to) && outOf.has(x.jaw?.from ?? x.itin.to)))
          : cheapest(pool.all().filter((x) => !x.rt && usable(x) && day(x) === c.outDate && into.has(x.itin.to))),
        out: cheapest(oneWays.out.filter((x) => okFrom.has(x.itin.from) && day(x) === c.outDate && into.has(x.itin.to))),
        back: cheapest(oneWays.ret.filter((x) => okFrom.has(x.itin.to) && day(x) === c.returnDate && outOf.has(x.itin.from))),
      };
    };
    const boughtOn = (c: GridCell): number | null => {
      const f = faresOn(c);
      const price = retWin && c.via?.tickets === "two" ? f.out + f.back : f.one;
      return Number.isFinite(price) ? price : null;
    };
    // The cheapest grid cells are bought as soon as their grid arrives, so a slow first stage can't leave them unbought.
    // Widening skips them.
    const EARLY_CELLS = 2;
    const early: Promise<unknown>[] = [];
    /** Waits until every job has settled, including jobs added while waiting. */
    const drain = async (...lists: Promise<unknown>[][]) => {
      const count = () => lists.reduce((n, l) => n + l.length, 0);
      for (let waited = -1; waited !== count(); ) {
        waited = count();
        await Promise.allSettled(lists.flat());
      }
    };
    const takeGrid = (o: string, d: string, pts: DatePricePoint[] | null) => {
      let g = grids.find((x) => x.d === d);
      if (!g) grids.push((g = { o, d, cells: new Map() }));
      for (const p of pts ?? []) if (p.returnDate && p.price != null) g.cells.set(cellKey(p.outDate, p.returnDate), Math.min(g.cells.get(cellKey(p.outDate, p.returnDate)) ?? Infinity, p.price));
      if (g.cells.size) log(`Price grid to ${d}: ${g.cells.size} date pairs, cheapest ${fmt(Math.min(...g.cells.values()))}`, "success");
      return g.cells.size;
    };
    const askedCells = new Set<string>();
    const cellKeyOf = (c: GridCell) => `${c.outDate}~${c.returnDate}~${c.via?.tickets ?? "one"}~${c.via?.out ?? ""}~${c.via?.back ?? ""}`;
    const buyEarly = (d: string) => {
      const g = grids.find((x) => x.d === d);
      if (!g || !retWin || !retDate) return;
      const asked = g.cells.get(cellKey(outDate, retDate));
      const cheapest = [...g.cells].filter(([k, price]) => k !== cellKey(outDate, retDate) && (asked == null || price < asked * 1.02)).sort((a, b) => a[1] - b[1]);
      let bought = 0;
      for (const [k, price] of cheapest) {
        if (bought >= EARLY_CELLS) break;
        const [o, r] = k.split("~");
        const c: GridCell = { outDate: o, returnDate: r, price, via: { tickets: "one", out: d, back: d } };
        if (askedCells.has(cellKeyOf(c))) continue;
        askedCells.add(cellKeyOf(c));
        bought++;
        early.push(buyCell(c, 2));
      }
    };

    /* ---- Stage 1: price ---- */
    hooks.phase(open ? "exploring" : "pricing");
    /** Merges a graph answer into its map, keeping the cheapest price per day. */
    const takeGraph = (graphs: Map<string, Map<string, number>>, key: string, pts: DatePricePoint[]) => {
      const m = graphs.get(key) ?? new Map<string, number>();
      for (const p of pts) if (p.price != null) m.set(p.outDate, Math.min(m.get(p.outDate) ?? Infinity, p.price));
      graphs.set(key, m);
    };

    // A named country or region ("China", "Europe"). Shown places must be inside it, whatever the model picks.
    const area = open ? areaOf(plan.openHint) : null;
    if (open) {
      log(`Looking at where you could go from ${placeName(from)}${plan.dates.anchor.out ? " on those dates" : ""}…`, "action");
      const found = await pricing.must(
        (signal) =>
          backend.explore(from, {
            signal,
            timeoutMs: 8_000,
            dates: { out: outDate, ret: retDate },
            passengers: [Math.max(1, req.passengers.adults), req.passengers.children, req.passengers.infantsInSeat, req.passengers.infantsOnLap],
            seat: req.cabin,
            currency: req.currency,
            carryOnBags: req.bags.carryOn || undefined,
            checkedBags: req.bags.checked || undefined,
          }),
        "explore"
      );
      if (!found) gaps.other++;
      explore = (found ?? []).filter((d) => d.code && d.code !== from && !okFrom.has(d.code));
      const kept = abroadOnly(explore, from, plan.openHint);
      if (kept.length !== explore.length) log(`Keeping the ${kept.length} places outside ${countryName(AIRPORTS[from]?.country) ?? "the country"}, as asked`, "info");
      explore = kept;
      // The provider's list is mostly nearby places, so a distant area may have nothing listed.
      if (area) {
        const inside = explore.filter((d) => !!d.code && inArea(area, d.code, d.country));
        log(inside.length ? `Keeping the ${inside.length} places in ${area.label}, as asked` : `Nothing listed in ${area.label} from ${placeName(from)}, so looking there directly`, "info");
        explore = inside;
      }
      const priced = explore.filter((d) => d.price != null);
      log(`${priced.length} places priced from ${placeName(from)}${area ? ` in ${area.label}` : ""}${priced[0] ? ` — cheapest is ${priced[0].name} at ${fmt(priced[0].price!)}` : ""}`, priced.length ? "success" : area ? "info" : "error");
      notes.push(`Explore: ${priced.length} destinations priced`);
    } else {
      log(`Pricing ${placeName(from)} to ${destsLine} exactly as you asked…`, "action");
      const jobs: Promise<unknown>[] = [];
      const longJobs: Promise<unknown>[] = [];
      const base = queryFor(req, combos[0].o, combos[0].d, outDate, retDate, "your own search");
      // For flexible round trips the grid also prices the asked dates, so if their own search doesn't fully answer, widening can
      // buy those dates like any other cell. Widening only buys from the first origin, so other origins' searches aren't retried.
      const ownOptional = flexible && !!retWin && !!retDate;
      const ownWhat = (d: string) => (combos.length > 1 ? `your own search to ${d}` : "your own search");
      for (const { o, d } of combos) {
        if (ownOptional && o === from)
          jobs.push(
            ownSearch(o, d, ownWhat(d)).then((calls) => {
              if (!calls) return void ownUnanswered.add(d);
              noteBaseline(cheapestOf(calls.map((c) => take(c.payload, c.input, c.what, { out: 0, ret: 0 }))), d);
            })
          );
        else
          jobs.push(
            roundTrips(pricing, o, d, outDate, retDate, ownWhat(d), { out: 0, ret: 0 }).then((rs) => {
              if (rs.every(Boolean)) return noteBaseline(cheapestOf(rs), d);
              // Its fares are real and stay in the pool, but the cheapest of the airports that answered isn't a fair baseline.
              ownMissing.add(`${o}~${d}`);
              unconfirmed(outDate, retDate, o, d);
            })
          );
      }
      if (req.bags.carryOn || req.bags.checked) {
        // For insights and hints only. These fares lack the asked bags, so they stay out of the pool. Widening uses the hints,
        // so this call is awaited like the rest.
        const bagless: SearchInput = { ...base, carry_on_bags: undefined, checked_bags: undefined };
        jobs.push(askShopping(pricing, bagless, "price insights").then((p) => void (got.bagless = counted(p))));
      }
      if (retDate) {
        // Each direction as a one-way, for pairing across carriers (and across airports when mixing is allowed).
        const keep = (list: IndexedItin[]) => (r: { added: IndexedItin[] } | null) => {
          if (r) list.push(...r.added);
          else gaps.other++;
        };
        for (const { d, oq, dq } of combos) {
          jobs.push(shop(pricing, queryFor(req, oq, dq, outDate, null), `outbound to ${d} on its own`, { out: 0, ret: 0 }).then(keep(oneWays.out)));
          jobs.push(shop(pricing, queryFor(req, dq, oq, retDate, null), `return from ${d} on its own`, { out: 0, ret: 0 }).then(keep(oneWays.ret)));
        }
      }
      if (flexible && retWin) {
        // A round-trip grid per destination and one-way graphs each way, so a cell can be the cheaper of one ticket or two.
        const expected = gridCellCount(outWin, retWin);
        // Stays past the grid's 21 days are asked per length, at most eight, nearest the preferred (or asked) stay first.
        const preferStay = plan.dates.prefer === "longest" ? daysBetween(outWin[0], retWin[1]) : plan.dates.prefer === "shortest" ? daysBetween(outWin[1], retWin[0]) : retDate ? daysBetween(outDate, retDate) : 0;
        for (const { o, d, oq, dq } of combos) {
          const q = queryFor(req, oq, dq, outDate, retDate);
          // One-ticket prices for every pair of days. 15 s timeout, since a cold grid can take ~12 s.
          jobs.push(
            pricing.settleCalendar(`price grid to ${d}`, (signal, enough) => backend.dateGrid(q, outWin, retWin, { signal, settleMs: 8_000, timeoutMs: 15_000, hedgeMs: 2_500, enough }), expected, (pts) => {
              takeGrid(o, d, pts);
              buyEarly(d);
            }, countsInGrid).then(gridGap)
          );
          // The grid can omit stays past three weeks, so a price graph per stay length fills them in (also as one ticket).
          for (const stay of longStays(outWin, retWin, preferStay))
            longJobs.push(
              extra.settleCalendar(`${stay.days}-day trips to ${d}`, (signal, enough) => backend.priceGraph(q, stay.range, [stay.days, stay.days], { signal, settleMs: 8_000, timeoutMs: 15_000, hedgeMs: 2_500, enough }), stay.cells, (pts) =>
                takeGrid(o, d, pts.filter((p) => p.returnDate && p.returnDate >= retWin[0] && p.returnDate <= retWin[1]))
              )
            );
          if (plan.separateTickets) {
            jobs.push(pricing.settleCalendar(`one-way prices to ${d} by date`, (signal, enough) => backend.priceGraph(queryFor(req, oq, dq, outDate, null), outWin, [1, 1], { signal, settleMs: 2_500, timeoutMs: 5_000, hedgeMs: 1_500, enough }), daysOf(outWin).length, (pts) => takeGraph(graphsOut, `${o}~${d}`, pts)).then(gridGap));
            jobs.push(pricing.settleCalendar(`one-way prices back from ${d} by date`, (signal, enough) => backend.priceGraph(queryFor(req, dq, oq, retDate ?? retWin[0], null), retWin, [1, 1], { signal, settleMs: 2_500, timeoutMs: 5_000, hedgeMs: 1_500, enough }), daysOf(retWin).length, (pts) => takeGraph(graphsBack, `${d}~${o}`, pts)).then(gridGap));
          }
        }
      } else if (flexible) {
        for (const { o, d, oq, dq } of combos)
          jobs.push(pricing.settleCalendar(`prices to ${d} by departure date`, (signal, enough) => backend.priceGraph(queryFor(req, oq, dq, outDate, null), outWin, [1, 1], { signal, settleMs: 2_500, timeoutMs: 5_000, hedgeMs: 1_500, enough }), daysOf(outWin).length, (pts) => takeGraph(graphsOut, `${o}~${d}`, pts)).then(gridGap));
      }
      // Every call here is asked until it answers or the first stage stops (`STOP_AT`).
      await Promise.allSettled(jobs);
      // Long stays only add cells, so they get a short grace period. A late answer still lands in the grid before it's rebuilt.
      if (longJobs.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cutoff = new Promise<void>((res) => (timer = setTimeout(res, Math.max(0, Math.floor(Math.min(LONG_STAYS_GRACE_MS, untilStop("pricing")))))));
        await Promise.race([Promise.allSettled(longJobs), cutoff]);
        clearTimeout(timer);
      }
      // An own search that didn't answer leaves its dates to the grid's price and to widening.
      for (const d of ownUnanswered) {
        const what = ownWhat(d);
        const priced = grids.some((g) => g.d === d && g.cells.has(cellKey(outDate, retDate ?? "")));
        log(`${what.charAt(0).toUpperCase()}${what.slice(1)} didn't answer from every airport in time, so none of it is kept${priced ? "; the grid prices those dates" : ", and the grid has no price for those dates"}`, "info");
      }
      if (pool.baseline != null && !ownUnanswered.size && !ownMissing.size) log(`Your own search comes to ${fmt(pool.baseline)}${combos.length > 1 ? ` at best, across ${combos.length} searches` : ""}`, "success");
      const ins = withInsights()?.insights;
      if (ins?.level) log(`Prices for this trip are currently ${ins.level}`, "info");
      const asked = (codes: string[]) => [...new Set(codes.flatMap(airportsOf))].join("/");
      notes.push(`Priced the trip as asked${combos.length > 1 ? ` to ${combos.length} places` : ""}, round trips from ${asked(origins)} to ${asked(dests)}${retDate ? ", both directions on their own" : ""}${grids.length ? `, ${grids.length} price grid${grids.length > 1 ? "s" : ""}` : ""}${graphsOut.size ? `, ${graphsOut.size + graphsBack.size} one-way price graphs` : ""}`);
      if (ownUnanswered.size) notes.push(`The round trip on their own dates${combos.length > 1 ? ` to ${[...ownUnanswered].join(" and ")}` : ""} didn't answer from every airport in time, so none of its fares were kept; the grid priced those dates`);
      if (ownMissing.size) notes.push(`The round trip on their own dates${combos.length > 1 ? ` (${[...ownMissing].map((k) => k.replace("~", " to ")).join(", ")})` : ""} didn't answer from every airport in time, so it isn't compared against`);
    }

    /* ---- Open destination: the rounds, and the model's choice ---- */
    // For a brief describing a kind of place, the agent runs up to three rounds. Each round it sees the known places as words
    // (no fares), chooses listed ones to price and names unlisted ones to look up. Then it picks what to show. A bare "anywhere"
    // skips the rounds. If the agent fails, code prices the cheapest places and Jev picks.
    type Known = { code: string; name: string; country: string | null; endpoint: string; airports: Set<string>; listedPrice: number | null; source: "listed" | "asked" };
    const knownPlaces = new Map<string, Known>();
    let shown: { code: string; why: string }[] | null = null;
    let judgedNone = false;
    if (open) {
      const seen = new Set<string>();
      for (const d of explore) {
        if (!d.code || seen.has(d.code) || !AIRPORTS[d.code] && !d.id) continue;
        seen.add(d.code);
        knownPlaces.set(d.code, { code: d.code, name: d.name, country: d.country, endpoint: d.id || d.code, airports: metroCodes(d.code).size ? metroCodes(d.code) : new Set([d.code]), listedPrice: d.price, source: "listed" });
      }
      // Seed a short list with the area's main airports, so something there gets priced even if the model names nothing.
      if (area && knownPlaces.size < AREA_SEEDS)
        for (const a of gatewaysOf(area, AREA_SEEDS)) {
          if (okFrom.has(a.code) || [...knownPlaces.values()].some((k) => k.airports.has(a.code) || k.name === a.city)) continue;
          knownPlaces.set(a.code, { code: a.code, name: a.city, country: countryName(a.country), endpoint: a.code, airports: metroCodes(a.code).size ? metroCodes(a.code) : new Set([a.code]), listedPrice: null, source: "asked" });
        }
      for (const k of knownPlaces.values()) if (isPlaceId(k.endpoint)) PLACE_NAMES.set(k.endpoint, k.name);
      const month = new Date(`${outDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
      // Round trips to a place go by airport code, as in `roundTrips`: a grouped place's own airports, else nearby ones.
      const placeAirports = async (k: Known): Promise<string[]> => airportsFor(k.code, isPlaceId(k.endpoint) ? await resolveEndpoint({ code: k.code, name: k.name }, widening) : null);
      /** The cheapest fare the pool holds to a place, over the airports it groups. */
      const fareFor = (k: Known): number | null => {
        let min: number | null = null;
        for (const x of pool.all()) if (x.itin.price != null && k.airports.has(x.itin.to) && (x.rt === (retDate != null))) min = min == null || x.itin.price < min ? x.itin.price : min;
        return min;
      };
      const nonstopFor = (k: Known): boolean | null => {
        const fares = pool.all().filter((x) => k.airports.has(x.itin.to));
        if (fares.length) return fares.some((x) => x.itin.stops === 0);
        const d = explore.find((x) => x.code === k.code);
        return d?.stops == null ? null : d.stops === 0;
      };
      /** Known places as the model sees them, with a price-tier word in place of each fare. */
      const asWords = (): KnownPlace[] => {
        const priced = [...knownPlaces.values()].map((k) => fareFor(k) ?? k.listedPrice).filter((p): p is number => p != null).sort((a, b) => a - b);
        return [...knownPlaces.values()]
          .map((k) => ({ k, price: fareFor(k) ?? k.listedPrice }))
          .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          .map(({ k, price }) => ({ code: k.code, name: k.name, country: k.country, tier: price == null ? null : tierWord(price, priced), nonstop: nonstopFor(k), source: k.source }));
      };
      const priceThese = async (codes: string[]) =>
        Promise.allSettled(
          codes.map(async (c) => {
            const k = knownPlaces.get(c)!;
            const theirs = await placeAirports(k);
            for (const a of theirs) k.airports.add(a);
            return Promise.all(airportsOf(from).flatMap((f) => theirs.map((t) => shop(widening, queryFor(req, f, t, outDate, retDate), `to ${k.name}${f !== from ? ` from ${f}` : ""}${t !== k.code ? ` into ${t}` : ""}`, { out: 0, ret: 0 }).then(counted))));
          })
        );
      const cheapestUnpriced = (n: number) => [...knownPlaces.values()].filter((k) => k.listedPrice != null && fareFor(k) == null).sort((a, b) => a.listedPrice! - b.listedPrice!).slice(0, n).map((k) => k.code);

      const agent = deps.explorer ?? null;
      const describes = !!plan.openHint && describesAPlace(plan.openHint);
      let roundsRun = 0;
      if (agent && describes && knownPlaces.size >= 2) {
        // Each round is a 6 to 12 s model call plus its pricing, which stops when widening does.
        for (let round = 1; round <= EXPLORE_ROUNDS && untilStop("widening") > 15_000; round++) {
          hooks.phase("exploring");
          log(round === 1 ? `Checking ${knownPlaces.size} places for “${plan.openHint}”…` : "Looking for anything better…", "action");
          const ask = await guarded(now() + 18_000, (signal) => agent.round({ hint: plan.openHint!, month, origin: placeName(from), round, known: asWords(), maxLook: LOOKUPS_PER_ROUND, signal, timeoutMs: 16_000 }), `round ${round}`);
          if (ask?.usage) agentUsages.push(ask.usage);
          if (!ask || ask.failure) {
            log(`The rounds stopped (${ask?.failure ?? "no answer"})`, "info");
            break;
          }
          roundsRun = round;
          // Places the model named that the provider didn't list: resolved like the planner's places, then priced.
          const lookedUp = (
            await Promise.all(
              ask.look.map(async (l) => {
                const hits = counted(await widening.must((signal) => backend.places(l.name, { signal, timeoutMs: 5_000 }), `places for ${l.name}`));
                const hit = hits?.[0];
                const code = hit ? (hit.kind === "airport" ? hit.code : (hit.airports[0]?.code ?? null)) : null;
                if (!hit || !code || knownPlaces.has(code) || okFrom.has(code)) return null;
                const airports = hit.kind === "city" && hit.airports.length ? new Set(hit.airports.map((a) => a.code)) : metroCodes(code).size ? metroCodes(code) : new Set([code]);
                const k: Known = {
                  code,
                  name: hit.kind === "city" ? hit.name.split(",")[0].trim() : (AIRPORTS[code]?.city ?? hit.name.replace(/ airport$/i, "")),
                  country: AIRPORTS[code] ? (countryName(AIRPORTS[code].country) ?? null) : (hit.name.includes(",") ? hit.name.split(",").pop()!.trim() : null),
                  endpoint: hit.kind === "city" ? hit.id : code,
                  airports,
                  listedPrice: null,
                  source: "asked",
                };
                if (isPlaceId(k.endpoint)) PLACE_NAMES.set(k.endpoint, k.name);
                knownPlaces.set(code, k);
                whyPlace[code] = l.why;
                return code;
              })
            )
          ).filter((c): c is string => !!c);
          const toPrice = [...new Set([...ask.price, ...lookedUp])].filter((c) => knownPlaces.has(c) && fareFor(knownPlaces.get(c)!) == null).slice(0, PLACES_PER_ROUND);
          if (toPrice.length) {
            log(`Pricing ${toPrice.map((c) => knownPlaces.get(c)!.name).join(", ")}…`, "action");
            await priceThese(toPrice);
          }
          notes.push(`Round ${round}: ${ask.price.length} listed places priced, ${lookedUp.length} looked up${ask.enough ? ", enough" : ""}`);
          if (ask.enough || (!toPrice.length && !ask.look.length)) break;
        }
      }
      // If nothing is priced yet, price the cheapest listed places, then (in an area) places the list had no price for.
      if (![...knownPlaces.values()].some((k) => fareFor(k) != null)) {
        const unlisted = area ? [...knownPlaces.values()].filter((k) => k.listedPrice == null).map((k) => k.code) : [];
        const these = [...cheapestUnpriced(PLACES_TO_PRICE), ...unlisted].slice(0, PLACES_TO_PRICE);
        if (these.length) {
          hooks.phase("pricing");
          log(area ? `Pricing flights to ${these.map((c) => knownPlaces.get(c)!.name).join(", ")}…` : `Pricing real flights to the ${these.length} cheapest places…`, "action");
          await priceThese(these);
        }
      }
      // The model chooses what to show, from the priced places only.
      if (agent && left() > 16_000 && [...knownPlaces.values()].some((k) => fareFor(k) != null)) {
        log("Choosing the places to show…", "action");
        const fin = await guarded(now() + 18_000, (signal) => agent.final({ hint: plan.openHint ?? "anywhere", month, origin: placeName(from), known: asWords().map((k) => ({ ...k, tier: fareFor(knownPlaces.get(k.code)!) == null ? null : k.tier })), signal, timeoutMs: 16_000 }), "the final choice");
        if (fin?.usage) agentUsages.push(fin.usage);
        if (fin && !fin.failure && fin.show.length) {
          shown = fin.show.filter((x) => knownPlaces.has(x.code));
          for (const x of shown) whyPlace[x.code] = x.why || whyPlace[x.code] || "";
          log(`Showing ${shown.map((x) => knownPlaces.get(x.code)!.name).join(", ")}`, "success");
          notes.push(`Places chosen by the model after ${roundsRun} round${roundsRun === 1 ? "" : "s"}: ${shown.map((x) => x.code).join(", ")}`);
        } else if (fin && !fin.failure && describes) {
          // The model judged that nothing priced fits. Outside a named area, code doesn't override it with the cheapest.
          judgedNone = true;
          log(area ? `The model chose none; showing the cheapest in ${area.label}` : `Nothing priced fits “${plan.openHint}”`, "info");
        } else log(`The model did not choose (${fin?.failure ?? "nothing chosen"}); showing the cheapest${area ? ` in ${area.label}` : ""}`, "info");
      }
    }

    /* ---- The grid: the cheapest of every way to fly each pair of days ---- */
    // Built before widening to choose what to widen, and rebuilt after so bought fares take their cells. That includes open-jaw
    // fares, which no grid call returns.
    let gridView: GridView | null = open || !flexible ? null : assembleGrid(plan, combos, grids, graphsOut, graphsBack, pool, usable);

    /* ---- Stage 2: widen ---- */
    // Buys the most promising cells and hints, then waits for every job (early cell buys included) until widening stops.
    {
      const jobs: Promise<unknown>[] = [];
      if (open) {
        // Priced in the rounds above.
      } else {
        hooks.phase("widening");
        const bl = withInsights();
        const hinted = new Set<string>(askedCells); // bought early, as their grid came in
        // The grid's cheapest cells, cells serving the stated preference, and the provider's date hints. The asked dates were
        // bought in the first stage (two-ticket cells through the one-ways), unless their own search never answered, in which
        // case they're a cell like any other.
        const isAsked = (c: GridCell) => c.outDate === outDate && c.returnDate === retDate;
        const boughtAsked = (c: GridCell) => isAsked(c) && (c.via?.tickets === "two" || !ownUnanswered.has(c.via?.out ?? dests[0]));
        const cells = (gridView?.cells ?? []).filter((c) => c.price != null && !boughtAsked(c)).sort((a, b) => a.price! - b.price!);
        const worthIt: GridCell[] = cells.filter((c) => pool.baseline == null || c.price! < pool.baseline * 1.02).slice(0, CELLS_TO_PRICE);
        // The cheapest cell to buy. The page quotes it, so it gets one more attempt than the rest.
        const lead = worthIt[0] ?? null;
        if (plan.dates.prefer !== "none" && cells.length) {
          const nightsOf = (c: GridCell) => daysBetween(c.outDate, c.returnDate);
          const edge = plan.dates.prefer === "longest" ? Math.max(...cells.map(nightsOf)) : Math.min(...cells.map(nightsOf));
          const near = cells.filter((c) => Math.abs(nightsOf(c) - edge) <= 1 && !worthIt.includes(c)).slice(0, CELLS_FOR_PREFERENCE);
          worthIt.push(...near);
        }
        for (const h of bl?.dateHints ?? []) if (h.price != null && retDate && !worthIt.some((c) => c.outDate === h.outDate && c.returnDate === (h.returnDate ?? retDate))) worthIt.push({ outDate: h.outDate, returnDate: h.returnDate ?? retDate, price: h.price });
        if (!retWin) for (const [, m] of graphsOut) for (const [day, price] of [...m].sort((a, b) => a[1] - b[1]).slice(0, 3)) if (day !== outDate) worthIt.push({ outDate: day, returnDate: day, price });
        // One-way calls are shared across cells, since an outbound is the same call whatever return it pairs with.
        const oneWayAsked = new Set<string>();
        const oneWay = (leg: "out" | "back", a: string, b: string, day: string, shift: number, attempts = 2) => {
          const k = `${leg}~${a}~${b}~${day}`;
          if (oneWayAsked.has(k)) return;
          oneWayAsked.add(k);
          jobs.push(buyOneWay(leg, a, b, day, shift, attempts));
        };
        for (const c of worthIt) {
          const attempts = c === lead ? 3 : 2;
          const key = cellKeyOf(c);
          if (hinted.has(key)) continue;
          hinted.add(key);
          const ret = retWin ? c.returnDate : null;
          const shift = { out: daysBetween(outDate, c.outDate), ret: retDate && ret ? daysBetween(retDate, ret) : 0 };
          const to = c.via?.out ?? dests[0];
          const back = c.via?.back ?? to;
          const fromQ = endpointOf(from);
          if (c.via?.tickets === "two" && ret) {
            oneWay("out", fromQ, endpointOf(to), c.outDate, shift.out, attempts);
            oneWay("back", endpointOf(back), fromQ, ret, shift.ret, attempts);
          } else {
            // On the asked dates, into one airport and from the first origin, these calls are the own search, so they count as it.
            const own = isAsked(c) && back === to && ownUnanswered.has(to);
            jobs.push(
              buyCell(c, attempts).then((rs) => {
                if (!own || !ownUnanswered.has(to) || !rs.every(Boolean)) return;
                ownUnanswered.delete(to);
                noteBaseline(cheapestOf(rs), to);
                notes.push(`The round trip on their own dates${combos.length > 1 ? ` to ${to}` : ""} answered when asked again with the cheapest dates`);
              })
            );
          }
        }
        for (const h of bl?.airportHints ?? []) {
          if (h.price == null) continue;
          const input = h.departure ? queryFor(req, h.code, combos[0].d, outDate, retDate) : queryFor(req, combos[0].o, h.code, outDate, retDate);
          jobs.push(shop(widening, input, `cheaper ${h.departure ? "leaving from" : "flying into"} ${h.code}, as hinted`, { out: 0, ret: 0 }).then(counted));
        }
        if (jobs.length) log(`Checking ${jobs.length} cheaper ${flexible ? "dates" : "options"}${plan.dates.prefer === "longest" ? ", and the longest stays" : ""}…`, "action");
      }
      await drain(jobs, early);
      if (jobs.length || early.length) notes.push(`Widened with ${jobs.length + early.length} more queries, ${early.length} of them as the grids came in`);
    }
    if (gridView) gridView = assembleGrid(plan, combos, grids, graphsOut, graphsBack, pool, usable) ?? gridView;
    // The asked dates stay unconfirmed when their own search never fully answered and widening didn't buy them either.
    for (const d of ownUnanswered) unconfirmed(outDate, retDate, from, d);
    // The own search, used for comparisons. A partial answer is left out, since its cheapest fare may not be the real cheapest.
    const baseline = ownUnanswered.size || ownMissing.size ? null : pool.baseline;

    if (pool.size === 0) {
      const when = `${flexible ? "around" : "on"} ${dayRange(outDate, retDate, req.locale)}`;
      throw failed(unfinished() ?? (open ? `Nothing could be priced from ${placeName(from)} ${when}. Try other dates, or a bigger airport nearby.` : "We couldn’t find any flights for this trip. Check the dates and the airports, or try again in a moment."));
    }
    log(`${pool.size} itineraries in hand after ${((now() - t0) / 1000).toFixed(1)}s`, "success");

    /* ---- Candidates ---- */
    const windows = { out: outWin, ret: retWin };
    const all = pool.all();
    const bookable = all.filter((x) => bookableFor(x, req, okFrom, okTo, windows));
    const pairs: Pairing[] = [];
    const placeOf = (airport: string): Known | undefined => knownPlaces.get(airport) ?? [...knownPlaces.values()].find((k) => k.airports.has(airport));
    if (open) {
      // One option per place (its airports count as one) at its best fare. The model's chosen places come first, in its order.
      const best = new Map<string, IndexedItin>();
      for (const x of bookable) {
        const key = placeOf(x.itin.to)?.code ?? x.itin.to;
        const cur = best.get(key);
        if (!cur || (x.itin.price ?? Infinity) < (cur.itin.price ?? Infinity)) best.set(key, x);
      }
      const order = shown ? shown.map((x) => x.code) : [];
      for (const code of order) if (best.has(code)) pairs.push({ out: best.get(code)!, ret: null });
      // No model choice: the cheapest per place, inside any named area. None if the model judged nothing fits and there's no area.
      if (!shown && !(judgedNone && !area))
        for (const [code, x] of best) if (!area || inArea(area, code, placeOf(x.itin.to)?.country ?? null)) pairs.push({ out: x, ret: null });
    } else {
      for (const x of bookable) pairs.push({ out: x, ret: null });
      if (retWin && plan.separateTickets) {
        // Two one-ways: the return must leave on a later day than the outbound lands, fly back to the origin, and depart from
        // the city the outbound reached (or any listed airport when mixing is allowed).
        const inWindow = (x: IndexedItin, w: [string, string]) => x.itin.departure.slice(0, 10) >= w[0] && x.itin.departure.slice(0, 10) <= w[1];
        const outs = oneWays.out.filter((x) => okFrom.has(x.itin.from) && okTo.has(x.itin.to) && x.itin.price != null && inWindow(x, outWin)).sort((a, b) => a.itin.price! - b.itin.price!).slice(0, ONE_WAYS_TO_PAIR);
        const rets = oneWays.ret.filter((x) => okFrom.has(x.itin.to) && okTo.has(x.itin.from) && x.itin.price != null && inWindow(x, retWin)).sort((a, b) => a.itin.price! - b.itin.price!).slice(0, ONE_WAYS_TO_PAIR);
        // The floor is the cheapest round trip actually bought. A grid price may not be bookable, and as the floor it would reject
        // valid pairs.
        const floor = pool.roundTripFloor ?? Infinity;
        const combosPaired: Pairing[] = [];
        for (const o of outs)
          for (const r of rets) {
            if (r.itin.departure.slice(0, 10) <= o.itin.arrival.slice(0, 10)) continue;
            if (!(plan.mixAirports ? okTo.has(r.itin.from) : metroCodes(o.itin.to).has(r.itin.from))) continue;
            combosPaired.push({ out: o, ret: r });
          }
        const price = (c: Pairing) => c.out.itin.price! + c.ret!.itin.price!;
        combosPaired.sort((a, b) => price(a) - price(b));
        // Two tickets mean more hassle and an unprotected connection, so a pair must be 3% under every one-ticket fare for the
        // same days and, outside longest-stay searches, under the cheapest round trip. The grid is used only for days with no
        // bought round trip, since its price can be an unmarked separate-ticket total.
        const oneTicketOn = (c: Pairing): number => {
          const out = c.out.itin.departure.slice(0, 10);
          const back = c.ret!.itin.departure.slice(0, 10);
          let min = Infinity;
          for (const x of pool.all()) if (x.rt && x.itin.price != null && x.retDate === back && x.itin.departure.slice(0, 10) === out) min = Math.min(min, x.itin.price);
          if (Number.isFinite(min)) return min;
          for (const g of grids) min = Math.min(min, g.cells.get(cellKey(out, back)) ?? Infinity);
          return min;
        };
        const saves = (c: Pairing) => price(c) < oneTicketOn(c) * 0.97;
        const chosen = new Set<Pairing>();
        for (const c of combosPaired.slice(0, 8)) if (price(c) < floor * 0.98 && saves(c)) chosen.add(c);
        if (plan.dates.prefer === "longest") {
          const ceiling = Number.isFinite(floor) ? floor * 1.15 : Infinity;
          for (const c of [...combosPaired].sort((a, b) => (stayNights(b.out, b.ret) ?? 0) - (stayNights(a.out, a.ret) ?? 0) || price(a) - price(b)).filter((c) => price(c) <= ceiling && saves(c)).slice(0, 4)) chosen.add(c);
        }
        if (combosPaired.length) log(`${chosen.size} of ${combosPaired.length} two-ticket pairs beat one ticket on the same days`, "info");
        pairs.push(...chosen);
      }
    }
    // Name the searched dates, since the traveller may not have given any and "on those dates" would mean nothing.
    if (!pairs.length) {
      const when = `${flexible ? "around" : "on"} ${dayRange(outDate, retDate, req.locale)}`;
      throw failed(
        unfinished() ??
        (open && plan.openHint && describesAPlace(plan.openHint)
          ? `We couldn’t find a flight you can book from ${placeName(from)} to ${area ? area.label : `anywhere that fits “${plan.openHint}”`} ${when}. Try other dates, or name a city.`
          : `We couldn’t find a flight you can book ${when}. Try other dates, or a nearby airport.`)
      );
    }

    /* ---- Stage 3: pick ---- */
    hooks.phase("picking");
    const howMany = ["", "one", "two", "three"][plan.picks.length] ?? String(plan.picks.length);
    const chosenPlaces: PickOutcome | null =
      open && shown && pairs.length
        ? {
            picks: pairs.slice(0, MAX_PLACE_PLANS).map((pair) => {
              const k = placeOf(pair.out.itin.to)!;
              return { slot: `place-${k.code}`, spec: { key: `place-${k.code}`, label: k.name, want: whyPlace[k.code] ?? "", rank: "price" as const }, pair, label: k.name, scores: null, pickedBy: "code" as const };
            }),
            source: "code",
            usage: null,
            ms: 0,
          }
        : null;
    if (!chosenPlaces) log(`Choosing your ${howMany} from ${pairs.length} bookable options…`, "action");
    const pickOutcome =
      chosenPlaces ??
      (await pickPlans({
        pairs,
        req,
        plan,
        wantedFrom: origins.length === 1 ? from : undefined,
        wantedTo: dests.length === 1 ? dests[0] : undefined,
        jev: left() > 4_000 ? deps.jev : null,
        signal: killer.signal,
        timeoutMs: Math.floor(Math.min(5_000, Math.max(1_500, left() - 3_000))),
      }));
    if (pickOutcome.usage) jevUsage = pickOutcome.usage;
    if (chosenPlaces) log(`${chosenPlaces.picks.length} place${chosenPlaces.picks.length === 1 ? "" : "s"} to show, as the model chose`, "info");
    else if (pickOutcome.failure) log(`Picked by code (${pickOutcome.failure})`, "info");
    else log(`Picked by ${pickOutcome.source} in ${pickOutcome.ms}ms`, "info");
    notes.push(chosenPlaces ? "Plans are the model's places, cheapest fare each" : `Picked by ${pickOutcome.source}${pickOutcome.failure ? ` (${pickOutcome.failure})` : ""}`);

    /* ---- The return half of each round-trip fare ---- */
    // A round-trip fare's price assumes its cheapest return. Fetch each picked fare's returns so the plan can show both flights.
    // If they never answer in time, or the cheapest still costs more than the fare after a second ask, keep the fare's price
    // and leave the return to the booking page. Open-jaw fares are skipped.
    const returnsFor = new Map<number, IndexedItin>();
    const rtPicks = pickOutcome.picks.filter((p) => p.pair.out.rt && !p.pair.ret && !p.pair.out.jaw);
    if (rtPicks.length) {
      log(`Finding the return flight${rtPicks.length === 1 ? "" : "s"} for ${rtPicks.length === 1 ? "that fare" : "those fares"}…`, "action");
      // 12 s timeout, since a fare's first returns request can take ~9 s.
      const returnsOf = async (x: IndexedItin, back: string) => {
        const input = queryFor(req, x.itin.from, x.itin.to, x.itin.departure.slice(0, 10), back);
        const payload = await returning.must((signal) => backend.returns(input, { segments: x.itin.segments }, { signal, hedgeMs: 1_200, timeoutMs: 12_000, attempts: 2 }), `returns for ${x.itin.airlineCode}`);
        return payload ? payload.itineraries.filter((it) => it.price != null) : null;
      };
      /** Fetches one fare's return, asking again if the first answer is empty or above the fare. */
      const fetchReturn = async (p: SlotPick): Promise<void> => {
        const x = p.pair.out;
        const back = x.retDate ?? retDate;
        if (!back) return;
        const fare = x.itin.price;
        const first = await returnsOf(x, back);
        if (!first) return; // never answered in time; the return is chosen on the booking page
        let priced = first;
        const cheapest = () => Math.min(...priced.map((it) => it.price!));
        if (!priced.length || (fare != null && cheapest() > fare)) priced = [...priced, ...((await returnsOf(x, back)) ?? [])];
        if (!priced.length) return; // no returns twice; the return is chosen on the booking page
        const floor = cheapest();
        if (fare != null && floor > fare) {
          log(`  The returns for the ${x.itin.airlineCode} fare came back from ${fmt(floor)}, above its own ${fmt(fare)} — keeping the fare and leaving the return to the booking page`, "info");
          return;
        }
        // The cheapest return, ties broken by the best hours.
        const best = priced
          .filter((it) => it.price === floor)
          .map((it) => ({ it, h: hoursScore({ out: { ...x, itin: it }, ret: null }) }))
          .sort((a, b) => b.h - a.h)[0].it;
        if (best.price !== fare) log(`  With its cheapest return, the ${x.itin.airlineCode} fare comes to ${fmt(best.price!)}, not ${fmt(fare ?? 0)}`, "info");
        returnsFor.set(x.id, { id: -x.id, itin: best, queryIndex: -1, rt: true, retDate: x.retDate });
      };
      await Promise.allSettled(rtPicks.map(fetchReturn));
      const fetched = rtPicks.filter((p) => returnsFor.has(p.pair.out.id)).length;
      notes.push(`Return flights fetched for ${fetched} of ${rtPicks.length} fare${rtPicks.length > 1 ? "s" : ""}`);
    }

    /* ---- Assemble (code does every number) ---- */
    const seats = seatedTravellers(req.passengers);
    const ctx: BookingContext = { passengers: req.passengers, cabin: req.cabin, bags: req.bags, currency: req.currency, language: languageTag(req.locale) };
    let plans: FlightPlan[] = pickOutcome.picks.map((p, i) => planFrom(p, i, req, seats, ctx, outDate, retDate, returnsFor.get(p.pair.out.id)));
    plans = chosenPlaces ? noteRouteSwaps(plans, req) : dropPointless(keepCheapestCheapest(noteRouteSwaps(plans, req), plan), plan.picks);
    if (!plans.length) throw failed("Something went wrong picking your flights. Try again in a moment.");

    const best = Math.min(...plans.map((p) => p.price));
    // The page quotes the grid's cheapest days beside the plans. If they are well under every plan but had no flights, or came
    // back dearer, the grid price isn't a real fare and the page says so (`gridCheaper`). If the picks passed over a real fare
    // there, the page says nothing (`passedOver`). The write-up gets both, so it doesn't call the plans the cheapest dates.
    const gridBest = (gridView?.cells ?? []).filter((c) => c.price != null).reduce<GridCell | null>((a, c) => (!a || c.price! < a.price! ? c : a), null);
    /** Whether a grid cell's dates were asked and never fully answered. */
    const unconfirmedOn = (c: GridCell) => [...gaps.dates.values()].some((g) => g.outDate === c.outDate && (g.returnDate ?? g.outDate) === c.returnDate);
    const found = gridBest ? boughtOn(gridBest) : null;
    const underPlans =
      gridBest && gridBest.price! < best * 0.97
        ? { outDate: gridBest.outDate, returnDate: gridBest.returnDate, price: gridBest.price!, found, ...(found == null && unconfirmedOn(gridBest) ? { unconfirmed: true as const } : {}) }
        : null;
    const passedOver = underPlans && underPlans.found != null && underPlans.found < best * 0.97 ? underPlans : null;
    const gridCheaper = underPlans && !passedOver ? underPlans : null;
    if (underPlans)
      log(`The grid's cheapest days, ${underPlans.outDate}${retWin ? ` → ${underPlans.returnDate}` : ""} from ${fmt(underPlans.price)}, are not among the plans: ${underPlans.unconfirmed ? "they didn't answer in time" : underPlans.found == null ? "there were no flights on them when asked" : passedOver ? `a fare on them came back at ${fmt(underPlans.found)} and the picks passed it over` : `their flights came back from ${fmt(underPlans.found)}`}`, "info");
    // Unanswered lookups, cheapest grid dates first. A route is named only when the search covered several.
    const gridPriceOf = (out: string, ret: string | null) => gridView?.cells.find((c) => c.outDate === out && c.returnDate === (ret ?? out))?.price ?? Infinity;
    const routeOf = (o: string, d: string) =>
      origins.length > 1 && dests.length > 1 ? `${placeName(o)} to ${placeName(d)}` : origins.length > 1 ? `from ${placeName(o)}` : dests.length > 1 ? `to ${placeName(d)}` : null;
    const incomplete: Incomplete | null =
      gaps.dates.size || gaps.grid || gaps.other
        ? {
            dates: [...gaps.dates.values()]
              .sort((a, b) => gridPriceOf(a.outDate, a.returnDate) - gridPriceOf(b.outDate, b.returnDate) || 0)
              .map(({ outDate, returnDate, o, d }) => {
                const route = routeOf(o, d);
                return { outDate, returnDate, ...(route ? { route } : {}) };
              }),
            grid: gaps.grid,
            other: gaps.other,
          }
        : null;
    if (incomplete)
      log(`Didn't answer in time, so left out: ${[incomplete.dates.length && `${incomplete.dates.length} date pair${incomplete.dates.length === 1 ? "" : "s"}`, incomplete.grid && "part of the date grid", incomplete.other && `${incomplete.other} other lookup${incomplete.other === 1 ? "" : "s"}`].filter(Boolean).join(", ")}`, "info");
    const verdict: Verdict = {
      baseline,
      best,
      saved: baseline != null ? baseline - best : null,
      ...(gridCheaper ? { gridCheaper } : {}),
      ...(incomplete ? { incomplete } : {}),
      ...(baseline != null && baseline - best <= 0
        ? { couldNotBeat: `Searching it the way you described came to ${fmt(baseline)}${combos.length > 1 ? " at best" : ""}, and nothing among the ${pool.size} itineraries I checked was under it.` }
        : {}),
    };

    /* ---- Stage 4: write ---- */
    const bl = withInsights();
    const view = buildView(kind, { grid: gridView, graphsOut, explore, baseline: bl, outDate, retDate, pool });
    if (view.destinations) {
      /** The cheapest fare the search bought to a place, over the airports it groups. */
      const boughtTo = (code: string): IndexedItin | null => {
        const k = knownPlaces.get(code);
        let best: IndexedItin | null = null;
        if (k) for (const x of pool.all()) if (x.itin.price != null && k.airports.has(x.itin.to) && x.rt === (retDate != null) && (!best || x.itin.price < best.itin.price!)) best = x;
        return best;
      };
      const fareOf = (code: string) => boughtTo(code)?.itin.price ?? null;
      const photoOf = (code: string) => photos.get(code) ?? [...(knownPlaces.get(code)?.airports ?? [])].map((a) => photos.get(a)).find(Boolean) ?? null;
      // Add places the model asked for that the provider didn't list, with the fare the search found.
      for (const k of knownPlaces.values()) {
        if (k.source !== "asked" || view.destinations.some((d) => d.code === k.code)) continue;
        const fare = fareOf(k.code);
        view.destinations.push({ code: k.code, name: k.name, country: k.country, lat: AIRPORTS[k.code]?.lat ?? null, lon: AIRPORTS[k.code]?.lon ?? null, price: fare, carrierCode: null, carrierName: null, stops: null, durationMinutes: null, outDate, returnDate: retDate, image: null, priced: fare != null });
      }
      for (const d of view.destinations) {
        if (whyPlace[d.code]) d.why = whyPlace[d.code];
        // A bought fare replaces the list's estimate and flight details, which can be inconsistent (and are missing for places
        // the model named).
        const best = boughtTo(d.code);
        if (best) Object.assign(d, { price: best.itin.price, carrierCode: best.itin.airlineCode, carrierName: best.itin.airlineNames.join(" and ") || null, stops: best.itin.stops, durationMinutes: best.itin.totalDurationMinutes });
        d.image ??= photoOf(d.code);
      }
      if (shown) {
        const order = new Map(shown.map((x, i) => [x.code, i]));
        view.destinations.sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999) || (a.price ?? Infinity) - (b.price ?? Infinity));
      }
    }
    const planView = toPlanView(plan);
    let analysis: string | null = null;
    const lines: Record<string, string> = {};
    if (deps.voice && left() > 5_000) {
      hooks.phase("writing");
      log(plans.length === 1 ? "Explaining why this one made the cut…" : `Explaining why each of the ${plans.length} made the cut…`, "action");
      const voice = await narrate(
        deps.voice,
        {
          req,
          facts:
            `${tripFacts(req, unencoded)}\n- The brief as the search understood it: ${plan.understood}.\n- The picks asked for: ${plan.picks.map((k) => `"${k.label}" — ${k.want}`).join(" / ")}` +
            (gridCheaper
              ? `\n- The date grid shows ${retWin ? dayRange(gridCheaper.outDate, gridCheaper.returnDate, req.locale) : shortDate(gridCheaper.outDate, req.locale)} from ${fmt(gridCheaper.price)}, under every plan, but ${gridCheaper.unconfirmed ? "the search couldn't confirm those days in time" : gridCheaper.found == null ? "there were no flights on those days when the search asked" : `those flights came back from ${fmt(gridCheaper.found)}`}. The page says so under the plans; do not call the plans the cheapest dates.`
              : passedOver
                ? `\n- A fare on ${retWin ? dayRange(passedOver.outDate, passedOver.returnDate, req.locale) : shortDate(passedOver.outDate, req.locale)} came back at ${fmt(passedOver.found!)}, under every plan, and the picks passed it over. Do not call the plans the cheapest dates.`
                : "") +
            (incomplete
              ? `\n- Not every lookup came back in time${incomplete.dates.length ? `, so some dates couldn't be confirmed` : ""}. The page says so; the plans are the best found, so never call one the cheapest there is.`
              : ""),
          plans,
          verdictLine:
            baseline != null
              ? `Their own search, exactly as asked, came to ${fmt(baseline)}${combos.length > 1 ? " at best" : ""}. The cheapest plan is ${fmt(best)}${verdict.saved! > 0 ? ` — ${fmt(verdict.saved!)} less` : verdict.saved! < 0 ? ` — ${fmt(-verdict.saved!)} more, because nothing cheaper was found` : " — the same"}.`
              : open
                ? "There is no single trip to compare against: the destination was open."
                : "Their own exact search could not be priced.",
          viewLine: viewLine(kind, view, plan, fmt),
        },
        { signal: killer.signal, timeoutMs: Math.floor(Math.min(22_000, Math.max(2_000, left() - 1_500))) }
      );
      voiceUsage = voice.usage;
      analysis = voice.analysis;
      Object.assign(lines, voice.lines);
      if (voice.failure) log(`Write-up fell back to code (${voice.failure})`, "info");
      notes.push(voice.analysis ? `Prose by ${deps.voice.label}` : "Prose by code");
    } else {
      notes.push("Prose by code (no time or no model)");
    }
    const whyLine = (p: FlightPlan) => (chosenPlaces && whyPlace[placeOf(p.legs[0].to)?.code ?? ""] ? `${whyPlace[placeOf(p.legs[0].to)!.code].charAt(0).toUpperCase()}${whyPlace[placeOf(p.legs[0].to)!.code].slice(1)}.` : null);
    plans = plans.map((p) => ({ ...p, summary: mergeSummary(lines[p.id] ?? whyLine(p) ?? codeLine(p, plans, req), p.summary) }));
    const finalAnalysis = analysis ?? codeAnalysis(plans, verdict, kind, req);

    hooks.phase("done");
    const durationMs = now() - t0;
    const missed = pricing.unanswered.length + widening.unanswered.length + returning.unanswered.length;
    log(`Done in ${(durationMs / 1000).toFixed(1)}s · ${queries} calls · ${pool.size} itineraries${missed ? ` · ${missed} never answered` : ""}`, "success");
    if (incomplete) {
      const day = (g: Incomplete["dates"][number]) => `${g.outDate}${g.returnDate ? ` → ${g.returnDate}` : ""}${g.route ? ` (${g.route})` : ""}`;
      notes.push(`Left out because they didn't answer in time: ${[incomplete.dates.length && `the dates ${incomplete.dates.map(day).join(", ")}`, incomplete.grid && "part of the date grid", incomplete.other && `${incomplete.other} other lookup${incomplete.other === 1 ? "" : "s"}`].filter(Boolean).join("; ")}`);
    }

    const rows = [...all]
      .sort((a, b) => (a.itin.price ?? Infinity) - (b.itin.price ?? Infinity))
      .slice(0, 260)
      .map((x) => ({ ...compactForLLM(x), bookingToken: x.itin.bookingToken ?? null }));
    const usages = [planOutcome.usage, ...agentUsages, jevUsage, voiceUsage];

    return {
      request: req,
      plans,
      analysis: finalAnalysis,
      verdict,
      view,
      plan: planView,
      session: { baseline, rows, roundNotes: notes, concludedBecause: incomplete ? "one pass, inside the deadline, with some lookups left out" : "one pass, inside the deadline" },
      stats: {
        durationMs,
        queries,
        itineraries: pool.size,
        jev: chosenPlaces ? "skipped" : pickOutcome.source === "jev" ? "used" : deps.jev ? "fallback" : "skipped",
        voice: analysis ? "used" : deps.voice ? "fallback" : "skipped",
        plannerMs: planOutcome.ms,
        tokensIn: usages.reduce((s, u) => s + (u?.in ?? 0), 0),
        tokensOut: usages.reduce((s, u) => s + (u?.out ?? 0), 0),
        costUsd: usages.every((u) => u?.costUsd == null) ? null : usages.reduce((s, u) => s + (u?.costUsd ?? 0), 0),
        missed,
      },
      unencoded,
    };
  } finally {
    clearTimeout(killTimer);
    for (const t of stopTimers) clearTimeout(t);
    killer.abort();
  }
}

/** Drops the origin's own country when the hint says "international", "abroad" or similar. Other adjectives need a model. */
export function abroadOnly(explore: ExploreDestination[], from: string, hint: string | null | undefined): ExploreDestination[] {
  const home = AIRPORTS[from]?.country ?? null;
  if (!home || !/\b(international|abroad|overseas|foreign|another country|out of the country)\b/i.test(hint ?? "")) return explore;
  return explore.filter((d) => countryCode(d.country) !== home);
}

/* -------------------------------- The grid -------------------------------- */

/**
 * Prices every pair of days in the window as the cheapest of: one ticket from the round-trip grids, two tickets from the
 * summed one-way graphs, or a real fare the pool holds. Each cell records which. Sums are valid because every source prices
 * the same party and bags. `usable` excludes pool fares the trip couldn't book, such as hinted nearby airports.
 */
export function assembleGrid(
  plan: TripPlan,
  combos: Combo[],
  grids: GridSource[],
  graphsOut: Map<string, Map<string, number>>,
  graphsBack: Map<string, Map<string, number>>,
  pool: CandidatePool,
  usable: (x: IndexedItin) => boolean = () => true
): GridView | null {
  const outDays = daysOf(plan.dates.out);
  const retWin = plan.dates.ret;
  const dests = plan.destinations.map((p) => p.code);
  if (!retWin) {
    // One-way: the cheapest day across the graphs, drawn as a single row.
    const cells: GridCell[] = outDays.map((day) => {
      let best: { price: number; via: GridVia } | null = null;
      for (const [k, m] of graphsOut) {
        const price = m.get(day);
        const d = k.split("~")[1];
        if (price != null && (!best || price < best.price)) best = { price, via: { tickets: "one", out: d, back: d } };
      }
      return { outDate: day, returnDate: day, price: best?.price ?? null, ...(best ? { via: best.via } : {}) };
    });
    if (!cells.some((c) => c.price != null)) return null;
    return {
      outDates: outDays,
      returnDates: [],
      cells,
      requested: { out: plan.dates.anchor.out, ret: plan.dates.anchor.out },
      ...(dests.length > 1 ? { airports: dests } : {}),
      route: { from: plan.origins[0]?.code ?? combos[0]?.o ?? "", to: dests },
      separate: false,
    };
  }
  const retDays = daysOf(retWin);
  const real = new Map<string, { price: number; via: GridVia }>();
  for (const it of pool.all()) {
    if (!it.rt || it.itin.price == null || !it.retDate || !usable(it)) continue;
    const k = cellKey(it.itin.departure.slice(0, 10), it.retDate);
    const cur = real.get(k);
    if (!cur || it.itin.price < cur.price) real.set(k, { price: it.itin.price, via: { tickets: "one", out: it.itin.to, back: it.jaw?.from ?? it.itin.to } });
  }
  const cells: GridCell[] = [];
  for (const out of outDays)
    for (const ret of retDays) {
      if (ret <= out) continue;
      // Objects rather than `let`s: the closure below assigns them, and narrowing would treat a `let` as always null.
      const one: { best: { price: number; via: GridVia } | null } = { best: null };
      const two: { best: { price: number; via: GridVia } | null } = { best: null };
      const consider = (into: typeof one, price: number | undefined, via: GridVia) => {
        if (price != null && (!into.best || price < into.best.price)) into.best = { price, via };
      };
      for (const g of grids) consider(one, g.cells.get(cellKey(out, ret)), { tickets: "one", out: g.d, back: g.d });
      const held = real.get(cellKey(out, ret));
      if (held) consider(one, held.price, held.via);
      if (plan.separateTickets)
        for (const { o, d } of combos)
          for (const back of plan.mixAirports ? dests : [d]) {
            const po = graphsOut.get(`${o}~${d}`)?.get(out);
            const pb = graphsBack.get(`${back}~${o}`)?.get(ret);
            if (po != null && pb != null) consider(two, po + pb, { tickets: "two", out: d, back });
          }
      // One ticket unless two save at least 3%, since separate bookings leave the connection unprotected. A two-ticket cell
      // still records the one-ticket price.
      const twoWins = two.best != null && (one.best == null || two.best.price < one.best.price * 0.97);
      const best = twoWins ? two.best : (one.best ?? null);
      cells.push({
        outDate: out,
        returnDate: ret,
        price: best?.price ?? null,
        ...(best ? { via: best.via } : {}),
        ...(twoWins && one.best ? { oneTicket: one.best.price } : {}),
      });
    }
  if (!cells.some((c) => c.price != null)) return null;
  return {
    outDates: outDays,
    returnDates: retDays,
    cells,
    requested: { out: plan.dates.anchor.out, ret: plan.dates.anchor.ret ?? plan.dates.anchor.out },
    ...(dests.length > 1 ? { airports: dests } : {}),
    ...(plan.mixAirports ? { mixed: true } : {}),
    route: { from: plan.origins[0]?.code ?? combos[0]?.o ?? "", to: dests },
    separate: plan.separateTickets,
  };
}

/* ------------------------------- Assembly ------------------------------- */

export function planFrom(p: SlotPick, i: number, req: SearchRequest, seats: number, ctx: BookingContext, outDate: string, retDate: string | null, rtReturn?: IndexedItin): FlightPlan {
  const { out, ret } = p.pair;
  const legs = [itinToLeg(out, "outbound", req.locale)];
  if (ret) legs.push(itinToLeg(ret, "return", req.locale));
  else if (rtReturn) legs.push(itinToLeg(rtReturn, "return", req.locale));
  // Two tickets add up. For a round-trip fare with its return attached, the return's price is the round-trip total.
  const price = ret ? (out.itin.price ?? 0) + (ret.itin.price ?? 0) : (rtReturn?.itin.price ?? out.itin.price ?? 0);
  const isRtFare = out.rt && !ret;
  // A two-ticket plan's return shift comes from the return ticket's own date.
  const shift = ret
    ? { out: daysBetween(outDate, out.itin.departure.slice(0, 10)), ret: retDate ? daysBetween(retDate, ret.itin.departure.slice(0, 10)) : 0 }
    : (out.shift ?? { out: daysBetween(outDate, out.itin.departure.slice(0, 10)), ret: retDate && out.retDate ? daysBetween(retDate, out.retDate) : 0 });
  const nights = stayNights(out, ret);
  return {
    id: `plan-${i}`,
    label: p.label,
    slot: p.slot,
    price,
    currency: req.currency,
    ...(seats > 1 ? { perTraveller: Math.round(price / seats), travellers: seats } : {}),
    legs,
    ...(isRtFare ? { roundTripFare: true, returnDate: out.retDate ? shortDate(out.retDate, req.locale) : undefined } : {}),
    ...(out.jaw ? { backFrom: out.jaw.from } : {}),
    booking: bookingFor(out.itin, { ret: ret?.itin, rtReturn: rtReturn?.itin, returnDate: isRtFare ? (out.retDate ?? null) : null, backFrom: out.jaw?.from ?? null, ctx }),
    ...(p.scores ? { scores: p.scores } : {}),
    pickedBy: p.pickedBy,
    carryOnIncluded: out.itin.carryOnIncluded,
    ...(shift.out || shift.ret ? { dateShift: shift } : {}),
    ...(nights != null ? { nights } : {}),
  };
}

const planStops = (p: FlightPlan) => p.legs.reduce((n, l) => n + l.stops, 0);
/** Hours score: one point per leg, minus a penalty for early or late times (pre-dawn costs most). Higher is better. */
const planHours = (p: FlightPlan) =>
  p.legs.reduce((n, l) => {
    const dep = Number(l.departTime.slice(0, 2));
    const arr = Number(l.arriveTime.slice(0, 2));
    return n + 1 - (dep < 6 ? 0.4 : dep >= 22 ? 0.2 : dep < 8 ? 0.15 : 0) - (arr < 6 ? 0.4 : arr >= 23 ? 0.3 : 0);
  }, 0);
/** Same days and at least one shared flight: effectively the same trip. */
const sameTrip = (a: FlightPlan, b: FlightPlan) =>
  a.legs.length === b.legs.length &&
  a.legs.every((l, i) => (l.isoDate ?? l.date) === (b.legs[i].isoDate ?? b.legs[i].date)) &&
  a.legs.some((l, i) => l.flightNumber === b.legs[i].flightNumber);
/** At one price, the same trip with fewer stops and then better hours comes first. */
const atOnePrice = (a: FlightPlan, b: FlightPlan) => a.price - b.price || (sameTrip(a, b) ? planStops(a) - planStops(b) || planHours(b) - planHours(a) : 0);

/**
 * Keeps the cheapest-price label on the cheapest plan, since the returns stage can change a fare's price after picking. The
 * two plans swap slots and default labels; prices stay. A tie on the same trip goes to fewer stops, then better hours.
 */
export function keepCheapestCheapest(plans: FlightPlan[], plan: TripPlan): FlightPlan[] {
  const priceSpec = plan.picks.find((k) => k.rank === "price");
  if (!priceSpec) return plans;
  const labelFor = (slot: string) => DEFAULT_LABEL[slot] ?? plan.picks.find((k) => k.key === slot)?.label ?? slot;
  const pricePlan = plans.find((p) => p.slot === priceSpec.key);
  const min = [...plans].sort(atOnePrice)[0];
  if (!pricePlan || !min || min === pricePlan || atOnePrice(min, pricePlan) >= 0 || !min.slot) return plans;
  const other = min.slot;
  const order = plans.map((p) => p.slot ?? "");
  min.slot = priceSpec.key;
  min.label = labelFor(priceSpec.key);
  min.pickedBy = "code";
  pricePlan.slot = other;
  pricePlan.label = labelFor(other);
  pricePlan.pickedBy = "code";
  return [...plans].sort((a, b) => order.indexOf(a.slot ?? "") - order.indexOf(b.slot ?? ""));
}

/**
 * Drops picks that cost more than the cheapest plan without beating it at what their slot ranks (nights for a stay, air time
 * for quickest, hours or stops for hours, any of these otherwise). A same-price variant of the cheapest trip also goes if it
 * is worse at something and better at nothing. Only plans with both halves known are judged.
 */
export function dropPointless(plans: FlightPlan[], picks: { key: string; rank: string }[]): FlightPlan[] {
  const whole = (p: FlightPlan) => p.legs.length >= 2 || !p.roundTripFare;
  const cheapest = [...plans].filter(whole).sort(atOnePrice)[0];
  if (!cheapest) return plans;
  const minutes = (d: string) => Number(d.match(/(\d+)h/)?.[1] ?? 0) * 60 + Number(d.match(/(\d+)m/)?.[1] ?? 0);
  const air = (p: FlightPlan) => p.legs.reduce((n, l) => n + minutes(l.duration), 0);
  const better = {
    nights: (p: FlightPlan) => (p.nights ?? 0) > (cheapest.nights ?? 0),
    air: (p: FlightPlan) => air(p) < air(cheapest),
    stops: (p: FlightPlan) => planStops(p) < planStops(cheapest),
    hours: (p: FlightPlan) => planHours(p) > planHours(cheapest) + 1e-9,
  };
  const earns = (p: FlightPlan): boolean => {
    const rank = picks.find((k) => k.key === p.slot)?.rank;
    if (rank === "stay") return better.nights(p);
    if (rank === "quickest") return better.air(p);
    if (rank === "hours") return better.hours(p) || better.stops(p);
    return better.nights(p) || better.air(p) || better.stops(p) || better.hours(p);
  };
  const worse = (p: FlightPlan) => planHours(p) < planHours(cheapest) - 1e-9 || planStops(p) > planStops(cheapest) || air(p) > air(cheapest) || (p.nights ?? 0) < (cheapest.nights ?? 0);
  return plans.filter((p) => p === cheapest || !whole(p) || p.legs.length !== cheapest.legs.length || (p.price <= cheapest.price && !(sameTrip(p, cheapest) && worse(p))) || earns(p));
}

/** The voice's line, followed by the airport note code appended to the summary (the row renders it as a tag). */
function mergeSummary(line: string, noted: string | undefined): string {
  const marker = "Note this ";
  const i = noted?.lastIndexOf(marker) ?? -1;
  const tail = i >= 0 ? noted!.slice(i) : "";
  return `${line.trim()}${tail ? ` ${tail}` : ""}`;
}

/** A leg's stops as a clause: "nonstop", "one stop in Doha", "two stops". */
function stopsClause(leg: FlightPlan["legs"][number] | undefined): string {
  if (!leg) return "";
  if (leg.stops === 0) return "nonstop";
  const where = [...(leg.stopNote ?? "").matchAll(/in ([A-Z]{3})/g)].map((m) => AIRPORTS[m[1]]?.city ?? m[1]);
  const n = leg.stops === 1 ? "one stop" : `${["", "one", "two", "three"][leg.stops] ?? leg.stops} stops`;
  return where.length === 1 ? `${n} in ${where[0]}` : n;
}

/** Fallback summary for a plan, built from its fields: "The lowest price we found, one stop in Doha each way, 26 nights away." */
export function codeLine(p: FlightPlan, plans: FlightPlan[], req: SearchRequest): string {
  void req;
  const cheapest = Math.min(...plans.map((x) => x.price));
  const out = p.legs.find((l) => l.direction === "outbound") ?? p.legs[0];
  const back = p.legs.find((l) => l.direction === "return");
  const a = stopsClause(out);
  const b = stopsClause(back);
  const route = !back ? a : a === b ? (a === "nonstop" ? "nonstop both ways" : `${a} each way`) : `${a} out, ${b} back`;
  const minutes = (l?: FlightPlan["legs"][number]) => {
    const m = (l?.duration ?? "").match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
  };
  const total = (x: FlightPlan) => x.legs.reduce((sum, l) => sum + minutes(l), 0);
  const quickest = plans.length > 1 && total(p) === Math.min(...plans.map(total));
  const nonstop = a === "nonstop" && (!back || b === "nonstop");
  const head =
    p.price === cheapest
      ? `The lowest price we found, ${route}`
      : nonstop
        ? `Nonstop${back ? " both ways" : ""} for a little more`
        : quickest
          ? `The quickest of these, ${route}`
          : route.charAt(0).toUpperCase() + route.slice(1);
  const bits = [head];
  if (p.nights != null && p.nights > 0) bits.push(`${p.nights} night${p.nights === 1 ? "" : "s"} away`);
  if (p.booking?.returnUrl) bits.push("on two separate tickets");
  return `${bits.join(", ")}.`;
}

function codeAnalysis(plans: FlightPlan[], verdict: Verdict, kind: SearchView["kind"], req: SearchRequest): string {
  const fmt = (n: number) => money(n, req.currency, req.locale);
  const cheapest = [...plans].sort((a, b) => a.price - b.price)[0];
  // With lookups left out, the cheapest found may not be the cheapest there is.
  const found = verdict.incomplete != null;
  if (kind === "open") return `The cheapest place ${found ? "we found" : "to go"} is ${AIRPORTS[cheapest.legs[0].to]?.city ?? cheapest.legs[0].to} at ${fmt(cheapest.price)}; the others are different places, not different ways there.`;
  if (plans.length === 1) return `One way to fly it stood out, at ${fmt(cheapest.price)}.`;
  const lead = found ? "The cheapest we found is" : "The cheapest way to fly it is";
  if (verdict.saved != null && verdict.saved > 0) return `${lead} ${fmt(cheapest.price)}, ${fmt(verdict.saved)} under your exact dates; the others cost a little more for easier hours, fewer stops or more time away.`;
  return `${lead} ${fmt(cheapest.price)}; the others cost a little more for easier hours, fewer stops or more time away.`;
}

/** The plan fields the page shows. */
export function toPlanView(plan: TripPlan): PlanView {
  return {
    understood: plan.understood,
    origins: plan.origins,
    destinations: plan.destinations,
    openHint: plan.openHint,
    mixAirports: plan.mixAirports,
    separateTickets: plan.separateTickets,
    dates: { anchor: plan.dates.anchor, out: plan.dates.out, ret: plan.dates.ret, prefer: plan.dates.prefer, note: plan.dates.note },
    picks: plan.picks.map((k) => ({ key: k.key, label: k.label, want: k.want })),
  };
}

/* --------------------------------- Views -------------------------------- */

function buildView(
  kind: SearchView["kind"],
  x: { grid: GridView | null; graphsOut: Map<string, Map<string, number>>; explore: ExploreDestination[]; baseline: ShoppingPayload | null; outDate: string; retDate: string | null; pool: CandidatePool }
): SearchView {
  const insights: InsightsView | null = x.baseline?.insights
    ? { level: x.baseline.insights.level, levelCode: x.baseline.insights.levelCode, current: x.baseline.insights.current, typical: x.baseline.insights.typical, low: x.baseline.insights.low, high: x.baseline.insights.high, history: x.baseline.insights.history }
    : null;
  const hints: HintsView = {
    dates: (x.baseline?.dateHints ?? []).map((h) => ({ outDate: h.outDate, returnDate: h.returnDate, price: h.price })),
    airports: (x.baseline?.airportHints ?? []).map((h) => ({ code: h.code, departure: h.departure, price: h.price })),
  };
  const view: SearchView = { kind, insights, hints };
  if (kind === "flexible" && x.grid) view.grid = x.grid;
  if (kind === "open") view.destinations = destinationViews(x.explore, new Set(x.pool.all().map((it) => it.itin.to)));
  return view;
}

/**
 * The explore list as cards, cheapest first, one per airport. The provider lists each place near an airport separately at
 * the same price, so the extra names go on that airport's card.
 */
export function destinationViews(explore: ExploreDestination[], pricedCodes: Set<string>): DestinationView[] {
  {
    const destinations: DestinationView[] = explore
      .filter((d) => d.code)
      .map((d) => ({
        code: d.code!,
        name: d.name,
        country: d.country,
        lat: d.lat,
        lon: d.lon,
        price: d.price,
        carrierCode: d.carrierCode,
        carrierName: d.carrierName,
        stops: d.stops,
        durationMinutes: d.durationMinutes,
        outDate: d.outDate,
        returnDate: d.returnDate,
        image: d.image,
        priced: pricedCodes.has(d.code!),
      }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const byCode = new Map<string, DestinationView>();
    for (const d of destinations) {
      const seen = byCode.get(d.code);
      if (!seen) byCode.set(d.code, d);
      else if (seen.price === d.price) seen.alsoNames = [...(seen.alsoNames ?? []), d.name];
    }
    return [...byCode.values()];
  }
}

function viewLine(kind: SearchView["kind"], view: SearchView, plan: TripPlan, fmt: (n: number) => string): string {
  const from = plan.origins.map((p) => p.name).join(" or ");
  if (kind === "open") {
    const priced = (view.destinations ?? []).filter((d) => d.price != null);
    return `Open destination from ${from} on ${plan.dates.anchor.out}${plan.dates.anchor.ret ? ` to ${plan.dates.anchor.ret}` : ""}: ${priced.length} places priced; the cheapest three are ${priced
      .slice(0, 3)
      .map((d) => `${d.name} ${fmt(d.price!)}`)
      .join(", ")}.`;
  }
  if (kind === "flexible" && view.grid) {
    const priced = view.grid.cells.filter((c) => c.price != null).sort((a, b) => a.price! - b.price!);
    const asked = view.grid.cells.find((c) => c.outDate === view.grid!.requested.out && c.returnDate === view.grid!.requested.ret);
    const two = priced.filter((c) => c.via?.tickets === "two").length;
    return `Flexible dates: a price grid of ${priced.length} date pairs over ${plan.dates.out[0]}–${plan.dates.out[1]} out and ${plan.dates.ret ? `${plan.dates.ret[0]}–${plan.dates.ret[1]} back` : "one way"}; each cell is the cheapest way to fly that pair${plan.destinations.length > 1 ? ", into either airport" : ""}${two ? `, and ${two} cells are cheapest as two tickets` : ""}; cheapest cell ${priced[0] ? `${fmt(priced[0].price!)} on ${priced[0].outDate}→${priced[0].returnDate}` : "unknown"}${asked?.price != null ? `; their own dates ${fmt(asked.price)}` : ""}.`;
  }
  const ins = view.insights;
  return `Fixed dates ${plan.dates.anchor.out}${plan.dates.anchor.ret ? `–${plan.dates.anchor.ret}` : ""}${ins?.level ? `; prices for this route are currently ${ins.level}${ins.low != null && ins.high != null ? ` (usually ${fmt(ins.low)}–${fmt(ins.high)})` : ""}` : ""}.`;
}
