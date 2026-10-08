import { AIRPORTS } from "@/lib/airports";
import { money } from "@/lib/format";
import type { DestinationView, FlightLeg, FlightPlan, PlanBooking, PlanView } from "@/lib/types";

/**
 * Pure helpers that describe a plan, shared by the card, the details panel and the footnote so they agree.
 * Prices are party totals, and only an exact booking link is labelled "Book".
 */

export const stopsLabel = (stops: number) => (stops === 0 ? "Nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`);

/** True when a stop note ("4h 45m in FRA; 56m in YUL") has a layover of four hours or more. */
export const longLayover = (note: string | undefined) => [...(note ?? "").matchAll(/(\d+)h/g)].some((m) => Number(m[1]) >= 4);

/** ["QR", "AA"] from "QR 732 / AA 8138": every distinct carrier on the leg, in order. */
export const carrierCodes = (leg: FlightLeg): string[] => [...new Set([...leg.flightNumber.matchAll(/(^|\/\s*)([A-Z0-9]{2})\s/g)].map((m) => m[2]))];

export const cityOf = (code: string) => AIRPORTS[code]?.city ?? code;

/** A plan's destination, used as the card title on open-destination searches. */
export type Place = { name: string; country: string | null };

/**
 * An open-destination plan's place: its name from `destinations` ("Puerto Vallarta", Mexico), else the outbound arrival's city.
 * The country is an ISO code or a country name from the provider.
 */
export function placeOf(plan: FlightPlan, destinations: DestinationView[] | null | undefined): Place | null {
  const to = (plan.legs.find((l) => l.direction === "outbound") ?? plan.legs[0])?.to;
  if (!to) return null;
  const known = destinations?.find((d) => d.code === to);
  const name = known?.name ?? AIRPORTS[to]?.city;
  return name ? { name, country: known?.country ?? AIRPORTS[to]?.country ?? null } : null;
}

/** The layovers on a leg: [{ dur: "5h 35m", code: "BCN" }]. */
export const layovers = (leg: FlightLeg): { dur: string; code: string }[] =>
  (leg.stopNote ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.*?)\s+in\s+([A-Z]{3})$/);
      return m ? { dur: m[1], code: m[2] } : { dur: s, code: "" };
    });

/** "20:05+1" → { time: "20:05", plus: "+1" }. "22:45−1" uses a minus sign (U+2212) and means the day before. */
export const splitTime = (t: string) => {
  const m = t.match(/^(.*?)([+−]\d+)?$/);
  return { time: m?.[1] ?? t, plus: m?.[2] ?? "" };
};

/** Tooltip for a day mark: "+1" is a day later, "−1" the day before. */
export const dayMarkTitle = (plus: string) => {
  const n = Number(plus.slice(1));
  return plus.startsWith("−") ? (n === 1 ? "Arrives the day before" : `Arrives ${n} days before`) : `Arrives ${n} day${n === 1 ? "" : "s"} later`;
};

/** Splits a trailing route-swap note ("Note this lands at Lisbon (LIS), not Porto (OPO).") off the summary to show separately. */
export function splitRouteNote(summary: string | null | undefined): { text: string; note: string | null } {
  const s = (summary ?? "").trim();
  const marker = "Note this ";
  const i = s.lastIndexOf(marker);
  if (i < 0) return { text: s, note: null };
  const tail = s.slice(i + marker.length).trim();
  if (!tail) return { text: s, note: null };
  const note = tail.charAt(0).toUpperCase() + tail.slice(1);
  return { text: s.slice(0, i).trim(), note: /[.!?]$/.test(note) ? note : `${note}.` };
}

/** The route-swap note as tags ("Lands at Lisbon, not Porto"). If any clause doesn't parse, returns the note unchanged. */
export function routeTags(note: string | null): string[] {
  if (!note) return [];
  const clauses = note.replace(/\.$/, "").split(/,\s+and\s+(?=lands|departs|leaves)/i);
  const tags: string[] = [];
  for (const clause of clauses) {
    const m = clause.match(/^(lands at|departs from|leaves from)\s+(.+?)\s*\([A-Z]{3}\),\s*not\s+(.+?)\s*\([A-Z]{3}\)$/i);
    if (!m) return [note];
    const verb = /^lands/i.test(m[1]) ? "Lands at" : "Leaves from";
    tags.push(`${verb} ${m[2]}, not ${m[3]}`);
  }
  return tags;
}

