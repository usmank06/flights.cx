import type { CabinClass, UnencodedField } from "@/lib/types";
import type { DatePricePoint, ExploreDestination, Itinerary, PlaceHit, SearchInput, ShoppingPayload } from "./types";

/** Per-call hints from the engine. A provider may ignore any of them. */
export type CallOptions = {
  signal?: AbortSignal;
  /** Time limit for one request. */
  timeoutMs?: number;
  /** Send the same request again if the first hasn't answered after this long. */
  hedgeMs?: number;
  /** Attempts before giving up. */
  attempts?: number;
  /** How long a calendar may be polled while it fills in. */
  settleMs?: number;
  /** Stop polling a calendar once it holds this many prices and stops growing. */
  enough?: number;
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

/** Where a search gets its flights. The live provider and the demo market both implement this. */
export interface FlightBackend {
  /** False when the fares are invented. */
  readonly live: boolean;
  /** Itineraries for one query, with price insights and cheaper-date and nearby-airport hints. */
  shopping(input: SearchInput, opts?: CallOptions): Promise<ShoppingPayload>;
  /** Return flights for a chosen outbound, each priced as the round-trip total. */
  returns(input: SearchInput, outbound: { segments: Itinerary["segments"]; bookingToken?: string | null }, opts?: CallOptions): Promise<ShoppingPayload>;
  /** A round-trip price for every pair of days in two windows. */
  dateGrid(input: SearchInput, outWindow: [string, string], returnWindow: [string, string], opts?: CallOptions): Promise<DatePricePoint[]>;
  /** The cheapest fare per departure day at a fixed trip length. */
  priceGraph(input: SearchInput, range: [string, string], tripDays: [number, number], opts?: CallOptions): Promise<DatePricePoint[]>;
  /** Destinations priced from an origin. */
  explore(origin: string, opts: ExploreOptions): Promise<ExploreDestination[]>;
  /** Places matching some text. */
  places(text: string, opts?: CallOptions): Promise<PlaceHit[]>;
  /** Request fields this backend can't send, so the page and the write-up can say so. Empty when everything was sent. */
  declareUnencoded(input: SearchInput): UnencodedField[];
}

/** Place ids start with "/" so they can't be mistaken for an airport code. */
export const isPlaceId = (endpoint: string): boolean => endpoint.startsWith("/");
