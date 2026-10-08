"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { money } from "@/lib/format";
import type { DestinationView, FlightPlan } from "@/lib/types";
import { Button, cx } from "@/components/ui/primitives";
import { rangeLabel } from "@/components/search/dates";
import { Flag } from "./flag";
import { PlanCard } from "./plan-card";
import { NamedAirports, useNamed } from "./plan-details";
import { CardSkeleton } from "./skeleton";
import { shownError } from "@/components/ui/errors";
import { recaptchaHeaders } from "@/components/search/search-client";

const fmtDur = (m: number | null) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${m}m`);

/**
 * Places for an open destination ("anywhere", "somewhere warm"), each with its cheapest fare. A row expands to its flights.
 * Once a place's flights are known (a card above, or an expanded row) their price replaces the list's, so the two agree.
 * With `heading`, the list is collapsed under it by default.
 */
export function Places({
  destinations,
  slug,
  currency,
  locale,
  cards = [],
  heading,
}: {
  destinations: DestinationView[];
  slug: string;
  currency: string;
  locale: string;
  /** Plans shown as cards above the list; a place they fly to shows their price. */
  cards?: FlightPlan[];
  /** Title and subtitle for the collapsible section. Without it the list isn't collapsible (as in a follow-up answer). */
  heading?: { title: string; sub?: string };
}) {
  const named = useNamed();
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [plans, setPlans] = useState<FlightPlan[] | null>(null);
  const [opened, setOpened] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [folded, setFolded] = useState(true);
  // Request counter: only the latest click's response is applied, so a slow older one can't fill the wrong place.
  const req = useRef(0);
  const priced = destinations.filter((d) => d.price != null);
  // Under a heading the user expanded the list, so show all; otherwise show eight and offer the rest.
  const shown = showAll || heading ? priced : priced.slice(0, 8);

  async function load(d: DestinationView) {
    const mine = ++req.current;
    if (openCode === d.code) {
      setOpenCode(null);
      setBusy(false);
      return;
    }
    setOpenCode(d.code);
    setPlans(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/search/${slug}/more`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await recaptchaHeaders("more")) },
        body: JSON.stringify({ destination: d.code, outDate: d.outDate, returnDate: d.returnDate }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Couldn’t load that place");
      if (mine === req.current) {
        const got = data.plans as FlightPlan[];
        setPlans(got);
        if (got.length) setOpened((o) => ({ ...o, [d.code]: Math.min(...got.map((p) => p.price)) }));
      }
    } catch (e) {
      if (mine === req.current) setError(shownError(e, "Couldn’t load that place just now. Try again in a moment."));
    } finally {
      if (mine === req.current) setBusy(false);
    }
  }

  if (!priced.length) return null;
  // When every place shares the same dates, phones hide them per row (the heading shows them) to make room.
  const sameDates = priced.every((d) => d.outDate === priced[0].outDate && d.returnDate === priced[0].returnDate);
  const cheapestLoaded = plans?.length ? Math.min(...plans.map((p) => p.price)) : null;
  const carded = new Map<string, number>();
  for (const p of cards) {
    const to = (p.legs.find((l) => l.direction === "outbound") ?? p.legs[0])?.to;
    if (to) carded.set(to, Math.min(p.price, carded.get(to) ?? Infinity));
  }
  const list = (
      <ul className={cx("flex flex-col divide-y divide-rule", heading ? "border-t border-rule" : "slip overflow-hidden rounded-[24px]")}>
        {shown.map((d, i) => {
          const on = openCode === d.code;
          // Corner rows take the card's radius so their focus ring isn't clipped square.
          const corners = cx(!heading && i === 0 && "rounded-t-[24px]", !on && i === shown.length - 1 && "rounded-b-[24px]");
          const meta = [
            d.stops === 0 ? "Nonstop" : d.stops != null ? `${d.stops} stop${d.stops > 1 ? "s" : ""}` : null,
            fmtDur(d.durationMinutes),
            d.carrierName,
            // Some airports are listed under several names (Saint Paul with Minneapolis, a national park with Denver).
            d.alsoNames?.length ? `also ${d.alsoNames.slice(0, 2).join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={d.code + d.name}>
              <button type="button" onClick={() => load(d)} aria-expanded={on} className={cx("flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors focus-visible:outline-offset-[-2px] sm:gap-4 sm:px-5", corners, on ? "bg-well" : "hover:bg-well")}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Flag country={d.country} size={16} />
                    <span className="line-clamp-2 text-[15.5px] font-semibold break-words text-ink">{d.name}</span>
                    <span className="nums shrink-0 text-[12px] text-ink-muted max-sm:hidden">{d.code}</span>
                  </span>
                  {d.why && <span className="words truncate text-[14.5px] text-ink">{d.why}</span>}
                  {meta && <span className="truncate text-[12.5px] text-ink-muted max-sm:line-clamp-2 max-sm:whitespace-normal">{meta}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="nums text-[17px] font-semibold tracking-[-0.02em] text-ink">{money(carded.get(d.code) ?? opened[d.code] ?? d.price!, currency, locale)}</span>
                  {d.outDate && <span className={cx("nums text-[12px] text-ink-muted", sameDates && "max-sm:hidden")}>{rangeLabel(d.outDate, d.returnDate, locale)}</span>}
                </span>
                <ChevronDown className={cx("h-4 w-4 shrink-0 text-ink-muted transition-transform duration-300 max-sm:hidden", on && "rotate-180")} strokeWidth={2} />
              </button>
              <div className="grow" data-open={on}>
                <div>
                  {on && (
                    <div className="flex flex-col gap-3 bg-well px-2 pt-1 pb-4 sm:px-5" aria-live="polite">
                      {busy && <CardSkeleton count={1} compact />}
                      {error && <p className="text-[14px] text-warn">{error}</p>}
                      {plans && plans.length === 0 && <p className="text-[14px] text-ink-muted">No flights there right now.</p>}
                      {/* This place counts as the requested destination, so flights into another airport are flagged. */}
                      <NamedAirports named={{ from: named?.from ?? [], to: [d.code] }}>
                        {plans?.map((p) => (
                          <PlanCard key={p.id} plan={p} cheapest={cheapestLoaded} slug={slug} locale={locale} compact />
                        ))}
                      </NamedAirports>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
  );
  if (heading)
    return (
      <section className="slip overflow-hidden rounded-[24px]">
        <button
          type="button"
          onClick={() => setFolded((f) => !f)}
          aria-expanded={!folded}
          className={cx("flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-well focus-visible:outline-offset-[-2px] sm:px-5", folded ? "rounded-[24px]" : "rounded-t-[24px]")}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="display text-[20px] leading-tight font-semibold text-ink sm:text-[22px]">{heading.title}</span>
            {heading.sub && <span className="text-[13.5px] text-ink-muted">{heading.sub}</span>}
          </span>
          <span className="nums shrink-0 text-[13.5px] font-semibold text-ink-muted">
            {priced.length} place{priced.length === 1 ? "" : "s"}
          </span>
          <ChevronDown className={cx("h-4 w-4 shrink-0 text-ink-muted transition-transform duration-300", !folded && "rotate-180")} strokeWidth={2} />
        </button>
        <div className="grow" data-open={!folded}>
          <div>{list}</div>
        </div>
      </section>
    );
  return (
    <div className="flex flex-col gap-3">
      {list}
      {priced.length > shown.length && (
        <Button variant="secondary" size="sm" onClick={() => setShowAll(true)} className="self-center pointer-coarse:h-11">
          Show all {priced.length} places
        </Button>
      )}
    </div>
  );
}
