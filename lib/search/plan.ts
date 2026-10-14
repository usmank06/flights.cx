import { z } from "zod";
import { AIRPORTS, nearbyAirports } from "@/lib/airports";
import { DAY_FORMAT, shortDate } from "@/lib/format";
import type { Bags, CabinClass, Passengers, SearchRequest } from "@/lib/types";
import { CABIN_LABEL, describeBags, describePassengers } from "@/lib/types";
import { callModelStructured, shiftDay, daysBetween, type ModelUsage } from "./core";
import { FAR_SAID, isOpenDestination, placeLabel, resolveAirport, SALE_HORIZON_DAYS, setFields, unknownAirport } from "./intake";
import type { ModelOption, ReasoningEffort } from "./models";
import { PLAN_SYSTEM } from "./prompts";

/**
 * The trip planner. One structured model call reads the brief, the answers and the form fields, and returns the airports, date
 * windows and picks. Code runs every query from the plan.
 *
 * The model never sees prices or currency, and a reply with any number besides dates and head counts is rejected. A plan that
 * can't be searched as written is rejected and the planner asked again. A second failure ends the search.
 */

export type Place = { code: string; name: string };
export type PickRank = "price" | "stay" | "hours" | "quickest" | "balance";
export type PickSpec = { key: string; label: string; want: string; rank: PickRank };
export type DatePreference = "longest" | "shortest" | "none";

export type TripPlan = {
  origins: Place[];
  /** Empty for an open destination, which `openHint` describes in the traveller's words. */
  destinations: Place[];
  openHint: string | null;
  /** Out to one listed destination airport and back from another is acceptable. */
  mixAirports: boolean;
  /** Two one-way tickets are acceptable. */
  separateTickets: boolean;
  dates: {
    /** The dates priced "as asked", the baseline that savings are measured against. */
    anchor: { out: string; ret: string | null };
    out: [string, string];
    ret: [string, string] | null;
    prefer: DatePreference;
    note: string | null;
    /** True when a window was cut to MAX_WINDOW_DAYS. */
    trimmed: boolean;
    /** True when dates set in the form had passed and the planner moved them forward. */
    moved?: boolean;
  };
  picks: PickSpec[];
  musts: string[];
  /**
   * A one-line summary built from the fields above. Given to the picker and the write-up, and the starting text for an Edit
   * in another browser.
   */
  understood: string;
  /** Party, cabin, bags and hassle as read from the traveller's words. Fields set in the form are left out. */
  reading: PlanReading;
};

/** Fields the planner read from the traveller's words. Each is absent when the words don't mention it. */
export type PlanReading = { party?: Passengers; cabin?: CabinClass; bags?: Bags; hassle?: number };

/** Prompt wording for each hassle level, indexed by the request's `hassle` (0-3). */
export const HASSLE_WORDS = [
  "wants no hassle at all: nonstop and civilised hours",
  "one short stop is fine",
  "long layovers and odd hours are fine if they save real money",
  "anything goes if it is cheaper: separate tickets, overnight connections",
];

/** Widest date window per leg, in days. Ten outbound by ten return days is 100 date pairs per destination. */
export const MAX_WINDOW_DAYS = 10;
const MAX_PLACES = 3;


/* ------------------------------- The schema ------------------------------- */

const PlaceSchema = z.object({
  code: z.string().describe("IATA airport code: three capital letters, one airport — the main airport of the place, never a city or metro code like LON or NYC"),
  name: z.string().describe("The city, as the traveller would say it, in Title Case: 'Lisbon', 'New York', 'Chicago' — never an airport's name"),
});

