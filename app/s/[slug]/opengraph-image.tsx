import { ImageResponse } from "next/og";
import { AIRPORTS } from "@/lib/airports";
import { money } from "@/lib/format";
import { isOpenDestination, placeLabel, resolveAirport } from "@/lib/search/intake";
import { titleDates } from "@/lib/search/titles";
import { store } from "@/lib/store";
import type { SearchRecord } from "@/lib/types";
import { drawable, OG_SIZE, ogFonts, SearchCard, SiteCard } from "@/components/site/og";

export const alt = "A flight search on flights.cx";
export const size = OG_SIZE;
export const contentType = "image/png";

type End = { code: string; name: string };

const cityOf = (code: string) => AIRPORTS[code]?.city ?? code;
const joined = (ends: End[]): End => ({ code: [...new Set(ends.map((e) => e.code))].slice(0, 2).join("/"), name: [...new Set(ends.map((e) => e.name))].join(" or ") });

/** The trip's two ends: from the plan, else from the first flight found, else from the places as typed. */
function endsOf(record: SearchRecord): { from: End; to: End } | null {
  const { plan, request: req } = record;
  if (plan?.origins.length) {
    const from = joined(plan.origins.map((o) => ({ code: o.code, name: o.name || cityOf(o.code) })));
    const to = plan.destinations.length ? joined(plan.destinations.map((d) => ({ code: d.code, name: d.name || cityOf(d.code) }))) : { code: "", name: placeLabel(plan.openHint ?? req.to) || "Anywhere" };
    return { from, to };
  }
  const out = record.plans?.[0]?.legs[0];
  const fromCode = out?.from ?? resolveAirport(req.from);
  if (!fromCode) return null;
  const from = { code: fromCode, name: cityOf(fromCode) };
  if (isOpenDestination(req.to)) return { from, to: { code: "", name: placeLabel(req.to) || "Anywhere" } };
  const toCode = out?.to ?? resolveAirport(req.to);
  return toCode ? { from, to: { code: toCode, name: cityOf(toCode) } } : null;
}

/**
 * Link preview for a search: route, dates and best price in the search's currency (no price while running or if nothing was found).
 * Falls back to the site card for unknown searches, and to English when the card can't draw the locale's text (`drawable`).
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const [record, fonts] = await Promise.all([(await store()).getPublic((await params).slug).catch(() => null), ogFonts()]);
  const ends = record ? endsOf(record) : null;
  if (!record || !ends) return new ImageResponse(<SiteCard />, { ...size, fonts });
  // Use the best fare's dates, so a flexible search doesn't show the requested dates next to a fare for other days.
  const words = (locale: string) => {
    const request = { ...record.request, locale };
    const { when, best } = titleDates({ plans: record.plans, request });
    return { when, price: best != null ? money(best, request.currency, locale) : null };
  };
  let { when, price } = words(record.request.locale);
  if (!drawable(`${when}${price ?? ""}`)) ({ when, price } = words("en-US"));
  return new ImageResponse(
    <SearchCard from={ends.from.code} to={ends.to.code} fromName={ends.from.name} toName={ends.to.name} when={when} price={price} />,
    { ...size, fonts }
  );
}
