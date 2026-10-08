import { AIRPORT_LIST, AIRPORTS, nearbyAirports } from "@/lib/airports";
import { coerceLocale, isCurrencyCode } from "@/lib/format";
import { MAX_TURNS, SET_FIELDS, type SetField } from "@/lib/intake/questions";
import type { Bags, CabinClass, IntakeTurn, SearchRequest } from "@/lib/types";

/** Search request intake: validating the request body and resolving place fields to airports. The brief is left to the planner. */

/**
 * Pulls an airport code out of a place field. A field that is only three letters matches in any case ("dfw"); a code inside
 * longer text must be uppercase ("London / LHR"), so words like "the" don't match.
 */
function iataOf(field: string): string | undefined {
  const t = (field ?? "").trim();
  if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();
  return t.match(/\b([A-Z]{3})\b/)?.[1];
}

/** Wildcards and bare regions that leave the destination open ("anywhere in the US", "somewhere warm", "Europe"). */
const OPEN_DEST =
  /^\s*(?:(?:go\s+)?(?:anywhere|somewhere|wherever|surprise\s*me|any\s*where|open|no\s*idea|not\s*sure)\b|(?:the\s+)?(?:us|usa|united\s+states|america|canada|mexico|europe|asia|africa|oceania|caribbean|scandinavia|balkans|mediterranean|middle\s+east|south\s+america|latin\s+america|central\s+america|south\s*east\s+asia)\s*$)/i;

/** Words for a kind of place ("a beach", "abroad"). With no city or code alongside, they make the destination open. */
const OPEN_WORDS =
  /\b(any|anywhere|somewhere|wherever|abroad|international|overseas|foreign|destination|destinations|beach|beaches|coast|island|islands|warm|sunny|hot|cold|snow|ski|mountains|tropical|cheap|cheapest|surprise|idea|sure|wherever|weekend|getaway)\b/i;