/** The picks a search can make. The model chooses which apply and in what order; labels, ranking and purpose stay in code. */
export const PICK_MENU: Record<string, PickSpec> = {
  cheapest: { key: "cheapest", label: "Cheapest", want: "The lowest price that meets what the traveller said they must have.", rank: "price" },
  "best-value": { key: "value", label: "Best value", want: "The best trade of price against hours, stops and hassle — what a sensible friend would book.", rank: "balance" },
  "best-hours": { key: "hours", label: "Best hours", want: "The most civilised departure and arrival times and the fewest stops, at a price that is still reasonable.", rank: "hours" },
  "longest-stay": { key: "longest-stay", label: "Longest stay", want: "The most nights away inside the window. Nights matter more than price here, unless the price is far above the cheapest.", rank: "stay" },
  "shortest-stay": { key: "shortest-stay", label: "Shortest stay", want: "The fewest nights away inside the window, at a price close to the cheapest.", rank: "balance" },
  quickest: { key: "quickest", label: "Quickest", want: "The least time travelling — nonstop or the shortest connections — at a price close to the cheapest.", rank: "quickest" },
};
const PickKey = z.enum(["cheapest", "best-value", "best-hours", "longest-stay", "shortest-stay", "quickest"]);
export const CLASSIC_PICKS: PickSpec[] = [PICK_MENU.cheapest, PICK_MENU["best-value"], PICK_MENU["best-hours"]];

const PlanSchema = z.object({
  origins: z.array(PlaceSchema).describe("Where the trip starts. One airport unless the traveller named several places."),
  destinations: z
    .array(PlaceSchema)
    .describe("Where the trip goes. Several when the traveller said 'or' or listed places. Every city they name is here, even when they also name its country or region. EMPTY only when no city is named: 'anywhere', a country or region alone, 'somewhere warm'."),
  openHint: z.string().nullable().describe("Only when destinations is empty: the traveller's own words for what they want ('somewhere warm', 'Europe'). Otherwise null."),
  mixAirports: z.boolean().describe("True when the traveller would fly out to one listed destination airport and back from another."),
  separateTickets: z.boolean().describe("True when two one-way tickets are acceptable to them (they said so, or they will take any hassle for a cheaper fare)."),
  dates: z.object({
    anchorOut: z.string().describe("YYYY-MM-DD. The one outbound date to price exactly as asked: the date they typed, or the best single date when they only described a window."),
    anchorReturn: z.string().nullable().describe("YYYY-MM-DD, or null for a one-way trip."),
    outFrom: z.string().describe("YYYY-MM-DD. The earliest outbound date they would accept."),
    outTo: z.string().describe("YYYY-MM-DD. The latest outbound date they would accept — several days after outFrom unless the date is fixed, so the search can show what leaving later costs."),
    returnFrom: z.string().nullable().describe("YYYY-MM-DD. The earliest return date they would accept — several days before returnTo unless fixed, so the search can show what coming back earlier costs. Null for one-way."),
    returnTo: z.string().nullable().describe("YYYY-MM-DD. The latest return date they would accept, or null for one-way. \"Back before the 20th\" is the 19th."),
    prefer: z.enum(["longest", "shortest", "none"]).describe("Inside the window: longest = as much time away as possible; shortest = as little; none = no preference stated."),
    note: z.string().nullable().describe("A caveat about the edges, under twelve words, in their words: 'Mar 12 only in the evening'. Null when there is none."),
  }),
  picks: z.array(PickKey).describe("Two or three picks, in the order to show them, each a different thing they would want to see. Default: cheapest, best-value, best-hours. When they want to maximise time away: cheapest, longest-stay. When they want the least time away: cheapest, shortest-stay. When hours matter more than money: best-hours first."),
  musts: z.array(z.string()).describe("Only constraints they stated that no other field says: 'no overnight layovers', 'must arrive the day before the party'. Never the route, the airports, the window, the stops, the cabin, the bags or who is going — those have their own fields. Usually empty. No numbers."),
  party: z
    .object({ adults: z.number().int(), children: z.number().int(), infantsInSeat: z.number().int(), infantsOnLap: z.number().int() })
    .nullable()
    .describe("Who is flying, only when they said: 'two of us' is 2 adults; 'me, my wife and our two kids' is 2 adults and 2 children (aged 2–11); a baby is an infant on a lap. Null when they did not say."),
  cabin: z.enum(["economy", "premium-economy", "business", "first"]).nullable().describe("Only when they named a cabin or class. Null otherwise."),
  bags: z
    .object({ carryOn: z.number().int(), checked: z.number().int() })
    .nullable()
    .describe("Bags per traveller, only when they said what they are bringing: 'a checked bag' is carryOn 1, checked 1; 'just a backpack' is 0 and 0. Null when unsaid."),
  hassle: z
    .enum(["nonstop", "one-stop", "long-layovers-ok", "anything"])
    .nullable()
    .describe("How they feel about stops and awkward hours, only when they said: 'nonstop only' is nonstop; 'one stop is fine' is one-stop; 'don't mind long layovers' is long-layovers-ok; 'whatever is cheapest, any hassle' is anything. Null when unsaid."),
});
type PlanReply = z.infer<typeof PlanSchema>;


