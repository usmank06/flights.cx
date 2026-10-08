import { AIRPORTS } from "@/lib/airports";
import { bookingFor } from "@/lib/flights/provider";
import type { BookingContext, Itinerary, SearchInput } from "@/lib/flights/types";
import type { FlightLeg, FlightPlan, PlanBooking, SearchRequest } from "@/lib/types";
import { seatedTravellers } from "@/lib/types";
import { shortDate } from "@/lib/format";
import { compactForLLM, fmtDur, itinToLeg, languageTag, type CompactRow, type IndexedItin } from "./core";
import { isOpenDestination, resolveAirport } from "./intake";
import { stayNights } from "./candidates";

/**
 * Builds plan cards from model picks and from raw itineraries, for follow-ups and grid cells. Models return row ids only.
 * Every number on a card comes from the stored row.
 */

function compactToLeg(row: CompactRow, direction: FlightLeg["direction"], locale = "en-US"): FlightLeg {
  const dayDiff = Math.round((Date.parse(row.arr.slice(0, 10)) - Date.parse(row.dep.slice(0, 10))) / 86_400_000);
  return {
    direction,
    from: row.from,
    to: row.to,
    date: shortDate(row.dep, locale),
    isoDate: row.dep.slice(0, 10),
    departTime: row.dep.slice(11, 16),
    arriveTime: row.arr.slice(11, 16) + (dayDiff > 0 ? `+${dayDiff}` : dayDiff < 0 ? `−${-dayDiff}` : ""),
    airline: row.air.join(" · "),
    flightNumber: row.fn.join(" / "),
    duration: fmtDur(row.durMin),
    stops: row.stops,
    stopNote: row.lay.length
      ? row.lay
          .map((l) => {
            const m = /^(\S+)\s+(\d+)m$/.exec(l);
            return m ? `${fmtDur(Number(m[2]))} in ${m[1]}` : l;
          })
          .join("; ")
      : undefined,
  };
}

const placeName = (code: string) => (AIRPORTS[code] ? `${AIRPORTS[code].city} (${code})` : code);

/**
 * Airports and cities named in a from/to field, which a plan may use without a note. A typed code matches only that airport, a
 * city matches all its airports, and "Lisbon or Porto" matches both. EWR's city is Newark, so "New York" excludes it.
 * `primary` is the first place named.
 */
function wantedIn(text: string): { codes: Set<string>; cities: Set<string>; primary: string | null } {
  const codes = new Set<string>();
  const cities = new Set<string>();
  let primary: string | null = null;
  for (const part of (text ?? "").split(/\s*(?:\bor\b|\band\b|,|\/|\|)\s*/i)) {
    const t = part.trim();
    const code = t ? resolveAirport(t) : undefined;
    if (!code) continue;
    primary ??= code;
    if (/^[A-Za-z]{3}$/.test(t) && t.toUpperCase() === code) codes.add(code);
    else if (AIRPORTS[code]) cities.add(AIRPORTS[code].city);
  }
  return { codes, cities, primary };
}

const within = (code: string, w: { codes: Set<string>; cities: Set<string> }) => w.codes.has(code) || (AIRPORTS[code] != null && w.cities.has(AIRPORTS[code].city));

/**
 * Appends a note to the summary of any plan that leaves from or lands at an airport the traveller didn't name. Both checks use
 * the outbound leg, since a round trip's last leg lands back home.
 */
export function noteRouteSwaps(plans: FlightPlan[], req: SearchRequest): FlightPlan[] {
  const from = wantedIn(req.from);
  const to = isOpenDestination(req.to) ? null : wantedIn(req.to);
  return plans.map((plan) => {
    const out = plan.legs[0];
    if (!out) return plan;
    const swaps: string[] = [];
    if (from.primary && !within(out.from, from)) swaps.push(`leaves from ${placeName(out.from)}, not ${placeName(from.primary)}`);
    if (to?.primary && !within(out.to, to)) swaps.push(`lands at ${placeName(out.to)}, not ${placeName(to.primary)}`);
    if (!swaps.length) return plan;
    const base = (plan.summary ?? "").trim();
    const summary = `${base}${base && !/[.!?]$/.test(base) ? "." : ""} Note this ${swaps.join(", and ")}.`.trim();
    return { ...plan, summary };
  });
}

/**
 * Booking link built from a compacted session row (`SessionState.rows`, as written by `compactForLLM`), since follow-ups keep only
 * those rows. Each row's `seg` entries let it link the same selected flights as the full itinerary.
 */
