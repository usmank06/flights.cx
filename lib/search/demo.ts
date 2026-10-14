import { AIRPORT_LIST, AIRPORTS } from "@/lib/airports";
import type { CallOptions, ExploreOptions, FlightBackend, ProviderTiming } from "@/lib/flights/backend";
import { asked, type Retry } from "@/lib/flights/retry";
import type { DatePricePoint, ExploreDestination, Itinerary, PlaceHit, Segment, SearchInput, ShoppingPayload } from "@/lib/flights/types";
import type { SearchRequest } from "@/lib/types";
import type { Planner } from "./engine";
import { isOpenDestination, resolveAirport } from "./intake";
import { CLASSIC_PICKS, placesIn, type Place, type TripPlan } from "./plan";

/**
 * Demo market: a stand-in for a live flight provider, used when none is configured. It answers any route with invented fares
 * in the same shapes a provider returns, and can be scripted to be slow, fail or hang. Searches against it are marked "demo".
 */

export type DemoCall = "shopping" | "returns" | "dateGrid" | "priceGraph" | "explore" | "places";

export type DemoScript = {
  /** Milliseconds a call takes. */
  latency?: number;
  /** Kinds that always throw. */
  fail?: DemoCall[];
  /** Kinds that throw their first n calls. */
  failFirst?: Partial<Record<DemoCall, number>>;
  /** Kinds that never answer until aborted. */
  hang?: DemoCall[];
  /** The bagless shopping call returns fares on a carrier (ZZ) used nowhere else, so its fares can be traced. */
  bagsOnRequest?: boolean;
  /** Let a city's secondary airports return fares. By default only its busiest airport has flights. */
  secondAirport?: boolean;
  /** Make the cheapest outbound's round-trip total the most expensive. */
  returnsInvert?: boolean;
  placesFail?: boolean;
  /** Destinations whose round-trip grid prices get a surcharge, so the choice of airport changes the price. */
  dearerOneTicket?: string[];
  /** One-way discounts (outbound to `outTo`, return from `backFrom`), so the cheapest ticket pair mixes airports. */
  cheaperOneWay?: { outTo: string; backFrom: string };
  /** The explore list: the nearest large airports to the origin, or a fixed pair. */
  explore?: "nearest" | "two";
};

export type DemoBackend = FlightBackend & Required<Pick<FlightBackend, "returns" | "dateGrid" | "priceGraph" | "explore" | "places" | "declareUnencoded">> & { calls: string[]; trips: string[]; legs: string[] };

/** USD prices whose digits can't appear in a date, time or duration, so a price leaked to a model is detectable. */
export const DEMO_PRICES = [1357, 1468, 1579, 2681, 2792, 3913];

/** Rough exchange rates per US dollar, so demo fares in other currencies look plausible. */
const DEMO_RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 83, SAR: 3.75, AED: 3.67, JPY: 150, CNY: 7.2, KRW: 1350 };
/** Converts a USD price to the requested currency. Unknown currencies are left unconverted. */
const inCurrency = (usd: number, currency?: string) => Math.round(usd * (DEMO_RATES[(currency ?? "USD").toUpperCase()] ?? 1));

/* --------------------------------- Places -------------------------------- */

/** Airports per city, busiest first. Mirrors the live backend, which treats a multi-airport city as one entity. */
const CITY_AIRPORTS = new Map<string, string[]>();
for (const a of [...AIRPORT_LIST].sort((x, y) => x.tier - y.tier)) CITY_AIRPORTS.set(a.city, [...(CITY_AIRPORTS.get(a.city) ?? []), a.code]);
const cityId = (city: string) => `/city/${city.toLowerCase().replace(/[^a-z]+/g, "-")}`;
const airportId = (code: string) => `/airport/${code.toLowerCase()}`;
const CITY_OF_ID = new Map<string, string>();
for (const city of CITY_AIRPORTS.keys()) CITY_OF_ID.set(cityId(city), city);

/** Endpoint to airport code. A city entity maps to its busiest airport. */
function codeOf(endpoint: string): string {
  const city = CITY_OF_ID.get(endpoint);
  return city ? CITY_AIRPORTS.get(city)![0] : endpoint;
}

