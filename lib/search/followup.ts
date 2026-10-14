import { isPlaceId, type FlightBackend } from "@/lib/flights/backend";
import type { SearchInput } from "@/lib/flights/types";
import { AIRPORTS } from "@/lib/airports";
import { money, shortDate } from "@/lib/format";
import type { DestinationView, FlightPlan, GridView, PlanView, SearchRequest } from "@/lib/types";
import { airportsOf, asker, faresAsker, resolveEndpoint, Unanswered, type Endpoint } from "./asking";
import { compactForLLM, daysBetween, describeInput, mapLimit, shiftDay, toSearchInput, type CompactRow, type IndexedItin, type PlannedQuery } from "./core";
import { abroadOnly, destinationViews } from "./engine";
import { buildGrid, cleanWindow, gridRoute, heldFares, withHeld } from "./grid";
import type { Answer } from "./voice";

/**
 * Provider calls for a follow-up question: its shopping queries and any grid or place list it asks for. Calls that never
 * answered come back in `unanswered`, and the follow-up isn't answered from partial results.
 */

export const MAX_FOLLOWUP_QUERIES = 8;

/** Same identity as the pool uses, so an itinerary found again isn't a new row. */
const keyOf = (rt: boolean, ret: string | null | undefined, from: string, to: string, dep: string, arr: string, fn: string, price: number | null) => [rt, ret ?? "", from, to, dep, arr, fn, price].join("~");

/** Expands a query the way the search asks: round trips per airport pair, one-ways by place, anything else unchanged. */
function asTheSearchAsks(input: SearchInput, ends: Map<string, Endpoint>): SearchInput[] {
  const [a, b] = input.flights;
  const byCode = (c: string) => !isPlaceId(c);
  if (input.trip === "round-trip" && b && b.from_airport === a.to_airport && b.to_airport === a.from_airport && byCode(a.from_airport) && byCode(a.to_airport)) {
    return airportsOf(a.from_airport, ends.get(a.from_airport)).flatMap((f) =>
      airportsOf(a.to_airport, ends.get(a.to_airport)).map((t) => ({ ...input, flights: [{ ...a, from_airport: f, to_airport: t }, { ...b, from_airport: t, to_airport: f }] }))
    );
  }
  if (input.trip === "one-way" && a && !b) {
    const place = (c: string) => ends.get(c)?.q ?? c;
    return [{ ...input, flights: [{ ...a, from_airport: place(a.from_airport), to_airport: place(a.to_airport) }] }];
  }
  return [input];
}

export async function runFollowUpQueries(opts: {
  backend: FlightBackend;
  /** The fares-only provider asked when the live one never answers (lib/flights/provider.ts). */
  fallback?: FlightBackend | null;
  req: SearchRequest;
  queries: PlannedQuery[];
  existing: CompactRow[];
  /** The follow-up's deadline, shared with its grid or list. */
  signal: AbortSignal;
  log: (line: string) => void;
}): Promise<{ rows: CompactRow[]; asked: number; calls: number; firstId: number; unanswered: string[] }> {
  const { backend, req, existing, log } = opts;
  const queries = opts.queries.slice(0, MAX_FOLLOWUP_QUERIES);
  const asking = asker({ signal: opts.signal, log: (t) => log(t.trim()) });
  const spare = opts.fallback ? asker({ signal: opts.signal, log: (t) => log(t.trim()), bestEffort: true }) : null;
  const fares = faresAsker({ backend, fallback: opts.fallback, ask: asking, spare, log: (t) => log(t.trim()) });
  const seen = new Set(existing.map((r) => keyOf(r.fare === "round-trip", r.retDate, r.from, r.to, r.dep, r.arr, r.fn.join("|"), r.price)));
  let nextId = existing.reduce((m, r) => Math.max(m, r.id), -1) + 1;
  const nextQ = existing.reduce((m, r) => Math.max(m, r.q ?? 0), 999) + 1;
  const firstId = nextId;
  const inputs = queries.map((q) => toSearchInput(q, req));

  // Resolve every place the queries name, as the search does.
  const codes = [...new Set(inputs.flatMap((i) => i.flights.flatMap((l) => [l.from_airport, l.to_airport])))].filter((c) => !isPlaceId(c) && AIRPORTS[c]);
  const ends = new Map<string, Endpoint>();
  await Promise.all(codes.map(async (c) => ends.set(c, await resolveEndpoint(backend, asking.must, { code: c, name: AIRPORTS[c]?.city ?? c }))));
  if (asking.unanswered.length) return { rows: [], asked: queries.length, calls: 0, firstId, unanswered: [...asking.unanswered] };

  // Dedupe, since separate queries from nearby airports (ORD, MDW) expand to the same calls.
  const same = (x: SearchInput) => `${x.trip}|${x.flights.map((l) => `${l.from_airport}>${l.to_airport}@${l.date}/${l.max_stops ?? ""}`).join(",")}|${x.max_price ?? ""}`;
  const unique = new Map<string, { input: SearchInput; i: number }>();
  inputs.forEach((input, i) => asTheSearchAsks(input, ends).forEach((one) => unique.has(same(one)) || unique.set(same(one), { input: one, i })));
  const calls = [...unique.values()];
  const rows: CompactRow[] = [];
  await mapLimit(calls, 8, async ({ input, i }) => {
    const reason = queries[i].reason;
    const payload = await fares(input, `${describeInput(input)} — ${reason}`);
    if (!payload) return;
    const rt = input.trip === "round-trip";
    const retDate = rt ? input.flights[1]?.date : undefined;
    for (const itin of payload.itineraries) {
      const fn = itin.segments.map((s) => `${s.airlineCode ?? "?"} ${s.flightNumber ?? "?"}`).join("|");
      const key = keyOf(rt, retDate, itin.from, itin.to, itin.departure, itin.arrival, fn, itin.price);
      if (seen.has(key)) continue;
      seen.add(key);
      const x: IndexedItin = { id: nextId++, itin, queryIndex: nextQ + i, rt, retDate };
      rows.push({ ...compactForLLM(x), bookingToken: itin.bookingToken ?? null });
    }
    log(`${describeInput(input)} → ${payload.itineraries.length} itineraries — ${reason}`);
  });
  rows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  return { rows: rows.slice(0, 150), asked: queries.length, calls: calls.length, firstId, unanswered: [...asking.unanswered] };
}