/**
 * The planner's input: the first box, the questions answered after it, and any fields set in the form. A request with no brief
 * is described by its form fields alone.
 */
export function briefFor(req: SearchRequest, today: string): string {
  const set = setFields(req);
  const lines = [`Today is ${today}.`];
  const dates = req.departDate
    ? `Leaving ${req.departDate}, ${req.returnDate ? `coming back ${req.returnDate}` : "one way"}; the dates ${req.datesFlexible ? `can move${req.flexibilityNote ? ` — "${req.flexibilityNote}"` : ""}` : "are fixed"}`
    : "No dates chosen";
  if (req.brief) {
    lines.push(`What they wrote first: "${req.brief}"`);
    if (req.turns?.length) {
      lines.push("Then, asked and answered:");
      for (const t of req.turns) lines.push(`- ${t.q} — "${t.a}"`);
    }
    const given: string[] = [];
    if (set.has("from") && req.from) given.push(`Flying from: ${req.from}`);
    if (set.has("to") && req.to) given.push(`Flying to: ${req.to}`);
    if (set.has("dates")) given.push(dates);
    if (set.has("party")) given.push(`Travellers: ${describePassengers(req.passengers)}`);
    if (set.has("cabin")) given.push(`Cabin: ${CABIN_LABEL[req.cabin]}`);
    if (set.has("bags")) given.push(`Bags each: ${describeBags(req.bags)}`);
    if (set.has("hassle")) given.push(`How much hassle a cheaper fare is worth: ${HASSLE_WORDS[req.hassle] ?? HASSLE_WORDS[1]}`);
    if (given.length) {
      lines.push("Set with the form's own controls — take these as given:");
      for (const g of given) lines.push(`- ${g}`);
    }
    return lines.join("\n");
  }
  lines.push(
    `Flying from: ${req.from}`,
    `Flying to: ${req.to}`,
    `Leaving: ${req.departDate ?? "no date given"}`,
    `Coming back: ${req.returnDate ?? (req.departDate ? "one way" : "no date given")}`,
    `Dates can move: ${req.datesFlexible ? "yes" : "no"}${req.flexibilityNote ? ` — "${req.flexibilityNote}"` : ""}`,
    `How much hassle a cheaper fare is worth: ${HASSLE_WORDS[req.hassle] ?? HASSLE_WORDS[1]}`,
    `Notes: ${req.notes?.trim() ? `"${req.notes.trim()}"` : "none"}`
  );
  return lines.join("\n");
}

/* ------------------------------- The planner ------------------------------ */

/** `plan` is null on failure. `failure` is the reason for the log; `said`, when present, is the message for the traveller. */
export type PlanOutcome = { plan: TripPlan | null; usage: ModelUsage | null; ms: number; failure?: string; said?: string };

/**
 * Plans a search with one structured model call, validated strictly. A failed reply returns no plan and the engine retries once.
 * `today` is passed in so the model doesn't guess the year of a date like "Mar 12".
 */