/** Whether a code is one of a city's secondary airports (no flights by default). */
function secondary(code: string): boolean {
  const city = AIRPORTS[code]?.city;
  const list = city ? CITY_AIRPORTS.get(city) : undefined;
  return !!list && list.length > 1 && list[0] !== code;
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

/* --------------------------------- Fares --------------------------------- */

const NAMES: Record<string, string> = { QR: "Qatar Airways", EK: "Emirates", AA: "American", ZZ: "Bagless Air" };

function segment(from: string, to: string, date: string, dep: string, arr: string, airline: string, number: string, minutes: number): Segment {
  const name = (code: string) => `${AIRPORTS[code]?.city ?? code} International`;
  return {
    from: { code: from, name: name(from) },
    to: { code: to, name: name(to) },
    departure: `${date}T${dep}`,
    arrival: `${date}T${arr}`,
    durationMinutes: minutes,
    aircraft: "Boeing 787",
    airlineCode: airline,
    flightNumber: number,
    airlineName: NAMES[airline] ?? airline,
    legroom: "31 in",
    legroomClass: 1,
    co2Grams: 400_000,
    contrailWarming: 2,
    amenities: { powerAndUsb: true, usbOnly: false, onDemandVideo: true, wifi: "paid" },
    overnight: false,
    oftenDelayed: false,
  };
}

/** `n` itineraries on a route and date, every third one nonstop, the rest through Doha, priced in `currency`. */
function market(fromEndpoint: string, toEndpoint: string, date: string, n = 6, airline = "QR", currency?: string): Itinerary[] {
  const from = codeOf(fromEndpoint);
  const to = codeOf(toEndpoint);
  return Array.from({ length: n }, (_, i) => {
    const price = inCurrency(DEMO_PRICES[i % DEMO_PRICES.length] + (airline === "ZZ" ? 100 : 0), currency);
    const dep = `${String(6 + i * 2).padStart(2, "0")}:15`;
    const stops = i % 3 === 0 ? 0 : 1;
    const segments =
      stops === 0
        ? [segment(from, to, date, dep, "14:45", airline, String(100 + i), 510)]
        : [segment(from, "DOH", date, dep, "12:00", airline, String(100 + i), 330), segment("DOH", to, date, "15:20", "18:45", airline, String(200 + i), 205)];
    return {
      isBest: i < 2,
      price,
      bookingToken: `tok-${from}-${to}-${date}-${i}`,
      airlineCode: airline,
      airlineNames: [segments[0].airlineName!],
      from,
      to,
      departure: segments[0].departure,
      arrival: segments[segments.length - 1].arrival,
      totalDurationMinutes: stops ? 750 : 510,
      stops,
      segments,
      layovers: stops ? [{ airport: "DOH", minutes: 200, airportName: "Hamad International", city: "Doha" }] : [],
      co2: { grams: 400_000 * segments.length, typicalGrams: 420_000, lowestOnRouteGrams: 380_000, percentVsTypical: -4 },
      carryOnIncluded: 1,
    };
  });
}

const payloadOf = (itineraries: Itinerary[], withInsights: boolean, currency?: string): ShoppingPayload => ({
  itineraries,
  insights: withInsights ? { levelCode: 3, level: "typical", current: inCurrency(DEMO_PRICES[0], currency), typical: inCurrency(1400, currency), low: inCurrency(1100, currency), high: inCurrency(2300, currency), history: [] } : null,
  dateHints: [],
  airportHints: [],
});

function days(a: string, b: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(a); t <= Date.parse(b); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Resolves after `ms` (never if Infinity). Rejects when the signal aborts. */
function after<T>(ms: number, value: () => T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const done = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) return done();
    const t =
      ms === Infinity
        ? null
        : setTimeout(() => {
            try {
              resolve(value());
            } catch (e) {
              reject(e);
            }
          }, ms);
    signal?.addEventListener("abort", () => {
      if (t) clearTimeout(t);
      done();
    });
  });
}

/** Building blocks for checks that script their own calls on top of the market. */
export { after as demoAfter, days as demoDays, market as demoItineraries, payloadOf as demoPayload };

/* -------------------------------- The market ------------------------------- */

