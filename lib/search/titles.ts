import { dayRange, money } from "@/lib/format";
import type { FlightPlan, SearchRecord, SearchRequest } from "@/lib/types";
import { hintLabel, placeLabel } from "./intake";

/**
 * Titles for a search (browser tab, link preview, share sheet). A search typed in words has no route until its plan returns, and
 * a shared record omits the words (`publicRecord`), so until then the title is "Searching".
 */

/** "Mar 10 – 24", "Mar 10" for a one-way, "" with no dates. In the search's own locale. */
export function rangeText(req: SearchRequest): string {
  return req.departDate ? dayRange(req.departDate, req.returnDate, req.locale || "en-US") : "";
}

/** "Chicago → Lisbon or Porto", from the plan when there is one; "" when nothing names the trip yet. */
export function routeText(record: Pick<SearchRecord, "plan" | "request">): string {
  const { plan, request } = record;
  const names = (xs: { name: string }[]) => [...new Set(xs.map((x) => x.name))].join(" or ");
  // For an open destination, show the traveller's words. A city named in them may be the origin or a nearby place.
  if (plan) return `${names(plan.origins)} → ${plan.destinations.length ? names(plan.destinations) : hintLabel(plan.openHint ?? request.to) || "Anywhere"}`;
  if (request.from && request.to) return `${placeLabel(request.from)} → ${placeLabel(request.to)}`;
  const words = (request.brief ?? request.to ?? "").trim();
  return words.length > 48 ? `${words.slice(0, 46).replace(/\s+\S*$/, "")}…` : words;
}

/** Shifts a YYYY-MM-DD date by `n` days, computed at noon UTC so timezones can't roll it over. */
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A plan's own dates, which can differ from the asked dates on a flexible search. A price is always shown with its dates. */
function datesOf(plan: FlightPlan, req: SearchRequest): { out: string | null; ret: string | null } {
  const out = plan.legs?.find((l) => l.direction === "outbound")?.isoDate ?? (req.departDate && shiftDay(req.departDate, plan.dateShift?.out ?? 0));
  const back = plan.legs?.find((l) => l.direction === "return")?.isoDate ?? (req.returnDate && shiftDay(req.returnDate, plan.dateShift?.ret ?? 0));
  return { out: out || null, ret: back || null };
}

/** Price and dates for a title: the cheapest plan's, else the asked dates with no price. */
export function titleDates(record: Pick<SearchRecord, "plans" | "request">): { when: string; best: number | null } {
  const req = record.request;
  const cheapest = record.plans?.length ? record.plans.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  if (!cheapest) return { when: rangeText(req), best: null };
  const d = datesOf(cheapest, req);
  return { when: d.out ? dayRange(d.out, d.ret, req.locale || "en-US") : rangeText(req), best: cheapest.price };
}

/** Tab title: route, dates and price. Once priced, the dates are the cheapest plan's. */
export function searchTitle(record: SearchRecord): string {
  const route = routeText(record);
  const { when, best } = titleDates(record);
  if (record.status === "running") return route ? `Searching ${route}` : "Searching";
  return [route || "A trip", when, best != null ? `from ${money(best, record.request.currency, record.request.locale)}` : null].filter(Boolean).join(" · ");
}
