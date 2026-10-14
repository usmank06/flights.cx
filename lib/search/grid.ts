import type { FlightPlan, GridVia, GridView, SearchRequest } from "@/lib/types";
import { AIRPORTS } from "@/lib/airports";
import { isDay } from "@/lib/format";
import type { FlightBackend } from "@/lib/flights/backend";
import { gridCellCount, longStays } from "@/lib/flights/calendar";
import type { DatePricePoint } from "@/lib/flights/types";
import { askCalendar, asker, resolveEndpoint, type Endpoint } from "./asking";
import { CandidatePool } from "./candidates";
import { daysBetween, queryFor, shiftDay } from "./core";
import { assembleGrid, type GridSource } from "./engine";
import type { TripPlan } from "./plan";

/**
 * Builds or widens the chat's date grid the same way the search does (assembleGrid). Widening keeps priced cells and asks only
 * the new days. Anything unanswered by the deadline throws `Unanswered`, since a partial grid could hide the cheapest days.
 */

/** Deadline when the caller passes no signal. */
const GRID_DEADLINE_MS = 50_000;

/** Days per window side. The provider's grid accepts 14 × 14 but refuses 21 × 21. */
export const MAX_GRID_DAYS = 14;

export type GridAsk = {
  from: string;
  to: string[];
  out: [string, string];
  /** Null for a one-way: one row, from the price graph. */
  ret: [string, string] | null;
  separate: boolean;
  mix: boolean;
  /** The traveller's own dates, marked on the grid. */
  requested?: { out: string; ret: string };
};

/** Re-exported for the routes that validate days. */
export { isDay };

/** Orders a window and clips it to today onward and to MAX_GRID_DAYS. Null if invalid or entirely past. */
export function cleanWindow(w: unknown, today: string): [string, string] | null {
  if (!Array.isArray(w) || !isDay(w[0]) || !isDay(w[1])) return null;
  let [a, b] = w[0] <= w[1] ? [w[0], w[1]] : [w[1], w[0]];
  if (b < today) return null;
  if (a < today) a = today;
  if (daysBetween(a, b) >= MAX_GRID_DAYS) b = shiftDay(a, MAX_GRID_DAYS - 1);
  return [a, b];
}

/** Route and ticket rules for a grid: the existing grid's, else the plan's, since fixed-date searches have no grid yet. */
export function gridRoute(grid: GridView | null | undefined, plan: { origins: { code: string }[]; destinations: { code: string }[]; separateTickets: boolean; mixAirports: boolean } | null | undefined) {
  // Grids saved without a route fall back to the plan.
  if (grid?.route) return { from: grid.route.from, to: grid.route.to, separate: grid.separate, mix: grid.mixed ?? false };
  if (!plan?.origins[0] || !plan.destinations.length) return null;
  return { from: plan.origins[0].code, to: plan.destinations.map((d) => d.code), separate: plan.separateTickets, mix: plan.mixAirports };
}