export async function planTrip(
  req: SearchRequest,
  model: ModelOption | null,
  opts: { signal?: AbortSignal; timeoutMs?: number; today?: string; effort?: ReasoningEffort; again?: boolean; places?: Parameters<typeof unknownAirport>[1] } = {}
): Promise<PlanOutcome> {
  const t0 = Date.now();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const failed = (failure: string, usage: ModelUsage | null = null, said?: string): PlanOutcome => ({ plan: null, usage, ms: Date.now() - t0, failure, ...(said ? { said } : {}) });
  if (!model) return failed("no planner model");
  // Reject an unknown airport code before calling the model.
  const unknown = opts.places ? await unknownAirport(req, opts.places) : null;
  if (unknown) return failed(`no airport answers to ${unknown}`, null, SAID.unknown(unknown));

  const user = briefFor(req, today);

  // Temperature 0 so the same request gives the same plan. A retry after a failed plan uses the default, to get a different answer.
  const temperature = opts.again ? undefined : 0;
  const r = await hedged((budget) => callModelStructured(model, PlanSchema, "trip_plan", PLAN_SYSTEM, user, { effort: opts.effort ?? model.plannerEffort ?? "low", timeoutMs: budget, maxTokens: 900, signal: opts.signal, temperature }), opts.timeoutMs ?? 8_000);
  if (!r.parsed) return failed(r.failure ?? "the planner answered nothing", r.usage);
  const bad = moneyOrNumbers(r.parsed);
  if (bad) return failed(`the planner wrote a number it had no business writing: "${bad}"`, r.usage);
  try {
    const plan = validatePlan(r.parsed, req, today);
    return { plan, usage: r.usage, ms: Date.now() - t0 };
  } catch (e) {
    return failed(`the plan did not hold up: ${(e as Error).message}`, r.usage, e instanceof UnusablePlan ? e.said : undefined);
  }
}

/**
 * Hedges a slow model call: if it hasn't answered after MODEL_HEDGE_MS, an identical second call starts, and the first parsed
 * answer wins. Both end at the original deadline. The duplicate is still billed, so the delay sits above a typical 2-5 s call.
 */
export const MODEL_HEDGE_MS = 4_000;
export async function hedged<T extends { parsed: unknown }>(call: (budgetMs: number) => Promise<T>, timeoutMs: number): Promise<T> {
  const budget = Math.floor(timeoutMs);
  const hedgeMs = Math.min(MODEL_HEDGE_MS, Math.floor(budget / 2));
  const first = call(budget);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([first, new Promise<null>((res) => (timer = setTimeout(() => res(null), hedgeMs)))]);
  clearTimeout(timer);
  if (early) return early;
  const good = (x: T) => (x.parsed ? x : Promise.reject(x));
  return Promise.any([first, call(budget - hedgeMs)].map((x) => x.then(good))).catch(async () => first);
}

/**
 * Whether an open-destination hint describes a kind of place ("somewhere warm", "a beach", "Europe"). Hints that only say
 * "anywhere" ("anywhere cheap", "anywhere international") are answered by the provider's price order alone.
 */
export function describesAPlace(hint: string | null | undefined): boolean {
  const words = (hint ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(any|anywhere|somewhere|wherever|else|international|abroad|overseas|foreign|destination|destinations|place|places|city|cities|cheap|cheapest|cheaper|the|a|an|in|to|for|of|on|or|and|that|is|with|go|trip|weekend|getaway|surprise|me|idea|not|sure|no|open|from|really|just|would|like|prefer)$/.test(w));
  return words.length > 0;
}

/**
 * Finds money or stray numbers in the plan reply: a currency sign, three or more digits outside a date, or any digit outside
 * dates, the note, the musts and the counts. Returns the match, for the log.
 */
export function moneyOrNumbers(reply: PlanReply): string | null {
  const whole = JSON.stringify(reply).replace(/\d{4}-\d{2}-\d{2}/g, "");
  const money = whole.match(/[$€£¥]|\d{3,}/)?.[0];
  if (money) return money;
  const strict = JSON.stringify({ ...reply, dates: { ...reply.dates, note: "" }, musts: [], party: null, bags: null }).replace(/\d{4}-\d{2}-\d{2}/g, "");
  return strict.match(/\d+/)?.[0] ?? null;
}

