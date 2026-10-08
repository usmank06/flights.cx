import type { Itinerary, SearchInput } from "@/lib/flights/types";
import { AIRPORTS } from "@/lib/airports";
import type { SearchRequest } from "@/lib/types";
import { daysBetween, fmtDur, type IndexedItin } from "./core";
import type { TripPlan } from "./plan";
import { withoutMoney } from "./voice";

/**
 * Candidate pool: every itinerary found, deduped, with stable ids, plus the words each one becomes for picking. Jev sees prices
 * only as bucketed words, and card numbers come from the parsed itinerary.
 */
export class CandidatePool {
  private items: IndexedItin[] = [];
  private seen = new Set<string>();
  private nextId = 0;
  /** Cheapest price for the search as the traveller entered it. */
  baseline: number | null = null;

  add(itins: Itinerary[], input: SearchInput, queryIndex: number, shift?: { out: number; ret: number }): IndexedItin[] {
    const isRt = input.trip === "round-trip" || input.trip === "multi-city";
    const retDate = isRt ? input.flights[1]?.date : undefined;
    const added: IndexedItin[] = [];
    // Open-jaw multi-city fare: one ticket like a round trip, but the return leaves from another airport.
    const jaw = input.trip === "multi-city" && input.flights[1] ? { from: input.flights[1].from_airport, to: input.flights[1].to_airport } : undefined;
    for (const itin of itins) {
      // The return date is part of the key: the same outbound and price with a different return day is a different trip.
      const key = [isRt, retDate ?? "", jaw?.from ?? "", jaw?.to ?? "", itin.from, itin.to, itin.departure, itin.arrival, itin.segments.map((s) => `${s.airlineCode}${s.flightNumber}`).join("|"), itin.price].join("~");
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const x: IndexedItin = { id: this.nextId++, itin, queryIndex, rt: isRt, retDate, ...(shift ? { shift } : {}), ...(jaw ? { jaw } : {}) };
      this.items.push(x);
      added.push(x);
    }
    return added;
  }

