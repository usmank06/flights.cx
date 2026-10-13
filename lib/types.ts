import type { SetField } from "@/lib/intake/questions";

/** Shared types. SearchRequest is the contract between the intake and the engine; SearchRecord is what a search stores. */

export type CabinClass = "economy" | "premium-economy" | "business" | "first";

export const CABIN_LABEL: Record<CabinClass, string> = {
  economy: "Economy",
  "premium-economy": "Premium economy",
  business: "Business",
  first: "First",
};

/** Who is flying. Fares cover the whole party, so every price in the app is a party total. */
export type Passengers = {
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
};


/** Bags per traveller. */
export type Bags = { carryOn: number; checked: number };

/** One question asked after the first box, and its answer, as the words the planner reads. */
export type IntakeTurn = { key: string; q: string; a: string };

export type SearchRequest = {
  from: string;
  to: string;
  departDate: string | null; // YYYY-MM-DD
  returnDate: string | null; // YYYY-MM-DD, null = one-way
  datesFlexible: boolean;
  flexibilityNote: string; // plain English, e.g. "± 3 days" / "any weekend in October"
  bags: Bags;
  cabin: CabinClass;
  passengers: Passengers;
  /** ISO 4217, e.g. "USD". Used for the search and every price display. */
  currency: string;
  /** BCP-47, e.g. "en-US". The provider gets its language part. */
  locale: string;
  /** 0 = zero hassle … 3 = anything for savings */
  hassle: number;
  notes: string; // "anything else?" free text
  /** The first box: the trip in their own words, which the planner reads with every answer after it. */
  brief?: string;
  /** The questions asked after the first box, and the answers, in order. */
  turns?: IntakeTurn[];
  /** Fields set outright by a control, which the planner can't override. Other fields come from the words or defaults. */
  set?: SetField[];
};

/** Travellers who take a seat (not lap infants), at least 1. */
export const seatedTravellers = (p: Passengers): number =>
  Math.max(1, p.adults + p.children + p.infantsInSeat);

/** "2 adults, 1 child", for headings, prompts and log lines. */
export function describePassengers(p: Passengers): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (p.adults) parts.push(plural(p.adults, "adult", "adults"));
  if (p.children) parts.push(plural(p.children, "child", "children"));
  if (p.infantsInSeat) parts.push(plural(p.infantsInSeat, "infant in a seat", "infants in seats"));
  if (p.infantsOnLap) parts.push(plural(p.infantsOnLap, "lap infant", "lap infants"));
  return parts.join(", ") || "1 adult";
}

/** "a carry-on and a checked bag", or "no bags". Says nothing about what a fare includes. */
export function describeBags(b: Bags): string {
  const bits: string[] = [];
  if (b.carryOn) bits.push(b.carryOn === 1 ? "a carry-on" : `${b.carryOn} carry-ons`);
  if (b.checked) bits.push(b.checked === 1 ? "a checked bag" : `${b.checked} checked bags`);
  if (!bits.length) return "no bags";
  return bits.join(" and ");
}

/** Details of one flight in a leg, beyond the times. */
export type LegExtras = {
  aircraft: string | null;
  legroom: string | null;
  /** 1 average, 2 below average, 3 above average. */
  legroomClass: 1 | 2 | 3 | null;
  wifi: "free" | "paid" | null;
  power: boolean;
  video: boolean;
  overnight: boolean;
  oftenDelayed: boolean;
  /** Whole kilograms for the leg. */
  co2Kg: number | null;
  /** Against typical for the route, in percent; negative is cleaner. */
  co2VsTypical: number | null;
  /** 1 low, 2 medium, 3 high contrail warming potential. */
  contrail: 1 | 2 | 3 | null;
};

export type FlightLeg = {
  direction: "outbound" | "return";
  from: string;
  to: string;
  date: string; // display string
  /** YYYY-MM-DD, for anything that has to compute rather than display. */
  isoDate?: string;
  departTime: string;
  arriveTime: string;
  airline: string;
  flightNumber: string;
  duration: string;
  stops: number;
  stopNote?: string; // e.g. "2h 10m layover in KEF"
  extras?: LegExtras;
};