const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const clampDay = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d);

/** A plan that can't be searched as written. `said` is the traveller-facing message, shown if the retry fails too. */
export class UnusablePlan extends Error {
  constructor(
    message: string,
    readonly said: string
  ) {
    super(message);
    this.name = "UnusablePlan";
  }
}
/** Metropolitan-area codes, which the provider refuses as a leg endpoint. */
const METRO_CODES = new Set(["LON", "NYC", "PAR", "TYO", "CHI", "WAS", "MIL", "ROM", "STO", "OSA", "SAO", "RIO", "BUE", "MOW", "BJS", "SEL", "YTO", "YMQ", "JKT", "QDF", "QHO", "QLA", "QSF", "DTT"]);
const SAID = {
  place: "We couldn't work out which airports you mean. Name the cities or airports and search again.",
  origin: "We couldn't tell where you're flying from. Add a city or airport, like “from Chicago”, and search again.",
  destination: "We couldn't tell where you want to go. Name a place, or the kind of place, like “somewhere warm”, and search again.",
  dates: "We couldn't work out your dates. Say when you want to leave and come back, and search again.",
  past: "Those dates have already passed. Pick dates from today on and search again.",
  far: FAR_SAID,
  unknown: (code: string) => `We couldn’t find an airport called ${code}. Check the code, or type the city, and search again.`,
};
const cleanName = (s: string) => s.replace(/[^\p{L}\p{M}\s'’.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 32);
/** The date caveat's first clause, at most twelve words. Null when it reads like reasoning or mentions a place. */
function shortNote(note: string | null | undefined, places: string[] = []): string | null {
  const first = (note ?? "").trim().split(/[;.—]/)[0].trim();
  if (!first || first.split(/\s+/).length > 12 || /\b(they|we|the traveller|search|window|airport|mix|either)\b/i.test(first)) return null;
  if (places.some((n) => n && first.toLowerCase().includes(n.toLowerCase()))) return null;
  return first;
}

/**
 * Checks what the schema can't: real airport codes, and real, ordered, bookable dates. Throws UnusablePlan on failure. Windows
 * are trimmed to MAX_WINDOW_DAYS, and fields set in the form override the model's reading.
 */
export function validatePlan(p: PlanReply, req: SearchRequest, today: string): TripPlan {
  const place = (x: { code: string; name: string }, what: string): Place => {
    const code = x.code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || METRO_CODES.has(code)) throw new UnusablePlan(`${what} "${x.code}" is not an airport code`, SAID.place);
    // Name a known airport after its city; the model sometimes writes the airport's full name.
    return { code, name: AIRPORTS[code]?.city || cleanName(x.name) || code };
  };
  // One airport per metro area: the search covers nearby airports anyway, and listing ORD and MDW would double the calls.
  const dedupe = (xs: Place[]) => {
    const out: Place[] = [];
    for (const x of new Map(xs.map((x) => [x.code, x])).values()) {
      if (out.some((o) => o.code === x.code || nearbyAirports(o.code, 120).some((a) => a.code === x.code))) continue;
      out.push(x);
    }
    return out.slice(0, MAX_PLACES);
  };
  const set = setFields(req);
  let destinations = dedupe(p.destinations.map((x) => place(x, "a destination")));
  // Destinations set in the form are always kept; the model can only add to them.
  if (set.has("to") && req.to && !isOpenDestination(req.to)) {
    const typed = placesIn(req.to);
    for (const t of typed) if (!destinations.some((d) => d.code === t.code)) destinations.push(t);
    destinations = dedupe(destinations);
  }
  let origins = dedupe(p.origins.map((x) => place(x, "an origin")));
  // An origin set in the form replaces the model's.
  if (set.has("from") && req.from) {
    const typed = placesIn(req.from);
    if (typed.length) origins = dedupe([...typed, ...origins.filter((o) => typed.some((t) => t.code === o.code))]);
  }
  if (!origins.length) throw new UnusablePlan("no origin", SAID.origin);
  const destCodes = new Set(destinations.map((x) => x.code));
  if (origins.some((o) => destCodes.has(o.code))) throw new UnusablePlan("an origin is also a destination", SAID.place);
  const openHint = destinations.length ? null : (p.openHint?.trim() || (set.has("to") ? req.to.trim() : "")).slice(0, 80);
  if (!destinations.length && !openHint) throw new UnusablePlan("no destination and no words for an open one", SAID.destination);

  const horizon = shiftDay(today, SALE_HORIZON_DAYS);
  const day = (v: unknown, what: string): string => {
    if (!isIso(v)) throw new UnusablePlan(`${what} is not a date`, SAID.dates);
    if (v < today) throw new UnusablePlan(`${what} ${v} is in the past`, SAID.past);
    if (v > horizon) throw new UnusablePlan(`${what} ${v} is further ahead than flights are sold`, SAID.far);
    return v;
  };
  const d = p.dates;
  const oneWay = d.anchorReturn == null || d.returnFrom == null || d.returnTo == null;
  let outFrom = day(d.outFrom, "outFrom");
  let outTo = day(d.outTo, "outTo");
  if (outTo < outFrom) throw new UnusablePlan("the outbound window runs backwards", SAID.dates);
  let anchorOut = day(d.anchorOut, "anchorOut");
  if (anchorOut < outFrom || anchorOut > outTo) throw new UnusablePlan("the outbound anchor is outside its window", SAID.dates);
  let ret: [string, string] | null = null;
  let anchorRet: string | null = null;
  if (!oneWay) {
    const rf = day(d.returnFrom, "returnFrom");
    const rt = day(d.returnTo, "returnTo");
    if (rt < rf) throw new UnusablePlan("the return window runs backwards", SAID.dates);
    if (rt < outFrom) throw new UnusablePlan("the return window ends before the trip starts", SAID.dates);
    anchorRet = day(d.anchorReturn, "anchorReturn");
    if (anchorRet < rf || anchorRet > rt) throw new UnusablePlan("the return anchor is outside its window", SAID.dates);
    if (anchorRet < anchorOut) throw new UnusablePlan("the anchor comes back before it leaves", SAID.dates);
    ret = [rf, rt];
  }
  // Cap each window at MAX_WINDOW_DAYS, centred on the anchor where possible.
  let trimmed = false;
  const trim = (lo: string, hi: string, anchor: string): [string, string] => {
    if (daysBetween(lo, hi) < MAX_WINDOW_DAYS) return [lo, hi];
    trimmed = true;
    const half = Math.floor((MAX_WINDOW_DAYS - 1) / 2);
    let a = shiftDay(anchor, -half);
    let b = shiftDay(a, MAX_WINDOW_DAYS - 1);
    if (a < lo) { a = lo; b = shiftDay(lo, MAX_WINDOW_DAYS - 1); }
    if (b > hi) { b = hi; a = shiftDay(hi, -(MAX_WINDOW_DAYS - 1)); }
    return [a, b];
  };
  [outFrom, outTo] = trim(outFrom, outTo, anchorOut);
  anchorOut = clampDay(anchorOut, outFrom, outTo);
  if (ret && anchorRet) {
    ret = trim(ret[0], ret[1], anchorRet);
    anchorRet = clampDay(anchorRet, ret[0], ret[1]);
  }

  const seen = new Set<string>();
  const picks: PickSpec[] = [];
  const fixed = outFrom === outTo && (!ret || ret[0] === ret[1]);
  for (const k of p.picks.slice(0, 3)) {
    const spec = PICK_MENU[k];
    if (!spec || seen.has(spec.key)) continue;
    // Stay picks need a return and movable dates; otherwise every stay is the same length.
    if ((spec.rank === "stay" || spec.key === "shortest-stay") && (!ret || fixed)) continue;
    seen.add(spec.key);
    picks.push(spec);
  }
  // A stay-length preference means nothing when the dates are fixed.
  const prefer = fixed ? "none" : d.prefer;
  if (picks.length === 1) picks.push(picks[0].key === "cheapest" ? (prefer === "longest" && ret ? PICK_MENU["longest-stay"] : PICK_MENU["best-value"]) : PICK_MENU.cheapest);
  const finalPicks = picks.length ? picks : prefer === "longest" && ret ? [PICK_MENU.cheapest, PICK_MENU["longest-stay"]] : CLASSIC_PICKS;
  // Drop musts that restate the route, the airports or the dates.
  const named = [...origins, ...destinations].flatMap((x) => [x.code.toLowerCase(), x.name.toLowerCase()]);
  const musts = p.musts
    .map((m) => m.trim().slice(0, 120))
    .filter((m) => m && !named.some((n) => m.toLowerCase().includes(n)) && !/\b(allowed|either|open-jaw|open jaw|window|depart|return on|back before|maximi[sz]e)\b/i.test(m))
    .slice(0, 6);

  const moved = set.has("dates") && req.departDate != null && req.departDate < today && anchorOut !== req.departDate;
  const reading = readingOf(p, set);
  const hassle = set.has("hassle") ? req.hassle : (reading.hassle ?? req.hassle);
  const plan: TripPlan = {
    origins,
    destinations,
    openHint,
    mixAirports: destinations.length > 1 && p.mixAirports,
    separateTickets: p.separateTickets || hassle >= 3,
    dates: { anchor: { out: anchorOut, ret: anchorRet }, out: [outFrom, outTo], ret, prefer, note: shortNote(p.dates.note, [...origins, ...destinations].flatMap((x) => [x.code, x.name])), trimmed, ...(moved ? { moved } : {}) },
    picks: finalPicks,
    musts,
    understood: "",
    reading,
  };
  plan.understood = understoodLine(plan, req.locale);
  return plan;
}

const HASSLE_OF = { nonstop: 0, "one-stop": 1, "long-layovers-ok": 2, anything: 3 } as const;
const count = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);