type ViewAsk = NonNullable<Answer["search"]>;

/** Days added either side of a grid question's dates when the grid is rebuilt around them. */
const AROUND_DAYS = 3;

/**
 * For a question asked from the date grid about other days, the grid to rebuild: those days (from its queries, else its picks)
 * plus a few either side, on the grid's route. Null when the days are already on the grid or there is no route.
 */
export function gridAround(answer: Answer, rows: CompactRow[], grid: GridView | null | undefined, plan: PlanView | null | undefined): ViewAsk["grid"] {
  const route = gridRoute(grid, plan);
  if (!route) return null;
  const oneWay = grid ? grid.returnDates.length === 0 : !plan?.dates.ret;
  const anchor = grid?.requested ?? (plan ? { out: plan.dates.anchor.out, ret: plan.dates.anchor.ret ?? plan.dates.anchor.out } : null);
  const stay = anchor ? daysBetween(anchor.out, anchor.ret) : 7;
  const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const pairs: { out: string; ret: string | null }[] = [];
  for (const q of answer.search?.queries ?? []) if (day(q.legs[0]?.date)) pairs.push({ out: q.legs[0].date, ret: day(q.legs[1]?.date) ? q.legs[1].date : null });
  if (!pairs.length)
    for (const p of answer.picks) {
      const out = rows.find((r) => r.id === p.outbound_id);
      const back = p.return_id != null ? rows.find((r) => r.id === p.return_id) : undefined;
      if (out) pairs.push({ out: out.dep.slice(0, 10), ret: out.retDate ?? back?.dep.slice(0, 10) ?? null });
    }
  // A one-way question on a round-trip grid keeps the grid's own length of stay.
  const trips = pairs.map((p) => ({ out: p.out, ret: oneWay ? null : (p.ret ?? shiftDay(p.out, stay)) }));
  const onGrid = (t: { out: string; ret: string | null }) => !!grid?.outDates.includes(t.out) && (t.ret == null || grid.returnDates.includes(t.ret));
  if (!trips.length || trips.every(onGrid)) return null;
  const outs = trips.map((t) => t.out).sort();
  const rets = trips.flatMap((t) => (t.ret ? [t.ret] : [])).sort();
  return {
    from: route.from,
    to: route.to,
    out_from: shiftDay(outs[0], -AROUND_DAYS),
    out_to: shiftDay(outs[outs.length - 1], AROUND_DAYS),
    ret_from: rets.length ? shiftDay(rets[0], -AROUND_DAYS) : null,
    ret_to: rets.length ? shiftDay(rets[rets.length - 1], AROUND_DAYS) : null,
    mix: route.mix,
  };
}