/**
 * Where a plan can be booked. `precision` says what the link opens: "booking" has every flight selected, "return" has the outbound
 * selected and the return still to choose. "itinerary" and "route" are filtered searches, used when a segment lacks a carrier or
 * flight number.
 */
export type PlanBooking = {
  /** The provider's booking URL. Always well-formed. */
  url: string;
  precision: "booking" | "return" | "itinerary" | "route";
  /** The second ticket's link, when the plan is two separate tickets and `url` books only the first. */
  returnUrl?: string;
  /** The provider's opaque token for this itinerary, when it has one. */
  token?: string | null;
};

/** Jev's scores for a plan: its probabilities as whole-number percentages. Absent when code picked. */
export type PlanScores = {
  /** How likely the plan meets what the traveller said they must have, 0-100. */
  fit: number;
  /** How much hassle, 0 (none) to 100 (brutal), from the four-level scale. */
  hassle: number;
  /** How civilised the hours are, 0-100. */
  hours: number;
  /** How sure Jev was of the slot it put this plan in, 0-100. */
  confidence: number;
};

/** A pick's key from the plan: "cheapest", "value", "hours", or one the planner named ("longest-stay"). */
export type PlanSlot = string;

export type FlightPlan = {
  id: string;
  label: string; // "Cheapest" / "Best value" / "Best hours"
  slot?: PlanSlot;
  /** Total for the whole party, in `currency`. */
  price: number;
  currency: string; // "USD" etc.
  /** price ÷ seated travellers, rounded. Computed in code, not by a model. */
  perTraveller?: number;
  /** How many people this fare covers, so the card can say "for 2". */
  travellers?: number;
  legs: FlightLeg[];
  summary?: string; // one-liner on why this plan
  /** A single round-trip fare, one ticket; the return flight is chosen at booking. */
  roundTripFare?: boolean;
  /** Display date the round-trip fare returns on, known from the query rather than the itinerary. */
  returnDate?: string;
  booking: PlanBooking;
  scores?: PlanScores;
  pickedBy?: "jev" | "code";
  /** Carry-on bags the fare includes, when the provider says. */
  carryOnIncluded?: number | null;
  /** Days the outbound moved from the date asked for; 0 or absent when it did not. */
  dateShift?: { out: number; ret: number };
  /** Whole nights away, code-computed from the dates; absent on a one-way. */
  nights?: number;
  /** On an open-jaw fare whose return is not itemised: the airport the return leaves from. */
  backFrom?: string;
};

type LogEntry = {
  id: string;
  time: string; // display time
  text: string;
  kind: "info" | "action" | "success" | "error";
  verbose?: boolean;
};

/* -------------------------------- Records -------------------------------- */

/** What a running search is doing. */
export type SearchPhase =
  | "starting"
  | "planning"
  | "pricing"
  | "exploring"
  | "widening"
  | "picking"
  | "writing"
  | "done"
  | "error";

/** One append-only entry in a search's event log. Ordered by `seq`. */
export type SearchEvent =
  | { seq: number; at: string; type: "log"; text: string; kind: LogEntry["kind"]; verbose: boolean }
  | { seq: number; at: string; type: "phase"; phase: SearchPhase }
  | { seq: number; at: string; type: "answer"; askId: string }
  | { seq: number; at: string; type: "error"; message: string };

/** A follow-up question and its answer. */
export type FollowUp = {
  id: string;
  question: string;
  askedAt: string;
  status: "queued" | "working" | "answered" | "failed";
  /** The current step, shown while status is "working". */
  progress?: string;
  /** Prose answer, written for the traveller. */
  answer?: string;
  /** New plans, when the follow-up turned some up. Same assembly path as the main result. */
  plans?: FlightPlan[];
  /** Priced destinations, when the follow-up asked where else to go. */
  destinations?: DestinationView[];
  /** One line over the grid or the list, built in code: "Chicago → Madrid · out Mar 5–Mar 14 · back Mar 15–Mar 24". */
  viewTitle?: string;
  /** True when this answer rebuilt the chat's one date grid (the record's `view.grid`). */
  gridUpdated?: boolean;
  answeredAt?: string;
};

