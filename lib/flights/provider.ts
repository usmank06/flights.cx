import type { PlanBooking } from "@/lib/types";
import type { FlightBackend } from "./backend";
import type { BookingOptions, Itinerary } from "./types";

/**
 * The live flight data provider. This version doesn't include one, so these are placeholders: every search runs on the demo
 * market (lib/search/demo.ts) and Book opens a placeholder link.
 *
 * To use real fares, return a FlightBackend (lib/flights/backend.ts) backed by a flight data API from liveBackend(), and build
 * that provider's booking links in bookingFor(). Settings it needs at build time go in provider-config.ts.
 */

/** The live backend, or null to use the demo market. */
export function liveBackend(): FlightBackend | null {
  return null;
}

/** The link the Book button opens for a plan. */
export function bookingFor(outbound: Itinerary, opts: BookingOptions): PlanBooking {
  const link = (it: Itinerary, returnDate?: string | null) => {
    const url = new URL("https://example.com/flights");
    url.searchParams.set("from", it.from);
    url.searchParams.set("to", it.to);
    url.searchParams.set("date", it.departure.slice(0, 10));
    if (returnDate) url.searchParams.set("return", returnDate);
    return url.toString();
  };
  const token = outbound.bookingToken ?? null;
  if (opts.ret) return { url: link(outbound), returnUrl: link(opts.ret), precision: "route", token };
  return { url: link(outbound, opts.rtReturn?.departure.slice(0, 10) ?? opts.returnDate), precision: "route", token };
}