/** Tags for shifted dates: "Leaves 2 days earlier", "Back a day later". */
export function shiftTags(plan: FlightPlan): string[] {
  const s = plan.dateShift;
  if (!s) return [];
  const word = (n: number, what: string) => `${what} ${Math.abs(n) === 1 ? "a day" : `${Math.abs(n)} days`} ${n < 0 ? "earlier" : "later"}`;
  return [...(s.out ? [word(s.out, "Leaves")] : []), ...(s.ret ? [word(s.ret, "Back")] : [])];
}

/** Common names for airports in multi-airport cities, so a tag can say "Into Gatwick" instead of "Into London". */
const AIRPORT_NAMES: Record<string, string> = {
  JFK: "JFK",
  LGA: "LaGuardia",
  ORD: "O’Hare",
  MDW: "Midway",
  DFW: "DFW",
  DAL: "Love Field",
  IAH: "IAH",
  HOU: "Hobby",
  DCA: "Reagan National",
  IAD: "Dulles",
  YYZ: "Pearson",
  YTZ: "Billy Bishop",
  LHR: "Heathrow",
  LGW: "Gatwick",
  STN: "Stansted",
  LTN: "Luton",
  LCY: "London City",
  CDG: "Charles de Gaulle",
  ORY: "Orly",
  BVA: "Beauvais",
  FCO: "Fiumicino",
  CIA: "Ciampino",
  MXP: "Malpensa",
  BGY: "Bergamo",
  DXB: "DXB",
  DWC: "Al Maktoum",
  NRT: "Narita",
  HND: "Haneda",
  KIX: "Kansai",
  ITM: "Itami",
  ICN: "Incheon",
  GMP: "Gimpo",
  PVG: "Pudong",
  SHA: "Hongqiao",
  GIG: "Galeão",
  SDU: "Santos Dumont",
};

/** An airport's tag name: its own name in a multi-airport city, else the city. */
export const airportLabel = (code: string) => AIRPORT_NAMES[code] ?? cityOf(code);

/** The airports requested at each end of the trip. Empty for an open end. */
export type Named = { from: string[]; to: string[] };

/**
 * Each end of a plan that uses an airport other than the one requested: `tag` for the card ("Into Gatwick"), `note` for the
 * details ("Lands at Gatwick, not Heathrow"). Compares airports, so Gatwick is flagged when Heathrow is requested.
 */
export function airportSwaps(plan: FlightPlan, named: Named): { tag: string; note: string }[] {
  const out = plan.legs.find((l) => l.direction === "outbound") ?? plan.legs[0];
  const back = plan.legs.find((l) => l.direction === "return");
  const asked = (codes: string[]) => (codes.length === 1 ? airportLabel(codes[0]) : cityOf(codes[0]));
  const ends = [
    { code: out?.from, at: named.from, tag: "From", note: "Leaves from" },
    { code: out?.to, at: named.to, tag: "Into", note: "Lands at" },
    // Return ends only when they differ from the outbound's, which are already covered.
    { code: back ? (back.from !== out?.to ? back.from : undefined) : plan.backFrom, at: named.to, tag: "Back from", note: "Comes back from" },
    { code: back && back.to !== out?.from ? back.to : undefined, at: named.from, tag: "Back to", note: "Comes back to" },
  ];
  const seen = new Set<string>();
  const swaps: { tag: string; note: string }[] = [];
  for (const e of ends) {
    if (!e.code || !e.at.length || e.at.includes(e.code) || seen.has(e.tag + e.code)) continue;
    seen.add(e.tag + e.code);
    swaps.push({ tag: `${e.tag} ${airportLabel(e.code)}`, note: `${e.note} ${airportLabel(e.code)}, not ${asked(e.at)}` });
  }
  return swaps;
}

/**
 * A card's cautions, most serious first: a different airport, then a long layover, then two tickets.
 * Without `named` (a card shown on its own), the airport cautions come from the summary's route note.
 */