/** How the search ended, for the verdict line on the results view. */
export type Verdict = {
  /** Price of the traveller's own literal search, if it could be run. */
  baseline: number | null;
  /** Cheapest plan shown. */
  best: number;
  /** baseline − best. Negative means we did not beat it. */
  saved: number | null;
  /** Set when we could not beat the baseline, explaining why. */
  couldNotBeat?: string;
  /**
   * The grid's cheapest days, when well under every plan because the grid price wasn't a real fare: no flights on them when searched
   * (`found` null), or a higher price. Not set when those days did price near the grid and the picks passed them over.
   * `unconfirmed`: they were asked but never answered in time, so a null `found` doesn't mean there were no flights.
   */
  gridCheaper?: { outDate: string; returnDate: string; price: number; found: number | null; unconfirmed?: true };
  /** Set when lookups never answered in time and the search went on without them. */
  incomplete?: Incomplete;
};

/** Lookups a search left out because they never answered in time. The page notes them under the write-up. */
export type Incomplete = {
  /**
   * Dates not every lookup answered for, cheapest on the grid first. `returnDate` is null on a one-way; `route` names an end
   * when the search had several places there ("to Porto", "from Detroit") or when one airport there didn't answer while the
   * rest did ("from HOU", "into BAH").
   */
  dates: { outDate: string; returnDate: string | null; route?: string }[];
  /** Part of the date grid, or of the one-way prices by date, never came back. */
  grid: boolean;
  /** Other lookups that never answered: a direction on its own, the price insights, a hinted airport, a place. */
  other: number;
};

/* --------------------------------- Views --------------------------------- */

/** How a grid cell's price is flown: one ticket or two, into which airport and back from which. */
export type GridVia = { tickets: "one" | "two"; out: string; back: string };

export type GridCell = {
  outDate: string;
  returnDate: string;
  /** Party total in the search's currency, or null when there's no fare. The cheapest way to fly that pair of days. */
  price: number | null;
  /** Which way that cheapest price is flown; absent when the cell has no price. */
  via?: GridVia;
  /** When the cheapest is two tickets: the cheapest one ticket (a round-trip fare) for the same days, when known. */
  oneTicket?: number;
};

/** The flexible-dates view: an outbound × return matrix over the window the plan allows. */
export type GridView = {
  outDates: string[];
  returnDates: string[];
  cells: GridCell[];
  /** The pair the traveller asked for, so the grid can mark it. */
  requested: { out: string; ret: string };
  /** The destination airports the cells range over, for the legend; absent when there is one. */
  airports?: string[];
  /** True when a cell may fly out to one listed airport and back from another. */
  mixed?: boolean;
  /** The origin and every destination the cells cover, so the grid can be widened or trimmed without the plan. */
  route: { from: string; to: string[] };
  /** True when a cell may be two one-way tickets. */
  separate: boolean;
};

/** One place in the open-destination list, priced on the traveller's dates. */
export type DestinationView = {
  code: string;
  name: string;
  country: string | null;
  lat: number | null;
  lon: number | null;
  price: number | null;
  carrierCode: string | null;
  carrierName: string | null;
  stops: number | null;
  durationMinutes: number | null;
  outDate: string | null;
  returnDate: string | null;
  /** The provider's photo of the place, as a thumbnail URL. */
  image?: string | null;
  /** Other places listed under the same airport at the same price ("Saint Paul" beside Minneapolis). */
  alsoNames?: string[];
  /** Why it fits what the traveller asked for, in the chooser's few words: "warm and dry in November". */
  why?: string;
  /** True when the engine also fetched bookable itineraries for it. */
  priced: boolean;
};

/** How current prices on the traveller's own route compare with the usual range. */
export type InsightsView = {
  level: "typical" | "high" | null;
  levelCode: number | null;
  current: number | null;
  typical: number | null;
  low: number | null;
  high: number | null;
  /** Daily points, oldest first. */
  history: { at: number; price: number }[];
};

