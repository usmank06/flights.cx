import type { Bags, CabinClass, Passengers } from "@/lib/types";

/**
 * The flight data model. A provider parses its own answers into these shapes, and nothing past the provider sees anything else.
 */

/** One leg of a query. */
export interface Leg {
  /** YYYY-MM-DD, local to the departure airport. */
  date: string;
  /** An IATA code, or a place id that covers several airports (`isPlaceId`). */
  from_airport: string;
  to_airport: string;
  /** 0 is nonstop only. */
  max_stops?: number;
}

/** One query: one leg for a one-way, two for a round trip. */
export interface SearchInput {
  flights: Leg[];
  seat?: CabinClass;
  trip?: "round-trip" | "one-way" | "multi-city";
  passengers?: { adults?: number; children?: number; infants_in_seat?: number; infants_on_lap?: number };
  /** In `currency`. */
  max_price?: number;
  carry_on_bags?: number;
  checked_bags?: number;
  /** A language tag, e.g. "en". */
  language?: string;
  /** ISO 4217, e.g. "USD". */
  currency?: string;
}

export type WifiKind = "free" | "paid";

export interface Amenities {
  powerAndUsb: boolean;
  usbOnly: boolean;
  onDemandVideo: boolean;
  wifi: WifiKind | null;
}

export interface Segment {
  from: { code: string; name: string };
  to: { code: string; name: string };
  /** YYYY-MM-DDTHH:MM, local to the airport. */
  departure: string;
  arrival: string;
  durationMinutes: number;
  aircraft: string | null;
  airlineCode: string | null;
  flightNumber: string | null;
  airlineName: string | null;
  /** e.g. "31 inches". */
  legroom: string | null;
  /** 1 average, 2 below average, 3 above average. */
  legroomClass: 1 | 2 | 3 | null;
  co2Grams: number | null;
  /** Contrail warming potential: 1 low, 2 medium, 3 high. */
  contrailWarming: 1 | 2 | 3 | null;
  amenities: Amenities;
  overnight: boolean;
  oftenDelayed: boolean;
}

export interface Layover {
  airport: string;
  minutes: number;
  airportName: string | null;
  city: string | null;
}

export interface Itinerary {
  /** Listed among the provider's best flights. */
  isBest: boolean;
  /** In the requested currency; null when there is no price. */
  price: number | null;
  /** The provider's id for this fare, when it has one. */
  bookingToken: string | null;
  /** IATA code, or "multi" when the segments mix carriers. */
  airlineCode: string;
  airlineNames: string[];
  from: string;
  to: string;
  departure: string;
  arrival: string;
  /** Includes layovers. */
  totalDurationMinutes: number;
  stops: number;
  segments: Segment[];
  layovers: Layover[];
  co2: {
    grams: number | null;
    typicalGrams: number | null;
    lowestOnRouteGrams: number | null;
    percentVsTypical: number | null;
  };
  /** Carry-on bags the fare includes. */
  carryOnIncluded: number | null;
  /** Checked bags the price includes. 0 means a requested bag's fee is not in the price. */
  checkedIncluded?: number | null;
  /** Sold as two separate tickets, so a single booking link can't buy it. */
  separateTickets?: true;
  /** The provider the fare came from when it isn't the live one, named as the page shows it. */
  provider?: string;
  /** That provider's own link for booking this fare, as its ticket. */
  bookingUrl?: string | null;
}

/** How today's price compares with the usual range for the route. */
export interface PriceInsights {
  /** 2 or 3 is typical, 5 is high; other codes are unknown. */
  levelCode: number | null;
  level: "typical" | "high" | null;
  current: number | null;
  typical: number | null;
  low: number | null;
  high: number | null;
  /** Daily prices, oldest first. */
  history: { at: number; price: number }[];
}

/** Nearby dates the provider says are cheaper. */
export interface DateHint {
  outDate: string;
  returnDate: string | null;
  price: number | null;
  token: string | null;
  /** Days moved from the request, [outbound, return]. */
  shift: [number, number] | null;
}

/** A nearby airport the provider says is cheaper. */
export interface AirportHint {
  code: string;
  /** True when the swap is at the departure end. */
  departure: boolean;
  price: number | null;
  token: string | null;
}

/** An airport named in an answer, with a photo of its city. */
export interface PlaceInfo {
  code: string;
  name: string;
  city: string | null;
  image: string | null;
}

export interface ShoppingPayload {
  itineraries: Itinerary[];
  places?: PlaceInfo[];
  insights: PriceInsights | null;
  dateHints: DateHint[];
  airportHints: AirportHint[];
  /** The answering provider's name, when it isn't the live one. */
  provider?: string;
}

/** One cell of a date grid, or one day of a price graph. */
export interface DatePricePoint {
  outDate: string;
  /** Null on a one-way. */
  returnDate: string | null;
  price: number | null;
  bookingToken?: string;
}

/** A destination the provider prices from an origin, with its cheapest fare. */
export interface ExploreDestination {
  /** The provider's place id. */
  id: string;
  name: string;
  country: string | null;
  /** The airport the fare flies into. */
  code: string | null;
  lat: number | null;
  lon: number | null;
  price: number | null;
  token: string | null;
  carrierCode: string | null;
  carrierName: string | null;
  stops: number | null;
  durationMinutes: number | null;
  /** The dates the price is for. */
  outDate: string | null;
  returnDate: string | null;
  image: string | null;
}

/** A place matched from typed text: a city with the airports it covers, or one airport. */
export interface PlaceHit {
  kind: "city" | "airport";
  name: string;
  /** The provider's place id, usable as a leg endpoint. */
  id: string;
  /** The airport's code, for an airport. */
  code: string | null;
  /** A city's airports, nearest first, with the distance in km. */
  airports: { code: string; name: string; km: number | null }[];
}

/** The trip details a booking link carries besides the flights. */
export type BookingContext = {
  passengers: Passengers;
  cabin: CabinClass;
  bags: Bags;
  currency: string;
  /** A language tag, e.g. "en". */
  language: string;
};

/**
 * What a booking link is for. `outbound` is passed separately; at most one of `ret`, `rtReturn` and `returnDate` is set.
 */
export type BookingOptions = {
  /** The second ticket of a two-ticket plan. */
  ret?: Itinerary;
  /** The return flights paired with a round-trip fare. */
  rtReturn?: Itinerary;
  /** A round-trip fare whose return is chosen on the booking page. */
  returnDate?: string | null;
  /** An open-jaw fare: the airport the return leaves from. */
  backFrom?: string | null;
  ctx: BookingContext;
};
