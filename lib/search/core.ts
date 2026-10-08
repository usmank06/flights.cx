import { z } from "zod";
import { isPlaceId } from "@/lib/flights/backend";
import type { Itinerary, Leg, SearchInput } from "@/lib/flights/types";
import type { FlightLeg, SearchRequest, UnencodedField } from "@/lib/types";
import { CABIN_LABEL, describeBags, describePassengers, seatedTravellers } from "@/lib/types";
import { money, shortDate, twelveHour } from "@/lib/format";
import type { ModelOption, ReasoningEffort } from "./models";

/**
 * Shared helpers for the engine and follow-ups: query building, the structured model call, trip facts, and turning itineraries
 * into cards and compact rows. Models pick by id and judge in words; code does all arithmetic on money.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 100_000;

/* ------------------------------ Zod schemas ------------------------------ */

const LegSchema = z.object({
  date: z.string().describe("YYYY-MM-DD, must be in the future"),
  from_airport: z.string().describe("IATA airport code, e.g. YYZ"),
  to_airport: z.string().describe("IATA airport code, e.g. LHR"),
  max_stops: z.number().int().min(0).max(3).nullable().describe("0 = nonstop only; null = no limit"),
});

export const PlannedQuerySchema = z.object({
  reason: z.string().describe("Why this query — one short line for the live log, ≤60 chars"),
  trip: z.enum(["one-way", "round-trip", "multi-city"]),
  legs: z
    .array(LegSchema)
    .min(1)
    .max(2)
    .describe(
      "EXACTLY 1 leg for one-way (trip:one-way), or EXACTLY 2 legs for round-trip (trip:round-trip) where leg 2 MUST be the reverse of leg 1 (A→B then B→A). For self-transfers/gateways (A→B then B→C) use SEPARATE one-way queries, never 2 legs in one query."
    ),
  max_price: z
    .number()
    .int()
    .nullable()
    .describe("Price cap for the whole party, in the traveller's own currency. ONE-WAY queries only; leave null on round-trips."),
});

export type PlannedQuery = z.infer<typeof PlannedQuerySchema>;

/* ------------------------------ Model calls ------------------------------ */

// Strict json_schema mode needs additionalProperties: false and every key required on each object. The schemas use
// .nullable() for optional fields, so requiring every key is safe.
/* eslint-disable @typescript-eslint/no-explicit-any */
function makeStrict(node: any): any {
  if (Array.isArray(node)) return node.map(makeStrict);
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = makeStrict(node[k]);
    if (node.type === "object" && node.properties) {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
    }
  }
  return node;
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete js.$schema;
  return makeStrict(js);
}

export type ModelUsage = { in: number; out: number; costUsd: number | null };

export type StructuredResult<T> = {
  parsed: T | null;
  failure?: string;
  rawText: string;
  usage: ModelUsage;
};

/**
 * One structured call over OpenRouter with a strict json_schema response format, reporting actual cost. Never throws, so a model
 * outage fails one stage rather than the search.
 */