/** Party, cabin, bags and hassle from the reply, clamped to bookable limits. Skips fields set in the form. */
function readingOf(p: PlanReply, set: Set<string>): PlanReading {
  const out: PlanReading = {};
  if (!set.has("party") && p.party) {
    const adults = count(p.party.adults, 1, 9);
    const children = count(p.party.children, 0, 8);
    const infantsInSeat = count(p.party.infantsInSeat, 0, 8);
    const infantsOnLap = Math.min(adults, count(p.party.infantsOnLap, 0, 8));
    if (adults + children + infantsInSeat <= 9) out.party = { adults, children, infantsInSeat, infantsOnLap };
  }
  if (!set.has("cabin") && p.cabin) out.cabin = p.cabin;
  if (!set.has("bags") && p.bags) out.bags = { carryOn: count(p.bags.carryOn, 0, 4), checked: count(p.bags.checked, 0, 6) };
  if (!set.has("hassle") && p.hassle && p.hassle in HASSLE_OF) out.hassle = HASSLE_OF[p.hassle];
  return out;
}

/** Every place a field names, in order ("Lisbon or Porto" → LIS, OPO). Parts that don't resolve are dropped. */
export function placesIn(text: string): Place[] {
  const out: Place[] = [];
  for (const part of (text ?? "").split(/\s*(?:\bor\b|\band\b|,|\/|\|)\s*/i)) {
    const code = part.trim() ? resolveAirport(part) : undefined;
    if (code && !out.some((x) => x.code === code)) out.push({ code, name: AIRPORTS[code]?.city ?? placeLabel(part) });
  }
  return out;
}