function bookingForRow(
  row: {
    fare: "one-way" | "round-trip";
    from: string;
    to: string;
    dep: string;
    stops: number;
    lay: string[];
    fn: string[];
    seg: string[];
    retDate?: string | null;
    backFrom?: string;
    bookingToken?: string | null;
  },
  ret: { from: string; to: string; dep: string; stops: number; lay: string[]; fn: string[]; seg: string[] } | undefined,
  ctx: BookingContext
): PlanBooking {
  const toItin = (r: { from: string; to: string; dep: string; stops: number; lay: string[]; fn: string[]; seg: string[] }): Itinerary => {
    // Row digest formats: `lay` is "ORD 145m", `seg` is "ORD YYYY-MM-DD DOH QR 732" (one per flown segment).
    const segments = r.seg.map((s) => {
      const t = s.split(/\s+/);
      return { from: { code: t[0], name: "" }, departure: t[1], to: { code: t[2], name: "" }, airlineCode: t[3], flightNumber: t[4] };
    });
    return {
      from: r.from,
      to: r.to,
      departure: r.dep,
      stops: r.stops,
      layovers: r.lay.map((l) => ({ airport: l.split(/\s+/)[0] ?? "", minutes: 0 })),
      segments,
      bookingToken: null,
    } as unknown as Itinerary;
  };

  const out = toItin(row);
  (out as { bookingToken: string | null }).bookingToken = row.bookingToken ?? null;
  return bookingFor(out, {
    ret: ret ? toItin(ret) : undefined,
    returnDate: !ret && row.fare === "round-trip" ? (row.retDate ?? null) : null,
    backFrom: row.backFrom ?? null,
    ctx,
  });
}

export function plansFromPicks(
  picks: { label: string; summary: string; outbound_id: number; return_id: number | null }[],
  rows: CompactRow[],
  idPrefix: string,
  req: SearchRequest
): FlightPlan[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seats = seatedTravellers(req.passengers);
  const ctx: BookingContext = {
    passengers: req.passengers,
    cabin: req.cabin,
    bags: req.bags,
    currency: req.currency,
    language: languageTag(req.locale),
  };
  const plans: FlightPlan[] = [];
  for (const [i, pick] of picks.entries()) {
    const out = byId.get(pick.outbound_id);
    if (!out) continue; // unknown id: skip this plan only
    // A round-trip row already covers the return, so pairing it with another row would double-count the price.
    const ret =
      pick.return_id != null && out.fare !== "round-trip"
        ? (() => {
            const r = byId.get(pick.return_id);
            return r && r.fare === "one-way" ? r : undefined;
          })()
        : undefined;
    // Skip unpriced rows rather than treating them as 0.
    if (out.price == null || (ret && ret.price == null)) continue;
    const legs = [compactToLeg(out, "outbound", req.locale)];
    if (ret) legs.push(compactToLeg(ret, "return", req.locale));
    const isRtFare = out.fare === "round-trip" && !ret;
    const price = out.price + (ret?.price ?? 0);
    plans.push({
      id: `${idPrefix}-${i}`,
      label: pick.label,
      price,
      currency: req.currency,
      ...(seats > 1 ? { perTraveller: Math.round(price / seats), travellers: seats } : {}),
      legs,
      summary: pick.summary,
      ...(isRtFare ? { roundTripFare: true, returnDate: out.retDate ? shortDate(out.retDate, req.locale) : undefined } : {}),
      booking: bookingForRow(out, ret, ctx),
      pickedBy: "code",
    });
  }
  return plans;
}

/** Indices of the `limit` cheapest priced itineraries, in the order `plansFromItineraries` shows them. */
export function topPriced(itins: Itinerary[], limit = 6): number[] {
  return itins
    .map((itin, id) => ({ id, price: itin.price }))
    .filter((x) => x.price != null)
    .sort((a, b) => a.price! - b.price!)
    .slice(0, limit)
    .map((x) => x.id);
}

/**
 * Plans for the priced itineraries from one shopping call, cheapest first. `returns` maps an itinerary's index to the return the
 * provider paired with it (priced as the round-trip total). A plan with a return links to the booking page, else to the return choice.
 */