export async function callModelStructured<T extends z.ZodTypeAny>(
  model: ModelOption,
  schema: T,
  schemaName: string,
  system: string,
  userContent: string,
  opts: { effort?: ReasoningEffort; timeoutMs?: number; maxTokens?: number; signal?: AbortSignal; temperature?: number } = {}
): Promise<StructuredResult<z.infer<T>>> {
  const empty: ModelUsage = { in: 0, out: 0, costUsd: null };
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { parsed: null, failure: "OPENROUTER_API_KEY is not set", rawText: "", usage: empty };

  const effort = model.reasoning ? (opts.effort ?? model.reasoning) : undefined;
  const maxOut = opts.maxTokens ?? model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    max_tokens: maxOut,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema: toJsonSchema(schema) },
    },
    usage: { include: true },
    // Omitted unless asked: the provider's default then applies.
    ...(opts.temperature != null && model.acceptsTemperature !== false ? { temperature: opts.temperature } : {}),
    // "none" turns reasoning off (OpenRouter's `enabled: false`).
    ...(effort === "none" ? { reasoning: { enabled: false } } : effort ? { reasoning: { effort } } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
  };

  let res: Response;
  let data: any;
  try {
    res = await postOpenRouter(body, key, opts.timeoutMs ?? MODEL_TIMEOUT_MS, opts.signal);
    // Read the body inside the try: fetch resolves on headers, so the timeout can still fire mid-body.
    if (res.ok) data = await res.json();
  } catch (e) {
    return { parsed: null, failure: `model call failed: ${(e as Error).message}`, rawText: "", usage: empty };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { parsed: null, failure: `OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`, rawText: "", usage: empty };
  }

  const choice = data?.choices?.[0];
  const rawText: string = choice?.message?.content ?? "";
  const usage: ModelUsage = {
    in: data.usage?.prompt_tokens ?? 0,
    out: data.usage?.completion_tokens ?? 0,
    costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
  };

  try {
    const parsed = schema.parse(JSON.parse(rawText));
    return { parsed, rawText, usage };
  } catch (e) {
    const failure =
      choice?.finish_reason === "length"
        ? `hit max_tokens (${usage.out}/${maxOut}) before the JSON finished`
        : !rawText
          ? `model returned no content (finish_reason: ${choice?.finish_reason ?? "?"})`
          : `output didn't match schema: ${(e as Error).message.slice(0, 160)}`;
    return { parsed: null, failure, rawText, usage };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** POST to OpenRouter, retrying a 429 once while the deadline allows. */
export async function postOpenRouter(
  body: Record<string, unknown>,
  key: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let res!: Response;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) return res;
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://flights.cx",
        "X-Title": "flights.cx",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(remaining), signal]) : AbortSignal.timeout(remaining),
    });
    if (res.status !== 429 || attempt === 2) return res;
    await new Promise((r) => setTimeout(r, Math.min(1_000, Math.max(0, deadline - Date.now()))));
  }
  return res;
}

/* ------------------------------ Small helpers ----------------------------- */

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const fmtDur = (m: number | null | undefined) =>
  m == null ? "?" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;

/** Display names for place ids used as leg endpoints, so log lines show a city name instead of an opaque id. */
export const PLACE_NAMES = new Map<string, string>();
const endpointName = (v: string) => PLACE_NAMES.get(v) ?? v;

export function describeInput(input: SearchInput): string {
  const legs = input.flights.map((l) => `${endpointName(l.from_airport)}→${endpointName(l.to_airport)} ${l.date}`).join(" + ");
  return `${legs}${input.trip === "round-trip" ? " (RT)" : ""}`;
}

/** The language part of a locale ("en-GB" → "en"), which is what the provider takes. */
export const languageTag = (locale: string): string => (locale || "en").split(/[-_]/)[0].toLowerCase() || "en";

/** A date shifted by whole days, built at noon UTC so no timezone can roll it. */
export const shiftDay = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

const posInt = (n: number | null | undefined): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
const rangeInt = (n: number | null | undefined, max: number): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;

/** Builds the provider input for a query. Passengers, cabin, bags, currency and language come from the request. */
export function toSearchInput(pq: PlannedQuery, req: SearchRequest): SearchInput {
  // Upper-case airport codes; place ids are case-sensitive and kept as is.
  const endpoint = (v: string) => (isPlaceId(v) ? v : v.toUpperCase());
  const legs: Leg[] = pq.legs.slice(0, 2).map((l) => ({
    date: l.date,
    from_airport: endpoint(l.from_airport),
    to_airport: endpoint(l.to_airport),
    max_stops: rangeInt(l.max_stops, 3),
  }));
  const trip = legs.length >= 2 ? (pq.trip === "multi-city" ? "multi-city" : "round-trip") : "one-way";
  const p = req.passengers;
  return {
    flights: legs,
    trip,
    seat: req.cabin,
    passengers: {
      adults: Math.max(1, p.adults),
      children: p.children,
      infants_in_seat: p.infantsInSeat,
      infants_on_lap: p.infantsOnLap,
    },
    max_price: trip === "one-way" ? posInt(pq.max_price) : undefined,
    carry_on_bags: req.bags.carryOn || undefined,
    checked_bags: req.bags.checked || undefined,
    currency: req.currency,
    language: languageTag(req.locale),
  };
}