/** Timing and retries like a live provider's, so the engine runs on the same clocks against the demo market. */
export const DEMO_TIMING: ProviderTiming = { returnsWaitMs: 30_000, longStaysGraceMs: 4_000 };
export const DEMO_RETRY: Retry = { asks: 4, askAgainMs: 600 };

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Wraps a scripted call so it is asked again the way a provider asks itself. The call's last argument is its options. */
export function demoAsks<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => Promise<T> {
  return (...args: any[]) => {
    const opts: CallOptions = args[args.length - 1] ?? {};
    return asked((signal) => fn(...args.slice(0, -1), { ...opts, signal }), DEMO_RETRY, opts);
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function demoBackend(script: DemoScript = {}): DemoBackend {
  const calls: string[] = [];
  const trips: string[] = [];
  const legs: string[] = [];
  const made: Partial<Record<DemoCall, number>> = {};
  const dearer = script.dearerOneTicket ?? ["OPO"];
  const cheaper = script.cheaperOneWay ?? { outTo: "LIS", backFrom: "OPO" };
  // Asked again the way the live provider asks itself (DEMO_RETRY), with the script applied to each ask.
  const run = <T>(kind: DemoCall, opts: CallOptions | undefined, make: () => T): Promise<T> =>
    asked(
      (signal) => {
        calls.push(kind);
        made[kind] = (made[kind] ?? 0) + 1;
        if (script.hang?.includes(kind)) return after(Infinity, make, signal);
        if (script.fail?.includes(kind) || made[kind]! <= (script.failFirst?.[kind] ?? 0))
          return after(script.latency ?? 20, () => {
            throw new Error(`${kind} failed`);
          }, signal);
        return after(script.latency ?? 20, make, signal);
      },
      DEMO_RETRY,
      opts
    );
  return {
    name: "Demo market",
    live: false,
    timing: DEMO_TIMING,
    calls,
    trips,
    legs,
    shopping: (input: SearchInput, opts?: CallOptions) =>
      run("shopping", opts, () => {
        const bagless = !input.carry_on_bags && !input.checked_bags;
        const leg = input.flights[0];
        trips.push(input.trip ?? "round-trip");
        legs.push(`${leg.from_airport}>${leg.to_airport}`);
        // Secondary airports have no flights unless the script enables them.
        if (secondary(leg.from_airport) && !script.secondAirport) return payloadOf([], bagless, input.currency);
        // As live, only the bagless call carries insights. With bagsOnRequest its fares use the ZZ carrier.
        return payloadOf(market(leg.from_airport, leg.to_airport, leg.date, 6, bagless && script.bagsOnRequest ? "ZZ" : "QR", input.currency), bagless, input.currency);
      }),
    returns: (input, outbound, opts) =>
      run("returns", opts, () => {
        const back = input.flights[1];
        // Returns carry the round-trip total: the outbound's price, rising by 40 per option.
        const outPrice = DEMO_PRICES[Number(outbound.segments[0].flightNumber) - 100] ?? DEMO_PRICES[0];
        const bump = script.returnsInvert && outPrice === DEMO_PRICES[0] ? 900 : 0;
        const itins = market(back.from_airport, back.to_airport, back.date, 2).map((it, i) => ({ ...it, price: inCurrency(outPrice + bump + i * 40, input.currency) }));
        return payloadOf(itins, false, input.currency);
      }),
    dateGrid: (input, outWindow, returnWindow, opts) =>
      run("dateGrid", opts, () => {
        const cells: DatePricePoint[] = [];
        const bump = dearer.includes(codeOf(input.flights[0].to_airport)) ? 200 : 0;
        for (const o of days(...outWindow)) for (const r of days(...returnWindow)) if (r > o) cells.push({ outDate: o, returnDate: r, price: inCurrency(DEMO_PRICES[(o.charCodeAt(9) + r.charCodeAt(9)) % DEMO_PRICES.length] + bump, input.currency) });
        return { points: cells, settled: true };
      }),
    priceGraph: (input, range, tripDays, opts) =>
      run("priceGraph", opts, () => {
        void tripDays;
        // One-way prices by day. On some day pairs, two one-ways undercut the round trip.
        const from = codeOf(input.flights[0].from_airport);
        const to = codeOf(input.flights[0].to_airport);
        const back = to !== cheaper.outTo && to !== cheaper.backFrom;
        const discount = back ? (from === cheaper.backFrom ? -60 : 0) : to === cheaper.outTo ? -60 : 0;
        return { points: days(...range).map((day): DatePricePoint => ({ outDate: day, returnDate: null, price: inCurrency((back ? 640 : 600) + (day.charCodeAt(9) % 3) * 90 + discount, input.currency) })), settled: true };
      }),
    explore: (origin: string, opts: ExploreOptions) =>
      run("explore", opts, () => {
        const place = (code: string, name: string, country: string, i: number): ExploreDestination => ({
          id: airportId(code),
          name,
          country,
          code,
          lat: AIRPORTS[code]?.lat ?? null,
          lon: AIRPORTS[code]?.lon ?? null,
          price: inCurrency(DEMO_PRICES[i % DEMO_PRICES.length], opts.currency),
          token: null,
          carrierCode: "AA",
          carrierName: "American",
          stops: i % 2,
          durationMinutes: 170 + i * 25,
          outDate: opts.dates?.out ?? null,
          returnDate: opts.dates?.ret ?? null,
          image: null,
        });
        const from = AIRPORTS[codeOf(origin)];
        if ((script.explore ?? "nearest") === "two" || !from) return [place("CUN", "Cancún", "Mexico", 0), place("MIA", "Miami", "United States", 1)];
        // The nearest large airports beyond a short hop, one per city.
        const seen = new Set<string>([from.city]);
        return AIRPORT_LIST.filter((a) => a.tier <= 2 && km(a, from) > 300)
          .sort((a, b) => km(a, from) - km(b, from))
          .filter((a) => !seen.has(a.city) && seen.add(a.city))
          .slice(0, 10)
          .map((a, i) => place(a.code, a.city, a.country, i));
      }),
    places: (text: string, opts?: CallOptions) =>
      run("places", opts, (): PlaceHit[] => {
        if (script.placesFail) throw new Error("places down");
        const t = text.trim();
        const code = resolveAirport(t);
        if (!code) return [];
        const city = AIRPORTS[code]?.city;
        const list = city ? CITY_AIRPORTS.get(city) : undefined;
        // A city name returns the city entity with all its airports. A typed code returns that airport.
        if (city && list && list.length > 1 && t.toUpperCase() !== code) return [{ kind: "city", name: city, id: cityId(city), code: null, airports: list.map((c, i) => ({ code: c, name: `${city} (${c})`, km: 10 + i * 15 })) }];
        return [{ kind: "airport", name: `${city ?? code} Airport`, id: airportId(code), code, airports: [] }];
      }),
    declareUnencoded: () => [],
  };
}

/* ------------------------------- The planner ------------------------------- */

const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Places in free text: `placesIn` first, else the first one- or two-word phrase that resolves to an airport. */
function placesInWords(text: string): Place[] {
  const found = placesIn(text);
  if (found.length) return found;
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  for (let n = 2; n >= 1; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const part = words.slice(i, i + n).join(" ");
      const code = resolveAirport(part);
      if (code) return [{ code, name: AIRPORTS[code]?.city ?? part }];
    }
  return [];
}

/**
 * A plan from the request's fields alone, for the demo when no planner model is configured. The destination comes from the "to"
 * field or the brief. Without dates, the trip leaves a month out for a week.
 */
export function planFromFields(req: SearchRequest, today = new Date().toISOString().slice(0, 10)): TripPlan | null {
  const origins = placesInWords(req.from);
  if (!origins.length) return null;
  const said = req.to || req.brief || "";
  const open = isOpenDestination(said);
  const destinations = open ? [] : placesInWords(said);
  const out = req.departDate ?? plusDays(today, 30);
  const ret = req.returnDate ?? (req.departDate ? null : plusDays(out, 7));
  const span = req.datesFlexible ? 3 : 0;
  const around = (d: string): [string, string] => [plusDays(d, -span) < today ? today : plusDays(d, -span), plusDays(d, span)];
  const names = (xs: Place[]) => [...new Set(xs.map((x) => x.name))].join(" or ");
  return {
    origins,
    destinations,
    openHint: destinations.length ? null : said || "anywhere",
    mixAirports: false,
    separateTickets: req.hassle >= 3,
    dates: { anchor: { out, ret }, out: around(out), ret: ret ? around(ret) : null, prefer: "none", note: null, trimmed: false },
    picks: CLASSIC_PICKS,
    musts: [],
    understood: `${names(origins)} to ${destinations.length ? names(destinations) : said || "anywhere"} · ${out}${ret ? ` – ${ret}` : ", one way"}`,
    reading: {},
  };
}

/** Demo planner for a given "today". Reads the form fields only. Without an origin it fails with a message the page can show. */
export const demoPlannerOn =
  (today?: string): Planner =>
  async (req) => {
    const plan = planFromFields(req, today);
    if (plan) return { plan, usage: null, ms: 1 };
    return { plan: null, usage: null, ms: 1, failure: "no origin in the fields", said: "This demo reads the form rather than your words, so it needs to know where you’re flying from. Answer that question and it’ll take it from there." };
  };