export function plansFromItineraries(
  itins: Itinerary[],
  input: SearchInput,
  req: SearchRequest,
  idPrefix: string,
  limit = 6,
  returns: Map<number, Itinerary> = new Map()
): { plans: FlightPlan[]; rows: CompactRow[] } {
  const rt = input.trip !== "one-way";
  const retDate = rt ? input.flights[1]?.date : undefined;
  // An open-jaw multi-city fare: one ticket whose return leaves from another airport.
  const jaw = input.trip === "multi-city" && input.flights[1] ? { from: input.flights[1].from_airport, to: input.flights[1].to_airport } : undefined;
  const seats = seatedTravellers(req.passengers);
  const ctx: BookingContext = { passengers: req.passengers, cabin: req.cabin, bags: req.bags, currency: req.currency, language: languageTag(req.locale) };
  const indexed: IndexedItin[] = itins.map((itin, id) => ({ id, itin, queryIndex: 0, rt, retDate, ...(jaw ? { jaw } : {}) }));
  const priced = indexed.filter((x) => x.itin.price != null).sort((a, b) => a.itin.price! - b.itin.price!);
  const plans: FlightPlan[] = priced.slice(0, limit).map((x, i) => {
    const back = rt && !jaw ? returns.get(x.id) : undefined;
    const price = back?.price ?? x.itin.price!;
    const nights = stayNights(x, null);
    return {
      id: `${idPrefix}-${i}`,
      label: i === 0 ? "Cheapest" : x.itin.stops === 0 && !priced.slice(0, i).some((y) => y.itin.stops === 0) ? "Nonstop" : `Option ${i + 1}`,
      price,
      currency: req.currency,
      ...(seats > 1 ? { perTraveller: Math.round(price / seats), travellers: seats } : {}),
      legs: [itinToLeg(x, "outbound", req.locale), ...(back ? [itinToLeg({ id: -x.id, itin: back, queryIndex: 0, rt, retDate }, "return", req.locale)] : [])],
      ...(rt ? { roundTripFare: true, returnDate: retDate ? shortDate(retDate, req.locale) : undefined } : {}),
      ...(jaw ? { backFrom: jaw.from } : {}),
      booking: bookingFor(x.itin, { rtReturn: back, returnDate: rt ? (retDate ?? null) : null, backFrom: jaw?.from ?? null, ctx }),
      pickedBy: "code" as const,
      carryOnIncluded: x.itin.carryOnIncluded,
      ...(nights != null ? { nights } : {}),
    };
  });
  return { plans: noteRouteSwaps(plans, req), rows: priced.map((x) => ({ ...compactForLLM(x), bookingToken: x.itin.bookingToken ?? null })) };
}

/**
 * Pairs one-way outbounds with returns that depart on a later day, cheapest pair first. The price is the sum of both tickets
 * and the booking has two links.
 */
export function plansFromOneWays(
  outs: Itinerary[],
  rets: Itinerary[],
  inputOut: SearchInput,
  inputRet: SearchInput,
  req: SearchRequest,
  idPrefix: string,
  limit = 6
): { plans: FlightPlan[]; rows: CompactRow[] } {
  const seats = seatedTravellers(req.passengers);
  const ctx: BookingContext = { passengers: req.passengers, cabin: req.cabin, bags: req.bags, currency: req.currency, language: languageTag(req.locale) };
  const outIdx: IndexedItin[] = outs.map((itin, id) => ({ id, itin, queryIndex: 0, rt: false }));
  const retIdx: IndexedItin[] = rets.map((itin, i) => ({ id: outs.length + i, itin, queryIndex: 1, rt: false }));
  const pairs: { out: IndexedItin; ret: IndexedItin; price: number }[] = [];
  for (const o of outIdx)
    for (const r of retIdx) {
      if (o.itin.price == null || r.itin.price == null) continue;
      if (r.itin.departure.slice(0, 10) <= o.itin.arrival.slice(0, 10)) continue;
      pairs.push({ out: o, ret: r, price: o.itin.price + r.itin.price });
    }
  pairs.sort((a, b) => a.price - b.price);
  const plans: FlightPlan[] = pairs.slice(0, limit).map((p, i) => {
    const nights = stayNights(p.out, p.ret);
    return {
      id: `${idPrefix}-${i}`,
      label: i === 0 ? "Cheapest" : `Option ${i + 1}`,
      price: p.price,
      currency: req.currency,
      ...(seats > 1 ? { perTraveller: Math.round(p.price / seats), travellers: seats } : {}),
      legs: [itinToLeg(p.out, "outbound", req.locale), itinToLeg(p.ret, "return", req.locale)],
      booking: bookingFor(p.out.itin, { ret: p.ret.itin, ctx }),
      pickedBy: "code" as const,
      carryOnIncluded: p.out.itin.carryOnIncluded,
      ...(nights != null ? { nights } : {}),
    };
  });
  void inputOut;
  void inputRet;
  return { plans: noteRouteSwaps(plans, req), rows: [...outIdx, ...retIdx].map((x) => ({ ...compactForLLM(x), bookingToken: x.itin.bookingToken ?? null })) };
}