export function cautions(plan: FlightPlan, named?: Named | null): string[] {
  const route = named
    ? airportSwaps(plan, named).map((s) => s.tag)
    : routeTags(splitRouteNote(plan.summary).note).map((t) => t.replace(/, not .*$/, "").replace("Leaves from", "From").replace("Lands at", "Into"));
  const hours = (dur: string) => Number(dur.match(/(\d+)h/)?.[1] ?? 0);
  const longest = plan.legs.flatMap(layovers).sort((a, b) => hours(b.dur) - hours(a.dur))[0];
  return [...route, ...(longest && hours(longest.dur) >= 4 ? [`${hours(longest.dur)}h layover`] : []), ...(plan.booking.returnUrl ? ["2 tickets"] : [])];
}

/**
 * The heading's trip ends: the requested airports, then other airports the plans use, alternating ends, up to four codes in all
 * (what fits on one line on a laptop). An open end stays empty.
 */
export function endsFlown(view: PlanView, plans: FlightPlan[]): PlanView {
  const legs = plans.flatMap((p) => p.legs);
  const extra = (named: PlanView["origins"], used: (string | undefined)[]) =>
    named.length ? [...new Set(used.filter((c): c is string => Boolean(c) && !named.some((n) => n.code === c)))] : [];
  const more = {
    from: extra(view.origins, legs.map((l) => (l.direction === "return" ? l.to : l.from))),
    to: extra(view.destinations, [...legs.map((l) => (l.direction === "return" ? l.from : l.to)), ...plans.map((p) => p.backFrom)]),
  };
  if (!more.from.length && !more.to.length) return view;
  const ends = { from: [...view.origins], to: [...view.destinations] };
  for (let i = 0; ends.from.length + ends.to.length < 4 && (i < more.from.length || i < more.to.length); i++)
    for (const side of ["from", "to"] as const) if (i < more[side].length && ends.from.length + ends.to.length < 4) ends[side].push({ code: more[side][i], name: cityOf(more[side][i]) });
  return { ...view, origins: ends.from, destinations: ends.to };
}

export const isPaired = (plan: FlightPlan) => Boolean(plan.booking.returnUrl);
export const isExact = (plan: FlightPlan) => plan.booking.precision !== "route";
export const bookLabel = (plan: FlightPlan) => (isExact(plan) ? "Book" : "See flights");
/** A round-trip fare with no return leg: the flight home is chosen on the booking page. */
export const returnToPick = (plan: FlightPlan) => Boolean(plan.roundTripFare) && !plan.legs.some((l) => l.direction === "return");

/** Per-traveller price ("€120 each") for a party of two or more. The amount is computed in code rather than by a model. */
export function perTravellerNote(plan: FlightPlan, locale: string): string | null {
  return plan.travellers && plan.travellers > 1 && plan.perTraveller ? `${money(plan.perTraveller, plan.currency, locale)} each` : null;
}

/** True when the plans have identical flights and differ only in price (the footnote flags this). */
export function plansDifferOnlyInPrice(plans: FlightPlan[]): boolean {
  const key = (p: FlightPlan) =>
    p.legs.map((l) => [l.date, l.departTime, l.arriveTime, l.from, l.to, l.flightNumber].join("|")).join("~") + (p.roundTripFare ? `~rt:${p.returnDate ?? ""}` : "");
  return plans.length > 1 && new Set(plans.map(key)).size === 1;
}

/** Records a Book click. Fire-and-forget and wrapped in try/catch, so it can't block or break the click. */
export function recordBookClick(slug: string, planId: string, precision: PlanBooking["precision"]): void {
  const body = JSON.stringify({ slug, planId, precision });
  try {
    if (navigator.sendBeacon?.("/api/book", new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* no beacon; fall back to fetch */
  }
  try {
    void fetch("/api/book", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  } catch {
    /* best effort */
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * ISO return day for a round-trip fare without a return leg. `returnDate` is display text ("Nov 23"), so the year is the
 * outbound's, or the next one if that month comes before the outbound's.
 */
export function returnIso(plan: FlightPlan): string | null {
  const out = plan.legs[0]?.isoDate;
  const m = (plan.returnDate ?? "").match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
  if (!out || !m) return null;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return null;
  const year = Number(out.slice(0, 4)) + (mi + 1 < Number(out.slice(5, 7)) ? 1 : 0);
  return `${year}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
