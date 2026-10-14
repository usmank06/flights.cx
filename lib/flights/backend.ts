import type { CabinClass, UnencodedField } from "@/lib/types";
import type { FlightsError } from "./errors";
import type { DatePricePoint, ExploreDestination, Itinerary, PlaceHit, SearchInput, ShoppingPayload } from "./types";

/**
 * What the engine passes a provider with each call. The engine calls once and waits. Asking again, hedging, polling a
 * calendar until it settles and time limits all happen inside the provider, with its own numbers (`lib/flights/retry.ts` is
 * the shared loop).
 */
export type CallOptions = {
  /** The caller's clock: when it stops waiting. A call stopped by it throws. */
  signal?: AbortSignal;
  /** Called once per request sent, for the search's count. */
  onAsk?: () => void;
  /** Called with the error when an ask fails and the provider is about to ask again. */
  onRetry?: (why: FlightsError) => void;
  /** A line for the search's log about how the call is going ("55 of 100, asking again to make sure that's all"). */
  note?: (text: string) => void;
  /** Calendars: called with what an ask returned while the calendar is still filling in, so the caller can act on it early. */
  onProgress?: (points: DatePricePoint[]) => void;
};

export type ExploreOptions = CallOptions & {
  /** Fixed dates, or null for a week-long trip in the next few months. */
  dates?: { out: string; ret: string | null } | null;
  /** [adults, children, infants in seat, infants on lap] */
  passengers?: [number, number, number, number];
  seat?: CabinClass;
  currency?: string;
  carryOnBags?: number;
  checkedBags?: number;
};

/** A calendar answer: its points, and whether the provider saw it settle. */
export type Calendar = {
  points: DatePricePoint[];
  /** False when the provider gave up with the calendar still changing. What it holds is still returned. */
  settled: boolean;
};

/** How long the engine waits for a fare's flights home and for long stays. A provider can set these to suit its answers. */
export type ProviderTiming = {
  /** How long a fare's flights home are waited for once asked. */
  returnsWaitMs: number;
  /** Extra wait for the calendars of stays the grid can't price, after the rest of their stage. */
  longStaysGraceMs: number;
};

/**
 * Where a search gets its flights. Only `shopping` is required. Without one of the other methods, that feature is off and the
 * search goes on without it (no date grid, no Explore, no place lookup). Every call asks again on its own until it answers or
 * `signal` stops it, then throws a FlightsError. The live provider, the fallback and the demo market (lib/search/demo.ts) all
 * implement this, and nothing past lib/flights/provider.ts knows which one answers.
 */
export interface FlightBackend {
  /** The provider's name as the page shows it. */
  readonly name: string;
  /** False when the fares are invented. */
  readonly live: boolean;
  readonly timing?: Partial<ProviderTiming>;
  /** Itineraries for one query, with price insights and cheaper-date and nearby-airport hints when the provider has them. */
  shopping(input: SearchInput, opts?: CallOptions): Promise<ShoppingPayload>;
  /** Return flights for a chosen outbound, each priced as the round-trip total. */
  returns?(input: SearchInput, outbound: { segments: Itinerary["segments"]; bookingToken?: string | null }, opts?: CallOptions): Promise<ShoppingPayload>;
  /** A round-trip price for every pair of days in two windows. */
  dateGrid?(input: SearchInput, outWindow: [string, string], returnWindow: [string, string], opts?: CallOptions): Promise<Calendar>;
  /** The cheapest fare per departure day at a fixed trip length. */
  priceGraph?(input: SearchInput, range: [string, string], tripDays: [number, number], opts?: CallOptions): Promise<Calendar>;
  /** Destinations priced from an origin. */
  explore?(origin: string, opts: ExploreOptions): Promise<ExploreDestination[]>;
  /** Places matching some text. */
  places?(text: string, opts?: CallOptions): Promise<PlaceHit[]>;
  /** Request fields this backend can't send, so the page and the write-up can say so. Absent or empty when everything is sent. */
  declareUnencoded?(input: SearchInput): UnencodedField[];
  /** Whether a query can be asked of it at all (endpoints it knows, trip shapes it offers). Absent: every query. */
  covers?(input: SearchInput): boolean;
}

/** Place ids start with "/" so they can't be mistaken for an airport code. */
export const isPlaceId = (endpoint: string): boolean => endpoint.startsWith("/");