/** Throws `Unanswered` (asking.ts) when any call never answered. Null when nothing in the window is priced. */
export async function buildGrid(opts: {
  backend: FlightBackend;
  req: SearchRequest;
  ask: GridAsk;
  /** The grid being widened or trimmed. Its priced cells are kept, and only missing days are asked. */
  existing?: GridView | null;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<GridView | null> {
  const { backend, req, ask, existing } = opts;
  const log = opts.log ?? (() => {});
  if (!backend.dateGrid && !backend.priceGraph) {
    log(`${backend.name} has no calendars, so no grid`);
    return null;
  }
  const signal = opts.signal ?? AbortSignal.timeout(GRID_DEADLINE_MS);
  const asking = asker({ signal, log: (t) => log(t.trim()) });
  // Stays past three weeks only add cells, so a miss there keeps what came back and doesn't fail the grid.
  const extra = asker({ signal, log: (t) => log(t.trim()), bestEffort: true });
  const tos = [...new Set(ask.to)].filter((c) => AIRPORTS[c]).slice(0, 2);
  if (!AIRPORTS[ask.from] || !tos.length) return null;
  const outWin = ask.out;
  const retWin = ask.ret;
  const requested = ask.requested ?? { out: outWin[0], ret: retWin ? retWin[1] : outWin[0] };
  const asks = newWindows(outWin, retWin, existing);
  if (!asks.length) return mergeGrids(null, existing, outWin, retWin);
  const plan: TripPlan = {
    origins: [{ code: ask.from, name: AIRPORTS[ask.from]?.city ?? ask.from }],
    destinations: tos.map((c) => ({ code: c, name: AIRPORTS[c]?.city ?? c })),
    openHint: null,
    mixAirports: tos.length > 1 && ask.mix,
    separateTickets: ask.separate,
    dates: { anchor: { out: requested.out, ret: retWin ? requested.ret : null }, out: outWin, ret: retWin, prefer: "none", note: null, trimmed: false },
    picks: [],
    musts: [],
    understood: "",
    reading: {},
  };
  // Resolve places as the search does, so one call covers all of a place's airports.
  const ends = new Map<string, Endpoint>();
  await Promise.all([ask.from, ...tos].map(async (c) => ends.set(c, await resolveEndpoint(backend, asking.must, { code: c, name: AIRPORTS[c]?.city ?? c }))));
  asking.allAnswered();
  const endpointOf = (c: string) => ends.get(c)?.q ?? c;
  const combos = tos.map((d) => ({ o: ask.from, d, oq: endpointOf(ask.from), dq: endpointOf(d) }));
  const grids: GridSource[] = [];
  const graphsOut = new Map<string, Map<string, number>>();
  const graphsBack = new Map<string, Map<string, number>>();
  const takeGraph = (graphs: Map<string, Map<string, number>>, key: string, pts: { outDate: string; price: number | null }[]) => {
    const m = graphs.get(key) ?? new Map<string, number>();
    for (const p of pts) if (p.price != null) m.set(p.outDate, Math.min(m.get(p.outDate) ?? Infinity, p.price));
    graphs.set(key, m);
  };
  const jobs: Promise<unknown>[] = [];
  const named = (w: Ask) => (existing ? ` ${w.out[0]}–${w.out[1]}${w.ret ? ` × ${w.ret[0]}–${w.ret[1]}` : ""}` : "");
  for (const { o, d, oq, dq } of combos) {
    if (retWin) {
      const take = (pts: DatePricePoint[]) => {
        let g = grids.find((x) => x.d === d);
        if (!g) grids.push((g = { o, d, cells: new Map() }));
        for (const p of pts) if (p.returnDate && p.price != null) g.cells.set(`${p.outDate}~${p.returnDate}`, Math.min(g.cells.get(`${p.outDate}~${p.returnDate}`) ?? Infinity, p.price));
        log(`price grid ${o}→${d}: ${g.cells.size} date pairs`);
      };
      for (const w of asks) {
        const ret = w.ret!;
        const q = queryFor(req, oq, dq, w.out[0], ret[1]);
        const cells = gridCellCount(w.out, ret);
        if (cells) jobs.push(askCalendar(asking, `price grid ${o}→${d}${named(w)}`, backend.dateGrid ? (co) => backend.dateGrid!(q, w.out, ret, co) : null, take));
        // The grid can omit stays past three weeks, so a price graph per stay length fills them in (also as one ticket).
        for (const stay of longStays(w.out, ret, daysBetween(requested.out, requested.ret)))
          jobs.push(
            askCalendar(extra, `${stay.days}-day trips ${o}→${d}${named(w)}`, backend.priceGraph ? (co) => backend.priceGraph!(q, stay.range, [stay.days, stay.days], co) : null, (pts) =>
              take(pts.filter((p) => p.returnDate && p.returnDate >= ret[0] && p.returnDate <= ret[1]))
            )
          );
      }
      // One-way graphs span the full windows: a new day pairs with every day the other way, and one call covers any range.
      if (ask.separate) {
        jobs.push(askCalendar(asking, `one-way prices ${o}→${d}`, backend.priceGraph ? (co) => backend.priceGraph!(queryFor(req, oq, dq, outWin[0], null), outWin, [1, 1], co) : null, (pts) => takeGraph(graphsOut, `${o}~${d}`, pts)));
        jobs.push(askCalendar(asking, `one-way prices ${d}→${o}`, backend.priceGraph ? (co) => backend.priceGraph!(queryFor(req, dq, oq, retWin[1], null), retWin, [1, 1], co) : null, (pts) => takeGraph(graphsBack, `${d}~${o}`, pts)));
      }
    } else {
      for (const w of asks)
        jobs.push(askCalendar(asking, `one-way prices ${o}→${d}${named(w)}`, backend.priceGraph ? (co) => backend.priceGraph!(queryFor(req, oq, dq, w.out[0], null), w.out, [1, 1], co) : null, (pts) => takeGraph(graphsOut, `${o}~${d}`, pts)));
    }
  }
  await Promise.all(jobs);
  asking.allAnswered();
  const built = assembleGrid(plan, combos, grids, graphsOut, graphsBack, new CandidatePool());
  const merged = mergeGrids(built, existing, outWin, retWin);
  if (!merged) return null;
  return { ...merged, requested, route: { from: ask.from, to: tos }, separate: ask.separate, ...(tos.length > 1 ? { airports: tos } : {}), ...(plan.mixAirports ? { mixed: true } : {}) };
}

type Ask = { out: [string, string]; ret: [string, string] | null };

/** Windows to ask: the full grid if new, else only missing days (new rows across all return days, new columns for kept rows). */
function newWindows(out: [string, string], ret: [string, string] | null, existing: GridView | null | undefined): Ask[] {
  const a = existing?.outDates[0];
  const b = existing?.outDates.at(-1);
  if (!existing || !a || !b || b < out[0] || a > out[1]) return [{ out, ret }];
  // Missing days before and after the grid's range. A grid's days are contiguous.
  const missing = (w: [string, string], have: string[]): [string, string][] => {
    const first = have[0];
    const last = have.at(-1);
    if (!first || !last || last < w[0] || first > w[1]) return [w];
    return [...(w[0] < first ? [[w[0], shiftDay(first, -1)] as [string, string]] : []), ...(w[1] > last ? [[shiftDay(last, 1), w[1]] as [string, string]] : [])];
  };
  const asks: Ask[] = missing(out, existing.outDates).map((o) => ({ out: o, ret }));
  if (ret) {
    const kept: [string, string] = [a > out[0] ? a : out[0], b < out[1] ? b : out[1]];
    for (const r of missing(ret, existing.returnDates)) asks.push({ out: kept, ret: r });
  }
  return asks;
}

/** Merges a fresh grid with an old one over the windows. A cell priced in the old grid keeps its old price. */
export function mergeGrids(fresh: GridView | null, old: GridView | null | undefined, out: [string, string], ret: [string, string] | null): GridView | null {
  const inOut = (d: string) => d >= out[0] && d <= out[1];
  const inRet = (d: string) => (ret ? d >= ret[0] && d <= ret[1] : true);
  const keep = (old?.cells ?? []).filter((c) => inOut(c.outDate) && inRet(c.returnDate) && c.price != null);
  if (!fresh && !keep.length) return null;
  const cells = new Map((fresh?.cells ?? []).map((c) => [`${c.outDate}~${c.returnDate}`, c]));
  for (const c of keep) cells.set(`${c.outDate}~${c.returnDate}`, c);
  const days = (w: [string, string]) => {
    const xs: string[] = [];
    for (let d = w[0]; d <= w[1]; d = shiftDay(d, 1)) xs.push(d);
    return xs;
  };
  const outDates = days(out);
  const returnDates = ret ? days(ret) : [];
  const all = ret
    ? outDates.flatMap((o) => returnDates.filter((r) => r > o).map((r) => cells.get(`${o}~${r}`) ?? { outDate: o, returnDate: r, price: null }))
    : outDates.map((o) => cells.get(`${o}~${o}`) ?? { outDate: o, returnDate: o, price: null });
  if (!all.some((c) => c.price != null)) return null;
  return { ...(fresh ?? old!), outDates, returnDates, cells: all };
}

/** A bought fare keyed by its days (a one-way uses its day twice, as the grid does). */
export type HeldFare = { outDate: string; returnDate: string; price: number; via: GridVia };

/** The fares on a search's cards, by travel days. A round-trip fare without an itemised return is dated by its nights. */
export function heldFares(plans: FlightPlan[] | null | undefined): HeldFare[] {
  const held: HeldFare[] = [];
  for (const p of plans ?? []) {
    const out = p.legs.find((l) => l.direction === "outbound");
    const back = p.legs.find((l) => l.direction === "return");
    if (!out?.isoDate || !isDay(out.isoDate) || !(p.price > 0)) continue;
    const returnDate = back?.isoDate ?? (!p.roundTripFare ? out.isoDate : p.nights != null ? shiftDay(out.isoDate, p.nights) : null);
    if (!returnDate || !isDay(returnDate)) continue;
    held.push({ outDate: out.isoDate, returnDate, price: p.price, via: { tickets: p.booking?.returnUrl ? "two" : "one", out: out.to, back: back?.from ?? p.backFrom ?? out.to } });
  }
  return held;
}

/** Puts each bought fare on its cell where the grid price is higher or missing, so cells agree with the cards. */
export function withHeld(grid: GridView, held: HeldFare[]): GridView {
  const best = new Map<string, HeldFare>();
  for (const h of held) {
    const k = `${h.outDate}~${h.returnDate}`;
    const cur = best.get(k);
    if (!cur || h.price < cur.price) best.set(k, h);
  }
  let changed = false;
  const cells = grid.cells.map((c) => {
    const h = best.get(`${c.outDate}~${c.returnDate}`);
    if (!h || (c.price != null && c.price <= h.price)) return c;
    changed = true;
    const oneTicket = h.via.tickets === "two" ? (c.via?.tickets === "one" ? c.price : c.oneTicket) : undefined;
    return { outDate: c.outDate, returnDate: c.returnDate, price: h.price, via: h.via, ...(oneTicket != null ? { oneTicket } : {}) };
  });
  return changed ? { ...grid, cells } : grid;
}