/**
 * One query. The return leg reverses the route unless `backFrom` names another airport, which makes it an open-jaw multi-city
 * search: one ticket, priced as a single trip like a round trip.
 */
export function queryFor(req: SearchRequest, from: string, to: string, outDate: string, retDate: string | null, reason = "", backFrom?: string): SearchInput {
  const legs = [{ date: outDate, from_airport: from, to_airport: to, max_stops: null }];
  const back = backFrom ?? to;
  if (retDate) legs.push({ date: retDate, from_airport: back, to_airport: from, max_stops: null });
  const trip = legs.length === 1 ? "one-way" : back === to ? "round-trip" : "multi-city";
  return toSearchInput({ reason, trip, legs, max_price: null }, req);
}

/** Trip facts every model call is given, including any request fields the search couldn't send. */
export function tripFacts(req: SearchRequest, unencoded: UnencodedField[] = []): string {
  const seats = seatedTravellers(req.passengers);
  const lines: string[] = [
    `- Party: ${describePassengers(req.passengers)}. Every price you see is the TOTAL for all of them, not a per-person fare.` +
      (seats > 1 ? ` Divide by ${seats} for a per-person figure if you need one — but quote the total.` : ""),
    `- Cabin asked for: ${CABIN_LABEL[req.cabin]}.`,
    `- Bags: ${describeBags(req.bags)} per traveller.`,
    `- Currency: ${req.currency}. Write money as ${money(1234, req.currency, req.locale)} (that is one thousand two hundred and thirty-four), never with a bare "$" unless the currency is a dollar.`,
    // Described in words: an example time would count as a given number in the write-up's guard (voice.ts).
    twelveHour(req.locale)
      ? `- Times of day: write them on the 12-hour clock with AM and PM, as the traveller reads a clock and the cards show them, never on the 24-hour clock.`
      : `- Times of day: write them on the 24-hour clock, as the traveller reads a clock and the cards show them.`,
  ];
  for (const u of unencoded) lines.push(`- ⚠ ${u.note}`);
  if (!unencoded.length)
    lines.push(`- Everything above was part of the search itself, so the prices reflect it.`);
  return `Trip facts (these are the truth about what was searched — do not contradict them):\n${lines.join("\n")}`;
}

/* --------------------------- Rows and cards --------------------------- */

export interface IndexedItin {
  id: number;
  itin: Itinerary;
  /** Which query found it. */
  queryIndex: number;
  /** The price covers the round trip. */
  rt: boolean;
  /** On a round-trip fare, the return date from the query; the itinerary only carries the outbound. */
  retDate?: string;
  /** Days the outbound/return moved from the dates asked for, when known. */
  shift?: { out: number; ret: number };
  /** An open-jaw one-ticket fare: the second leg, which leaves from a different airport than the outbound reached. */
  jaw?: { from: string; to: string };
}

/** The compact row a model reads and a follow-up answers from. */
export type CompactRow = {
  id: number;
  q?: number;
  fare: "one-way" | "round-trip";
  covers?: string;
  outDate?: string;
  retDate?: string | null;
  best?: boolean;
  price: number | null;
  from: string;
  to: string;
  dep: string;
  arr: string;
  durMin: number;
  stops: number;
  lay: string[];
  air: string[];
  fn: string[];
  /** On an open-jaw one-ticket fare: the airport the return leaves from. */
  backFrom?: string;
  /** One "ORD YYYY-MM-DD DOH QR 732" entry per flown segment, for booking links. Never sent to a model. */
  seg: string[];
  /** The provider's opaque booking token, when present. Never sent to a model. */
  bookingToken?: string | null;
  carryOn?: number | null;
};