/** Builds the grid or place list a follow-up asked for. Returns the view, a summary for the model, and what never answered. */
export async function runFollowUpViews(opts: {
  backend: FlightBackend;
  req: SearchRequest;
  ask: ViewAsk;
  /** The follow-up's deadline, shared with its queries. */
  signal: AbortSignal;
  log: (line: string) => void;
  /** Whether a cell may be two tickets: the chat's grid's rule, or the plan's. */
  separate: boolean;
  /** The traveller's day: no window starts before it. */
  today?: string;
  /** The search's own dates, marked on the grid. */
  requested?: { out: string; ret: string };
  /** The search's plans. A rebuilt grid keeps their fares on their days. */
  plans?: FlightPlan[];
}): Promise<{ grid?: GridView; destinations?: DestinationView[]; viewTitle?: string; summary: string[]; unanswered: string[] }> {
  const { backend, req, ask, log, signal } = opts;
  const fmt = (n: number) => money(n, req.currency, req.locale);
  const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  const code = (v: unknown): string | null => (typeof v === "string" && /^[A-Z]{3}$/i.test(v.trim()) && AIRPORTS[v.trim().toUpperCase()] ? v.trim().toUpperCase() : null);
  const out: { grid?: GridView; destinations?: DestinationView[]; viewTitle?: string; summary: string[]; unanswered: string[] } = { summary: [], unanswered: [] };

  if (ask.grid) {
    const g = ask.grid;
    const from = code(g.from);
    const tos = [...new Set(g.to.map(code).filter((c): c is string => !!c))].slice(0, 2);
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    const outWin = cleanWindow([g.out_from, g.out_to], today);
    const retWin = g.ret_from && g.ret_to ? cleanWindow([g.ret_from, g.ret_to], today) : null;
    if (from && tos.length && outWin && (!g.ret_from || (retWin && retWin[1] > outWin[0]))) {
      // A grid with unanswered calls isn't built (grid.ts).
      const grid = await buildGrid({ backend, req, ask: { from, to: tos, out: outWin, ret: retWin, separate: opts.separate, mix: tos.length > 1 && g.mix, requested: opts.requested }, signal, log }).catch((e) => {
        if (!(e instanceof Unanswered)) throw e;
        out.unanswered.push(...e.what);
        return undefined;
      });
      if (grid) {
        // Keep the search's own fares on their days, as on every grid the route returns.
        out.grid = withHeld(grid, heldFares(opts.plans ?? []));
        const span = (w: [string, string]) => (w[0] === w[1] ? shortDate(w[0], req.locale) : `${shortDate(w[0], req.locale)}–${shortDate(w[1], req.locale)}`);
        out.viewTitle = `${AIRPORTS[from]?.city ?? from} → ${tos.map((d) => AIRPORTS[d]?.city ?? d).join(" or ")} · out ${span(outWin)}${retWin ? ` · back ${span(retWin)}` : ""}`;
        const priced = grid.cells.filter((c) => c.price != null).sort((a, b) => a.price! - b.price!);
        const two = priced.filter((c) => c.via?.tickets === "two").length;
        out.summary.push(
          `The chat's date grid was rebuilt for these dates (the traveller opens it from the Date grid button): ${priced.length} of ${grid.cells.length} pairs of days priced, each as the cheapest way to fly it${tos.length > 1 ? " into either airport" : ""}${two ? `, ${two} of them as two tickets` : ""}. Cheapest cells: ${priced
            .slice(0, 5)
            .map((c) => `${c.outDate}→${c.returnDate} ${fmt(c.price!)}${c.via ? ` (${c.via.tickets === "two" ? "two tickets" : "one ticket"}${tos.length > 1 ? `, ${c.via.out}${c.via.back !== c.via.out ? ` back from ${c.via.back}` : ""}` : ""})` : ""}`)
            .join("; ")}. Priciest: ${priced.length ? fmt(priced[priced.length - 1].price!) : "—"}.`
        );
      } else if (grid === null) out.summary.push("The date grid was not built: there are no fares for those dates.");
    } else out.summary.push("The date grid was not built: the request named an unknown airport or an impossible date.");
  }

  if (ask.explore) {
    const x = ask.explore;
    const origin = code(x.origin);
    if (origin && !backend.explore) out.summary.push("The list of places was not built: the flight provider has no Explore.");
    else if (origin) {
      const asking = asker({ signal, log: (t) => log(t.trim()) });
      const found = await asking.must(
        (o) =>
          backend.explore!(origin, {
            ...o,
            dates: isIso(x.out_date) ? { out: x.out_date, ret: isIso(x.ret_date) ? x.ret_date : null } : null,
            passengers: [Math.max(1, req.passengers.adults), req.passengers.children, req.passengers.infantsInSeat, req.passengers.infantsOnLap],
            seat: req.cabin,
            currency: req.currency,
            carryOnBags: req.bags.carryOn || undefined,
            checkedBags: req.bags.checked || undefined,
          }),
        `explore from ${origin}`
      );
      out.unanswered.push(...asking.unanswered);
      if (found) {
        const places = destinationViews(abroadOnly(found.filter((d) => d.code && d.code !== origin), origin, x.hint), new Set());
        const priced = places.filter((d) => d.price != null);
        out.destinations = places;
        out.viewTitle = out.viewTitle ?? `Where you could go from ${AIRPORTS[origin]?.city ?? origin}${isIso(x.out_date) ? ` on ${shortDate(x.out_date, req.locale)}${isIso(x.ret_date) ? ` – ${shortDate(x.ret_date, req.locale)}` : ""}` : ""}`;
        log(`explore from ${origin}: ${priced.length} places priced`);
        out.summary.push(
          `${priced.length} places were priced from ${origin}${/international|abroad|overseas/i.test(x.hint) ? " outside its country" : ""} (the page shows them as cards under your answer). Cheapest: ${priced
            .slice(0, 8)
            .map((d) => `${d.name} (${d.code}) ${fmt(d.price!)}${d.stops === 0 ? " nonstop" : ""}`)
            .join("; ")}. "${x.hint}" beyond "international" is not something the list can filter by — say so if it matters.`
        );
      }
    } else out.summary.push("The list of places was not built: the origin was not an airport code.");
  }
  return out;
}