/**
 * An error whose message is shown to the traveller as is; other errors get a generic message. `theirs` marks failures the request
 * itself caused (dates already passed, an unsearchable trip), which aren't reported as errors.
 */
/** The message for a search stopped by a problem on our side. Every such failure is reported (run.ts), so "logged" is true. */
export const ISSUE_MESSAGE = "Something on our side stopped this search before it finished. It’s been logged — try again in a little while.";

export class TravellerError extends Error {
  constructor(
    message: string,
    readonly theirs = false
  ) {
    super(message);
  }
}

/* --------------------------- The request, as read -------------------------- */

/**
 * The request as the search ran it: form-set fields as set, the rest as the plan read them or their defaults. The record keeps
 * this, so every view describes the trip searched. The brief, turns and `set` stay so the search can be rerun and edited.
 */
export function requestFromPlan(req: SearchRequest, plan: TripPlan): SearchRequest {
  const set = setFields(req);
  const r = plan.reading;
  const flexible = plan.dates.out[0] !== plan.dates.out[1] || (plan.dates.ret != null && plan.dates.ret[0] !== plan.dates.ret[1]);
  const names = (xs: Place[]) => [...new Set(xs.map((x) => x.name))].join(" or ");
  return {
    ...req,
    from: set.has("from") && req.from ? req.from : names(plan.origins) || req.from,
    to: set.has("to") && req.to ? req.to : plan.destinations.length ? names(plan.destinations) : (plan.openHint ?? (req.to || "Anywhere")),
    departDate: plan.dates.anchor.out,
    returnDate: plan.dates.anchor.ret,
    datesFlexible: set.has("dates") ? req.datesFlexible : flexible,
    passengers: set.has("party") ? req.passengers : (r.party ?? req.passengers),
    cabin: set.has("cabin") ? req.cabin : (r.cabin ?? req.cabin),
    bags: set.has("bags") ? req.bags : (r.bags ?? req.bags),
    hassle: set.has("hassle") ? req.hassle : (r.hassle ?? req.hassle),
  };
}