  all(): IndexedItin[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Cheapest single-ticket round-trip fare (a full trip price, unlike a one-way). */
  get roundTripFloor(): number | null {
    let min: number | null = null;
    for (const x of this.items) if (x.rt && x.itin.price != null && (min == null || x.itin.price < min)) min = x.itin.price;
    return min;
  }
}

/* ----------------------------- Bookability ------------------------------ */

/**
 * Whether the traveller could book this ticket for their trip: matching fare type, allowed airports at both ends, and dates
 * inside the plan's windows (or the exact dates on a fixed-date search with no plan).
 */
export function bookableFor(
  x: IndexedItin,
  req: SearchRequest,
  okFrom: Set<string>,
  okTo: Set<string>,
  /** Date windows from the plan (single days on a fixed-date plan). Null falls back to the request's own dates. */
  windows: { out: [string, string]; ret: [string, string] | null } | null = null
): boolean {
  const wantsReturn = windows ? windows.ret != null : req.returnDate != null;
  if (!wantsReturn && x.rt) return false;
  if (wantsReturn && !x.rt) return false; // one-way rows pair up separately
  if (okFrom.size && !okFrom.has(x.itin.from)) return false;
  if (okTo.size && !okTo.has(x.itin.to)) return false;
  if (x.jaw && okTo.size && !okTo.has(x.jaw.from)) return false;
  if (windows) {
    const out = x.itin.departure.slice(0, 10);
    if (out < windows.out[0] || out > windows.out[1]) return false;
    if (windows.ret && x.retDate && (x.retDate < windows.ret[0] || x.retDate > windows.ret[1])) return false;
  } else if (!req.datesFlexible) {
    if (req.departDate && x.itin.departure.slice(0, 10) !== req.departDate) return false;
    if (req.returnDate && x.retDate && x.retDate !== req.returnDate) return false;
  }
  return true;
}

/** Nights away, from the outbound date to the return date (or the second ticket's departure). Null for a one-way. */
export function stayNights(out: IndexedItin, ret: IndexedItin | null): number | null {
  const dep = out.itin.departure.slice(0, 10);
  const back = ret ? ret.itin.departure.slice(0, 10) : out.retDate;
  if (!back) return null;
  return Math.max(0, daysBetween(dep, back));
}

/* -------------------------------- Words --------------------------------- */

export type CandidateWords = {
  id: string;
  fare: string;
  price: string;
  against_their_own_search: string | null;
  dates: string;
  /** Length of stay in words, e.g. "twenty-four nights away". */
  stay: string | null;
  out: LegWords;
  back: LegWords | null;
  airports: string | null;
  bags: string | null;
  notes: string[];
};

type LegWords = {
  day: string;
  departs: string;
  arrives: string;
  duration: string;
  stops: string;
  airlines: string;
};

const band = (hhmm: string): string => {
  const h = Number(hhmm.slice(0, 2));
  if (h < 5) return "in the small hours";
  if (h < 8) return "early morning";
  if (h < 12) return "morning";
  if (h < 14) return "midday";
  if (h < 18) return "afternoon";
  if (h < 21) return "evening";
  return "late evening";
};

const dayName = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const place = (code: string) => (AIRPORTS[code] ? `${AIRPORTS[code].city} (${code})` : code);

function legWords(it: Itinerary): LegWords {
  // Signed: across the date line an arrival can be on the calendar day before.
  const days = daysBetween(it.departure.slice(0, 10), it.arrival.slice(0, 10));
  const several = ["", "", "two", "three"][Math.abs(days)] ?? "several";
  const arrDay = days === 0 ? "the same day" : days === 1 ? "the next day" : days === -1 ? "the day before, by the calendar" : days > 0 ? `${several} days later` : `${several} days before, by the calendar`;
  const stops =
    it.stops === 0
      ? "nonstop"
      : `${it.stops} stop${it.stops > 1 ? "s" : ""}: ${it.layovers.map((l) => `${fmtDur(l.minutes)} in ${l.city ?? l.airport}`).join(", ")}`;
  return {
    day: dayName(it.departure.slice(0, 10)),
    departs: `${band(it.departure.slice(11, 16))} (${it.departure.slice(11, 16)})`,
    arrives: `${band(it.arrival.slice(11, 16))} ${arrDay} (${it.arrival.slice(11, 16)})`,
    duration: fmtDur(it.totalDurationMinutes),
    stops,
    airlines: [...new Set(it.segments.map((s) => s.airlineName ?? s.airlineCode ?? "?"))].join(" then "),
  };
}

/** Rank-based price words, so a $40 spread and a $400 spread read the same way. */
export function priceTier(price: number, sorted: number[]): string {
  const min = sorted[0];
  if (price <= min) return "the cheapest of all";
  const pos = sorted.findIndex((p) => p >= price) / Math.max(1, sorted.length - 1);
  if (price <= min * 1.05) return "within a hair of the cheapest";
  if (pos < 0.25) return "among the cheaper ones";
  if (pos < 0.5) return "a little more than the cheap ones";
  if (pos < 0.75) return "noticeably more";
  return "among the priciest";
}

export function candidateWords(
  x: IndexedItin,
  ret: IndexedItin | null,
  req: SearchRequest,
  sortedPrices: number[],
  wantedFrom: string | undefined,
  wantedTo: string | undefined,
  /** Name the destination airport on every candidate, for plans with several destinations. */
  namePlaces = false
): CandidateWords {
  const it = x.itin;
  const total = (it.price ?? 0) + (ret?.itin.price ?? 0);
  const notes: string[] = [];
  if (x.jaw) notes.push(`one ticket that lands at ${place(it.to)} and flies back from ${place(x.jaw.from)}`);
  if (it.segments.some((s) => s.overnight)) notes.push("overnight flight");
  if (it.segments.some((s) => s.oftenDelayed)) notes.push("often delayed by 30 minutes or more");
  const legroom = it.segments[0]?.legroomClass;
  if (legroom === 2) notes.push("below-average legroom");
  if (legroom === 3) notes.push("above-average legroom");
  if (it.layovers.some((l) => l.minutes >= 300)) notes.push("a layover of five hours or more");
  if (it.layovers.some((l) => l.minutes < 60)) notes.push("a tight connection under an hour");
  if (ret) notes.push("two separate tickets, one each way — a missed connection between them is the traveller's problem");
  const airports: string[] = [];
  if (wantedFrom && it.from !== wantedFrom) airports.push(`leaves from ${place(it.from)} instead of ${place(wantedFrom)}`);
  if (wantedTo && it.to !== wantedTo) airports.push(`lands at ${place(it.to)} instead of ${place(wantedTo)}`);
  if (namePlaces) {
    airports.push(`lands at ${place(it.to)}`);
    const backFrom = ret ? ret.itin.from : (x.jaw?.from ?? it.to);
    if (x.retDate || ret) airports.push(backFrom === it.to ? "back from the same airport" : `back from ${place(backFrom)}`);
  }
  const shift = x.shift;
  const dates =
    !shift || (shift.out === 0 && shift.ret === 0)
      ? "on the dates asked for"
      : [
          shift.out === 0 ? "leaves on the day asked" : `leaves ${Math.abs(shift.out)} day${Math.abs(shift.out) > 1 ? "s" : ""} ${shift.out < 0 ? "earlier" : "later"} than asked`,
          req.returnDate ? (shift.ret === 0 ? "back on the day asked" : `back ${Math.abs(shift.ret)} day${Math.abs(shift.ret) > 1 ? "s" : ""} ${shift.ret < 0 ? "earlier" : "later"} than asked`) : null,
        ]
          .filter(Boolean)
          .join(", ");
  const bags = it.carryOnIncluded == null ? null : it.carryOnIncluded === 0 ? "no carry-on bag included in the fare" : "a carry-on bag included";
  const nights = stayNights(x, ret);
  return {
    id: `c${x.id}`,
    fare: x.rt ? (x.jaw ? "one ticket covering the whole trip, out to one airport and back from another" : "one ticket covering the whole round trip") : ret ? "two one-way tickets" : "one-way ticket",
    price: priceTier(total, sortedPrices),
    against_their_own_search:
      sortedPrices.length && req.departDate && x.shift == null
        ? null
        : null,
    dates,
    stay: nights == null ? null : nights === 0 ? "back the same day" : `${nightsInWords(nights)} away`,
    out: legWords(it),
    back: ret ? legWords(ret.itin) : x.rt && x.retDate ? { day: dayName(x.retDate), departs: "return flight chosen at booking", arrives: "", duration: "", stops: "", airlines: "" } : null,
    airports: airports.length ? airports.join("; ") : null,
    bags,
    notes,
  };
}

/** "twenty-four nights", in words, so the request stays free of digits. */
export function nightsInWords(n: number): string {
  const small = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const words = n < 20 ? small[n] : n < 100 ? `${tens[Math.floor(n / 10)]}${n % 10 ? `-${small[n % 10]}` : ""}` : "many";
  return `${words} night${n === 1 ? "" : "s"}`;
}

/** The traveller's brief as words, with no money in it. Uses the plan's reading when there is one, else the form fields. */
export function briefWords(req: SearchRequest, plan: TripPlan | null = null): Record<string, string> {
  const hassle = ["wants no hassle at all: nonstop and civilised hours", "one short stop is fine", "long layovers and odd hours are fine if they save real money", "anything goes if it is cheaper: separate tickets, overnight connections"][req.hassle] ?? "one short stop is fine";
  const prefer = plan?.dates.prefer === "longest" ? "; the more nights away the better" : plan?.dates.prefer === "shortest" ? "; the fewer nights away the better" : "";
  const out: Record<string, string> = {
    trip: plan ? plan.understood : req.returnDate ? "round trip" : "one way",
    dates: plan
      ? `${plan.dates.out[0] === plan.dates.out[1] ? `leaving ${dayName(plan.dates.out[0])}` : `leaving between ${dayName(plan.dates.out[0])} and ${dayName(plan.dates.out[1])}`}${plan.dates.ret ? plan.dates.ret[0] === plan.dates.ret[1] ? `, back ${dayName(plan.dates.ret[0])}` : `, back between ${dayName(plan.dates.ret[0])} and ${dayName(plan.dates.ret[1])}` : ", one way"}${prefer}${plan.dates.note ? ` (${plan.dates.note})` : ""}`
      : req.departDate
        ? req.datesFlexible
          ? `around ${dayName(req.departDate)}${req.returnDate ? ` to ${dayName(req.returnDate)}` : ""}; the dates can move${req.flexibilityNote ? ` (${req.flexibilityNote})` : ""}`
          : `${dayName(req.departDate)}${req.returnDate ? ` to ${dayName(req.returnDate)}` : ""}, fixed`
        : "no dates given",
    hassle_tolerance: hassle,
    notes: req.notes || "none",
  };
  // Include the traveller's own words, with digits and currency signs removed so no price reaches the picker.
  if (req.brief) {
    const words = [req.brief, ...(req.turns ?? []).map((t) => `${t.q} ${t.a}`)].join(" / ");
    out.in_their_words = withoutMoney(words).slice(0, 900);
  }
  if (plan && plan.destinations.length > 1) out.airports = `${plan.destinations.map((d) => `${d.name} (${d.code})`).join(" or ")} are both fine${plan.mixAirports ? ", and flying out to one and back from the other is fine" : ", but out and back through the same one"}`;
  if (plan?.musts.length) out.musts = plan.musts.join("; ");
  return out;
}
