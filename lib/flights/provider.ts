import type { PlanBooking } from "@/lib/types";
import type { FlightBackend } from "./backend";
import type { BookingOptions, Itinerary } from "./types";

/**
 * The flight data providers. This version doesn't include any, so these are placeholders: every search runs on the demo
 * market (lib/search/demo.ts) and Book opens a placeholder link.
 *
 * To use real fares, return a FlightBackend (lib/flights/backend.ts) backed by a flight data API from liveBackend(), and build
 * its booking links in liveBooking(). Only `shopping` is required; a feature the API doesn't have stays off. A second provider
 * that only has fares can answer when the live one fails, through fallbackBackend(). Build-time settings go in
 * provider-config.ts.
 */

/** The provider every search asks, or null to use the demo market. */
export function liveBackend(): FlightBackend | null {
  return null;
}

/** For the fallback: the airports a place id covers, from whoever resolved it. */
export type FallbackOptions = { airportsOf?: (placeId: string) => string[] | null | undefined };

/** The fares-only provider asked when the live one fails, or null when there is none. */
export const fallbackBackend: (opts?: FallbackOptions) => FlightBackend | null = () => null;

/** The live provider's link for a plan. The placeholder opens example.com with the route and dates. */
function liveBooking(outbound: Itinerary, opts: BookingOptions): PlanBooking {
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

/** The link the Book button opens. A fare from another provider books on that provider's own link, as its ticket. */
export function bookingFor(outbound: Itinerary, opts: BookingOptions): PlanBooking {
  const own = (it: Itinerary | undefined) => (it?.provider && it.bookingUrl ? { url: it.bookingUrl, site: it.provider } : null);
  if (opts.ret) {
    // Two tickets, each on its own link. A ticket without one gets the live provider's.
    const a = own(outbound);
    const b = own(opts.ret);
    if (!a && !b) return liveBooking(outbound, opts);
    const live = a && b ? null : liveBooking(outbound, opts);
    return {
      url: a?.url ?? live!.url,
      returnUrl: b?.url ?? live!.returnUrl,
      precision: live?.precision ?? "booking",
      token: outbound.bookingToken ?? null,
      ...(a ? { site: a.site } : {}),
      ...(b ? { returnSite: b.site } : {}),
    };
  }
  // One ticket: the flight home's own link when another provider supplied it, else the outbound's, else the live provider's.
  const link = own(opts.rtReturn) ?? own(outbound);
  return link ? { url: link.url, precision: "booking", site: link.site, token: outbound.bookingToken ?? null } : liveBooking(outbound, opts);
}