export function compactForLLM(x: IndexedItin): CompactRow {
  const it = x.itin;
  return {
    id: x.id,
    q: x.queryIndex,
    fare: x.rt ? "round-trip" : "one-way",
    ...(x.rt ? { covers: "whole trip, out + back, ONE ticket", outDate: it.departure.slice(0, 10), retDate: x.retDate ?? null } : {}),
    ...(x.jaw ? { backFrom: x.jaw.from } : {}),
    ...(it.isBest ? { best: true } : {}),
    price: it.price,
    from: it.from,
    to: it.to,
    dep: it.departure,
    arr: it.arrival,
    durMin: it.totalDurationMinutes,
    stops: it.stops,
    lay: it.layovers.map((l) => `${l.airport} ${l.minutes}m`),
    air: [...new Set(it.segments.map((s) => s.airlineName ?? s.airlineCode ?? "?"))],
    fn: it.segments.map((s) => `${s.airlineCode ?? "?"} ${s.flightNumber ?? "?"}`),
    seg: it.segments.map((s) => `${s.from.code} ${s.departure.slice(0, 10)} ${s.to.code} ${s.airlineCode ?? "?"} ${s.flightNumber ?? "?"}`),
    ...(it.bookingToken ? { bookingToken: it.bookingToken } : {}),
    ...(it.carryOnIncluded != null ? { carryOn: it.carryOnIncluded } : {}),
  };
}

/** A row as a model sees it, without the booking fields. */
export type ModelRow = Omit<CompactRow, "seg" | "bookingToken">;
export const rowsForModel = (rows: CompactRow[]): ModelRow[] =>
  rows.map((row) => {
    const rest: ModelRow & Partial<Pick<CompactRow, "seg" | "bookingToken">> = { ...row };
    delete rest.bookingToken;
    delete rest.seg;
    return rest;
  });

export function itinToLeg(x: IndexedItin, direction: FlightLeg["direction"], locale = "en-US"): FlightLeg {
  const it = x.itin;
  const depDate = it.departure.slice(0, 10);
  const arrDate = it.arrival.slice(0, 10);
  const dayDiff = daysBetween(depDate, arrDate);
  const airlines = [...new Set(it.segments.map((s) => s.airlineName ?? s.airlineCode ?? "?"))];
  const first = it.segments[0];
  const kg = (g: number | null) => (g == null ? null : Math.round(g / 1000));
  return {
    direction,
    from: it.from,
    to: it.to,
    date: shortDate(depDate, locale),
    isoDate: depDate,
    departTime: it.departure.slice(11, 16),
    // "−1" (a minus sign) for an arrival on the calendar day before, across the date line.
    arriveTime: it.arrival.slice(11, 16) + (dayDiff > 0 ? `+${dayDiff}` : dayDiff < 0 ? `−${-dayDiff}` : ""),
    airline: airlines.join(" · "),
    flightNumber: it.segments.map((s) => `${s.airlineCode ?? "?"} ${s.flightNumber ?? "?"}`).join(" / "),
    duration: fmtDur(it.totalDurationMinutes),
    stops: it.stops,
    stopNote: it.layovers.length ? it.layovers.map((l) => `${fmtDur(l.minutes)} in ${l.airport}`).join("; ") : undefined,
    extras: first
      ? {
          aircraft: it.segments.map((s) => s.aircraft).filter(Boolean).join(" / ") || null,
          legroom: first.legroom,
          legroomClass: first.legroomClass,
          wifi: it.segments.every((s) => s.amenities.wifi === "free") ? "free" : it.segments.some((s) => s.amenities.wifi) ? "paid" : null,
          power: it.segments.every((s) => s.amenities.powerAndUsb || s.amenities.usbOnly),
          video: it.segments.every((s) => s.amenities.onDemandVideo),
          overnight: it.segments.some((s) => s.overnight),
          oftenDelayed: it.segments.some((s) => s.oftenDelayed),
          co2Kg: kg(it.co2.grams),
          co2VsTypical: it.co2.percentVsTypical,
          contrail: it.segments.reduce<1 | 2 | 3 | null>((m, s) => (s.contrailWarming != null && (m == null || s.contrailWarming > m) ? s.contrailWarming : m), null),
        }
      : undefined,
  };
}