export type HintsView = {
  dates: { outDate: string; returnDate: string | null; price: number | null }[];
  airports: { code: string; departure: boolean; price: number | null }[];
};

export type SearchView = {
  kind: "closed" | "flexible" | "open";
  grid?: GridView;
  destinations?: DestinationView[];
  insights?: InsightsView | null;
  hints?: HintsView;
};

/** Run metrics, for the metrics row and the summary. */
export type SearchStats = {
  durationMs: number;
  /** Requests sent to the provider. */
  queries: number;
  /** Itineraries held after dedupe. */
  itineraries: number;
  jev: "used" | "fallback" | "skipped";
  voice: "used" | "fallback" | "skipped";
  /** How long the planner took, its second ask included. */
  plannerMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Lookups that never answered in time, which the search went on without. Absent on older searches. */
  missed?: number;
};

/** How the search read the brief, for the page. Dates are ISO; the page formats them. */
export type PlanView = {
  understood: string;
  origins: { code: string; name: string }[];
  destinations: { code: string; name: string }[];
  openHint: string | null;
  mixAirports: boolean;
  separateTickets: boolean;
  dates: { anchor: { out: string; ret: string | null }; out: [string, string]; ret: [string, string] | null; prefer: "longest" | "shortest" | "none"; note: string | null };
  picks: { key: string; label: string; want: string }[];
};

/** A search: its request, log and outcome. */
export type SearchRecord = {
  slug: string;
  createdAt: string;
  /** sha256 of the starting browser's key, which lets that browser delete it while no account owns it. Never leaves the server. */
  ownerKeyHash?: string | null;
  /** When its owner deleted it. Kept only for metrics: its link returns 404 and no list shows it (lib/store). */
  deletedAt?: string | null;
  /** When the prices were fetched. Shown on every share link. */
  capturedAt: string | null;
  status: "running" | "done" | "error";
  phase: SearchPhase;
  /** Running totals, and when each phase began (ms after `createdAt`), for a page that opens mid-search. */
  tally?: { flights: number; searches: number; began: Partial<Record<SearchPhase, number>> };
  request: SearchRequest;
  /** Set when this search is a re-run of another one. */
  rerunOf?: string;
  /** "demo" when it ran against the demo market, whose prices are invented. The page says so. */
  mode: "live" | "demo";
  events: SearchEvent[];
  plans: FlightPlan[] | null;
  analysis: string | null;
  verdict: Verdict | null;
  /** Null until the search has priced something. */
  view: SearchView | null;
  /** How the brief was read; null until the planner has answered, or when it never did. */
  plan: PlanView | null;
  /** Null until the search has ended. */
  stats: SearchStats | null;
  error: string | null;
  followUps: FollowUp[];
  /** The itineraries the search found, compacted, which most follow-ups answer from without searching again. */
  session: SessionState | null;
  /** The signed-in traveller who started it, when there was one. A slug alone still works. Null on a public copy. */
  userId: string | null;
  /** Request fields the transport couldn't send. In practice only a price cap. */
  unencoded: UnencodedField[];
};

/** A request field the transport could not encode, and what that means for the prices. */
export type UnencodedField = {
  field: "bags" | "seat" | "maxPrice";
  /** One sentence a traveller can read. */
  note: string;
};

/** What a follow-up needs to answer without re-running the search. */
export type SessionState = {
  baseline: number | null;
  /** Compact itinerary rows keyed by the ids the plans reference. */
  rows: unknown[];
  /** One line per stage: what the search did. */
  roundNotes: string[];
  concludedBecause: string;
};

/** A past search as listed on the home page and Your trips. Small, so every one can be loaded at once. */
export type SearchSummary = {
  slug: string;
  createdAt: string;
  capturedAt: string | null;
  status: SearchRecord["status"];
  from: string;
  to: string;
  departDate: string | null;
  returnDate: string | null;
  bestPrice: number | null;
  planCount: number;
  saved: number | null;
  currency: string;
  locale: string;
  /** Shown as "· 2 travellers" when it is not the default one adult. */
  travellers: number;
  cabin: CabinClass;
};