/* ------------------------------- The line --------------------------------- */

/** "Jan 1, 2027": a day with its year, in the traveller's locale. */
function yearDate(d: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...DAY_FORMAT, month: "short", day: "numeric", year: "numeric" }).format(new Date(`${d}T12:00:00Z`));
  } catch {
    return d;
  }
}

const list = (names: string[]) => {
  const xs = [...new Set(names)];
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
};

/** The plan as one line, e.g. "Chicago to Lisbon or Porto · out Mar 12–16 · back Mar 23–26 · the longer the better". */
export function understoodLine(plan: TripPlan, locale = "en-US"): string {
  // Show the year when the planner moved past dates forward.
  const day = (d: string) => (plan.dates.moved ? yearDate(d, locale) : shortDate(d, locale));
  const span = (w: [string, string]) => (w[0] === w[1] ? day(w[0]) : `${day(w[0])}–${day(w[1])}`);
  const said = (note: string) => note.replace(/\d{4}-\d{2}-\d{2}/g, (d) => (isIso(d) ? shortDate(d, locale) : d));
  const bits: string[] = [];
  bits.push(`${list(plan.origins.map((p) => p.name))} to ${plan.destinations.length ? list(plan.destinations.map((p) => p.name)) : plan.openHint || "anywhere"}`);
  const fixed = plan.dates.out[0] === plan.dates.out[1] && (!plan.dates.ret || plan.dates.ret[0] === plan.dates.ret[1]);
  if (fixed) bits.push(plan.dates.ret ? `${day(plan.dates.out[0])} – ${day(plan.dates.ret[0])}` : `${day(plan.dates.out[0])}, one way`);
  else {
    bits.push(`out ${span(plan.dates.out)}${plan.dates.note ? ` (${said(plan.dates.note)})` : ""}`);
    if (plan.dates.ret) bits.push(`back ${span(plan.dates.ret)}`);
    else bits.push("one way");
  }
  if (plan.dates.prefer === "longest") bits.push("the longer the better");
  if (plan.dates.prefer === "shortest") bits.push("the shorter the better");
  if (plan.mixAirports) bits.push("either airport either way");
  if (plan.separateTickets && plan.dates.ret) bits.push("two tickets are fine");
  if (plan.dates.trimmed) bits.push("window trimmed to ten days a side");
  if (plan.dates.moved) bits.push("the dates you set had passed");
  return bits.join(" · ");
}
