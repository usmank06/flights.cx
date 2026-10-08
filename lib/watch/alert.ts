import { priceAlertEmail } from "@/lib/email/templates";
import { dayRange, money } from "@/lib/format";
import { placeLabel } from "@/lib/search/intake";
import { CABIN_LABEL, describePassengers, type FlightPlan, type SearchRequest } from "@/lib/types";
import type { PriceWatch } from "./types";

/**
 * Price alert text. Each alert names its trip by dates, plus travellers and cabin when not one adult in economy, so alerts for
 * different trips on one route are distinguishable.
 */

/** Short trip description: "Nov 10 – 17" or "Nov 10, one way", then "2 adults" and "Business" when not the default. */
export function tripWords(r: SearchRequest): string[] {
  const words: string[] = [];
  if (r.departDate) words.push(r.returnDate ? dayRange(r.departDate, r.returnDate, r.locale) : `${dayRange(r.departDate, null, r.locale)}, one way`);
  const p = r.passengers;
  if (p.adults !== 1 || p.children || p.infantsInSeat || p.infantsOnLap) words.push(describePassengers(p));
  if (r.cabin && r.cabin !== "economy") words.push(CABIN_LABEL[r.cabin]);
  return words;
}

/**
 * One line per direction: "Out: British Airways · nonstop · 7h 10m". A round trip whose return is chosen at booking gets only the
 * outbound line.
 */
export function flightLines(plan: Pick<FlightPlan, "legs"> | null | undefined, roundTrip: boolean): string[] {
  if (!plan?.legs.length) return [];
  return plan.legs.slice(0, 2).map((leg) => {
    const parts = [leg.airline, leg.stops === 0 ? "nonstop" : `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`, leg.duration].filter(Boolean);
    return `${roundTrip ? (leg.direction === "return" ? "Back: " : "Out: ") : ""}${parts.join(" · ")}`;
  });
}

/** "New York → London". */
export const routeOf = (r: SearchRequest): string => `${placeLabel(r.from)} → ${placeLabel(r.to)}`;

export type PriceAlert = { subject: string; text: string; html: string };

export function priceAlert({
  watch,
  request,
  price,
  plan,
  url,
  stopUrl,
}: {
  watch: Pick<PriceWatch, "trigger" | "referencePrice" | "lastNotifiedPrice" | "currency" | "locale">;
  /** The watched search's request, or null when it has gone. */
  request: SearchRequest | null;
  price: number;
  /** The plan at that price, for the flight lines; null if unavailable. */
  plan?: Pick<FlightPlan, "legs"> | null;
  url: string;
  stopUrl: string;
}): PriceAlert {
  const route = request ? routeOf(request) : "Your trip";
  const trip = request ? tripWords(request) : [];
  const previous = watch.lastNotifiedPrice ?? watch.referencePrice;
  const delta = previous - price;
  const fmt = (n: number) => money(n, watch.currency, watch.locale);
  const target = watch.trigger.kind === "target" ? watch.trigger.price : null;

  const moved = delta > 0 ? `is down to ${fmt(price)}` : delta < 0 ? `has gone up to ${fmt(price)}` : `is ${fmt(price)}`;
  // Target alerts name the target, so they don't read like change alerts.
  const targetText = target != null && price <= target ? `${price < target ? "Below" : "At"} your ${fmt(target)} target` : null;
  const subject = `${route}${trip.length ? ` (${trip.join(", ")})` : ""} ${moved}${targetText ? `, ${targetText.charAt(0).toLowerCase()}${targetText.slice(1)}` : ""}`;

  const mail = priceAlertEmail({
    route,
    trip: trip.join(" · "),
    headline: subject,
    price: fmt(price),
    delta,
    was: delta !== 0 ? fmt(previous) : null,
    deltaText: delta !== 0 ? `${delta > 0 ? "Down" : "Up"} ${fmt(Math.abs(delta))}` : null,
    targetText,
    sinceText: watch.referencePrice !== previous ? `It was ${fmt(watch.referencePrice)} when you started tracking.` : null,
    flights: flightLines(plan, Boolean(request?.returnDate)),
    url,
    stopUrl,
  });
  return { subject, ...mail };
}