export function isOpenDestination(to: string): boolean {
  const t = (to ?? "").trim();
  if (!t) return true;
  // Wildcard wording wins even if a code is present ("anywhere but LHR").
  if (OPEN_DEST.test(t) || /\banywhere\b|\bsomewhere\b|\bwherever\b/i.test(t)) return true;
  if (iataOf(t)) return false;
  if (!OPEN_WORDS.test(t)) return false;
  // "any beach near Barcelona" names a place; "any beach" does not.
  const padded = ` ${t.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  const namesAPlace = AIRPORT_LIST.some((a) => a.city.length >= 4 && padded.includes(` ${a.city.toLowerCase()} `)) || Object.keys(ALIASES).some((alias) => alias.length >= 4 && padded.includes(` ${alias} `));
  return !namesAPlace;
}

/**
 * Common city names that don't match the airport table's city field. Each entry should name the same city as its code (a
 * spelling fix like "bombay"). A nearby city's airport would send the search somewhere the traveller never named.
 */
const ALIASES: Record<string, string> = {
  nyc: "JFK", "new york city": "JFK", manhattan: "JFK",
  la: "LAX", "los angeles": "LAX", sf: "SFO", "san fran": "SFO", "bay area": "SFO",
  dc: "DCA", "washington dc": "DCA", vegas: "LAS", chicago: "ORD",
  bombay: "BOM", calcutta: "CCU", bangalore: "BLR", bengaluru: "BLR",
  saigon: "SGN", "ho chi minh": "SGN", peking: "PEK", "sao paolo": "GRU",
  rio: "GIG", "buenos aires": "EZE", "mexico city": "MEX", cdmx: "MEX",
  tokyo: "HND", osaka: "KIX", seoul: "ICN", "hong kong": "HKG",
  toronto: "YYZ", montreal: "YUL", vancouver: "YVR", london: "LHR",
  paris: "CDG", rome: "FCO", milan: "MXP", munich: "MUC",
  athens: "ATH", istanbul: "IST", dubai: "DXB", "abu dhabi": "AUH",
  doha: "DOH", riyadh: "RUH", jeddah: "JED", dammam: "DMM", cairo: "CAI",
  bali: "DPS", sydney: "SYD", melbourne: "MEL", auckland: "AKL",
  amsterdam: "AMS", copenhagen: "CPH", stockholm: "ARN", oslo: "OSL",
  reykjavik: "KEF", lisbon: "LIS", porto: "OPO", madrid: "MAD",
  barcelona: "BCN", dublin: "DUB", zurich: "ZRH",
  vienna: "VIE", prague: "PRG", budapest: "BUD", warsaw: "WAW", krakow: "KRK",
};

/** Best-effort free text to IATA code. Returns undefined when unsure, since a wrong airport is worse than none. */
export function resolveAirport(field: string): string | undefined {
  const raw = (field ?? "").trim();
  if (!raw || isOpenDestination(raw)) return undefined;

  const code = iataOf(raw);
  if (code && AIRPORTS[code]) return code;

  const t = raw.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (ALIASES[t] && AIRPORTS[ALIASES[t]]) return ALIASES[t];

  // Exact city match, preferring the busiest airport serving it.
  const city = AIRPORT_LIST.filter((a) => a.city.toLowerCase() === t).sort((a, b) => a.tier - b.tier);
  if (city.length) return city[0].code;

  // A city name followed by more words: "chicago illinois", "london uk".
  const prefix = AIRPORT_LIST.filter((a) => t.startsWith(a.city.toLowerCase() + " ")).sort(
    (a, b) => a.tier - b.tier
  );
  if (prefix.length) return prefix[0].code;

  for (const [alias, hit] of Object.entries(ALIASES)) {
    if (t.startsWith(alias + " ") && AIRPORTS[hit]) return hit;
  }

  // A city anywhere in a sentence: the first mentioned wins, and a longer name wins a tie ("new york" over "york").
  if (t.includes(" ")) {
    const padded = ` ${t} `;
    let best: { at: number; len: number; code: string } | undefined;
    const consider = (name: string, code: string) => {
      if (name.length < 4 || CITY_WORDS.has(name)) return;
      const at = padded.indexOf(` ${name} `);
      if (at < 0) return;
      if (!best || at < best.at || (at === best.at && name.length > best.len)) best = { at, len: name.length, code };
    };
    for (const a of [...AIRPORT_LIST].sort((p, q) => p.tier - q.tier)) consider(a.city.toLowerCase(), a.code);
    for (const [alias, hit] of Object.entries(ALIASES)) if (AIRPORTS[hit]) consider(alias, hit);
    if (best) return best.code;
  }
  return undefined;
}

/** City names that are also ordinary English words. Never matched mid-sentence. */
const CITY_WORDS = new Set(["nice", "reading", "bath", "mobile", "split", "orange", "phoenix", "victoria", "george", "jackson", "sandy", "moab", "hope"]);

/**
 * A heading for a typed place: the city it resolves to ("LAX" → Los Angeles), else its first few words. Text after "from" is
 * ignored, since it names the origin ("tiny island nobody flies to from Boston").
 */
export function placeLabel(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const code = resolveAirport(raw.replace(/\s+from\s+.*$/i, ""));
  if (code && AIRPORTS[code]) return AIRPORTS[code].city;
  return hintLabel(raw);
}

/** A heading from the traveller's words: the first four, capitalised, with no city lookup. */
export function hintLabel(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const words = raw.replace(/\s+/g, " ").split(" ");
  const short = words.slice(0, 4).join(" ") + (words.length > 4 ? "…" : "");
  const label = short.charAt(0).toUpperCase() + short.slice(1);
  // Capitalise country initials ("the us" → "the US"). A bare "us" is usually the pronoun ("surprise us"), so it is left alone.
  return label.replace(/\b(the )?(usa|uae|uk|us)\b/gi, (m: string, the: string | undefined, w: string) => (w.toLowerCase() === "us" && !the ? m : (the ?? "") + w.toUpperCase()));
}

/** Airports that serve the same place: `code` and every airport within 150 km (London includes Gatwick). */
export function metroCodes(code: string | undefined): Set<string> {
  if (!code || !AIRPORTS[code]) return new Set();
  return new Set([code, ...nearbyAirports(code, 150).map((a) => a.code)]);
}

/* ------------------------------ Request parsing --------------------------- */

/** A real calendar date. Date parsing rolls Feb 30 over to Mar 2, so a valid date must format back to itself. */
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
/** How far ahead flights are sold (about eleven months), in days. */
export const SALE_HORIZON_DAYS = 330;
export const FAR_SAID = "That’s further ahead than flights are sold. Airlines sell about eleven months out, so pick nearer dates and search again.";

/** Header carrying the browser's local date on search POSTs (set in components/search/search-client.ts). */
export const TODAY_HEADER = "x-flights-today";

/** Today for the traveller: the date their browser sent if within a day of the server's UTC date, else the server's. */
export function travellersDay(sent: string | null | undefined, now = Date.now()): string {
  const server = new Date(now).toISOString().slice(0, 10);
  if (!isDate(sent)) return server;
  return Math.abs(Date.parse(`${sent}T12:00:00Z`) - Date.parse(`${server}T12:00:00Z`)) <= 86_400_000 ? sent : server;
}

const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/**
 * Coerces a public POST body into a SearchRequest, or returns an error. Every field is clamped and only a route or a brief is
 * required. Party limits match what the provider accepts. `today` is the traveller's (travellersDay).
 */
export function coerceSearchRequest(body: unknown, today = new Date().toISOString().slice(0, 10)): { request: SearchRequest } | { error: string } {
  if (!body || typeof body !== "object") return { error: "expected a JSON object" };
  const b = body as Record<string, unknown>;

  const from = str(b.from, 120);
  const to = str(b.to, 120);
  // A request with a brief may have no route; the planner reads it from the words.
  const brief = str(b.brief, 1_000);
  const turns: IntakeTurn[] = (Array.isArray(b.turns) ? b.turns : [])
    .slice(0, MAX_TURNS)
    .map((t) => (t ?? {}) as Record<string, unknown>)
    .filter((t) => typeof t.q === "string" && typeof t.a === "string")
    .map((t) => ({ key: str(t.key, 32), q: str(t.q, 200), a: str(t.a, 500) }))
    .filter((t) => t.q && t.a);
  const set = (Array.isArray(b.set) ? b.set : []).filter((f): f is SetField => SET_FIELDS.includes(f as SetField));
  if (!brief && !from) return { error: "where you’re flying from is required" };
  if (!brief && !to) return { error: "where you’re flying to is required" };

  const departDate = isDate(b.departDate) ? b.departDate : null;
  let returnDate = isDate(b.returnDate) ? b.returnDate : null;
  // Treat a return before departure as one-way, since the provider rejects it.
  if (departDate && returnDate && returnDate < departDate) returnDate = null;
  // Refuse form dates past the sale horizon before any model call.
  const horizon = new Date(Date.parse(`${today}T12:00:00Z`) + SALE_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  if ((!brief || set.includes("dates")) && [departDate, returnDate].some((d) => d != null && d > horizon)) return { error: FAR_SAID };

  const rawPax = (b.passengers ?? {}) as Record<string, unknown>;
  const adults = clampInt(rawPax.adults, 1, 9, 1);
  const children = clampInt(rawPax.children, 0, 8, 0);
  const infantsInSeat = clampInt(rawPax.infantsInSeat, 0, 8, 0);
  // At most one lap infant per adult.
  const infantsOnLap = Math.min(adults, clampInt(rawPax.infantsOnLap, 0, 8, 0));
  const seated = adults + children + infantsInSeat;
  if (seated > 9) return { error: "A search tops out at nine travelers in seats." };

  const rawBags = (b.bags ?? {}) as Record<string, unknown>;
  const bags: Bags = { carryOn: clampInt(rawBags.carryOn, 0, 4, 0), checked: clampInt(rawBags.checked, 0, 6, 0) };

  const cabin: CabinClass = CABINS.includes(b.cabin as CabinClass) ? (b.cabin as CabinClass) : "economy";
  const currency = isCurrencyCode(b.currency) ? b.currency.toUpperCase() : "USD";
  const locale = coerceLocale(b.locale);

  return {
    request: {
      from,
      to,
      departDate,
      returnDate,
      datesFlexible: b.datesFlexible === true,
      flexibilityNote: str(b.flexibilityNote),
      bags,
      cabin,
      passengers: { adults, children, infantsInSeat, infantsOnLap },
      currency,
      locale,
      hassle: clampInt(b.hassle, 0, 3, 1),
      notes: str(b.notes, 600),
      ...(brief ? { brief, turns, set } : {}),
    },
  };
}

/** What a place lookup answers with: an airport's own code, or a city's airports. */
type PlaceLookup = (text: string) => Promise<{ code: string | null; airports: { code: string }[] }[]>;

/**
 * The first airport code set in the form that matches no airport ("QQQ"). Checked with `lookup`, since the local table holds only
 * the busiest airports. Null when every code is real or the lookup fails.
 */
export async function unknownAirport(req: SearchRequest, lookup: PlaceLookup): Promise<string | null> {
  const set = setFields(req);
  for (const field of [set.has("from") ? req.from : "", set.has("to") ? req.to : ""]) {
    const t = (field ?? "").trim();
    if (!/^[A-Za-z]{3}$/.test(t) || resolveAirport(t)) continue;
    const code = t.toUpperCase();
    const hits = await lookup(t).catch(() => null);
    if (!hits) continue;
    // Text not typed in capitals ("Hue") may be a place name, so refuse it only when the lookup finds nothing.
    if (!hits.some((h) => h.code === code || h.airports.some((a) => a.code === code)) && (t === code || !hits.length)) return code;
  }
  return null;
}

/** Fields set explicitly: those in `set` for a request with a brief, otherwise all of them. */
export function setFields(req: SearchRequest): Set<SetField> {
  return new Set(req.brief ? (req.set ?? []) : SET_FIELDS);
}

/**
 * Whether the search was asked in words. A shared copy drops the brief (`publicRecord`) but keeps `set`, which only worded
 * requests carry.
 */
export function askedInWords(req: SearchRequest): boolean {
  return Boolean(req.brief) || Array.isArray(req.set);
}

/**
 * The request with every field marked as set, for reruns, so "next weekend" can't drift to a later weekend when a price watch
 * reruns it. The brief stays for what fields can't express (the window, the preference, the musts).
 */
export function fixedRequest(req: SearchRequest): SearchRequest {
  return req.brief ? { ...req, set: [...SET_FIELDS] } : req;
}

/** Converts Arabic-Indic, Persian and full-width digits to ASCII and strips bidi marks. */
export const asciiDigits = (s: string): string =>
  s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\uff10-\uff19]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "");


const CABINS: CabinClass[] = ["economy", "premium-economy", "business", "first"];
