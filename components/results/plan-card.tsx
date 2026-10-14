"use client";

import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { money } from "@/lib/format";
import type { FlightLeg, FlightPlan } from "@/lib/types";
import { Button, cx } from "@/components/ui/primitives";
import { dayLabel } from "@/components/search/dates";
import { AirlineLogos } from "./airline-logo";
import { useDetails, useNamed } from "./plan-details";
import { countryName } from "@/lib/countries";
import { Flag } from "./flag";
import { bookLabel, carrierCodes, cautions, isPaired, layovers, longLayover, recordBookClick, returnIso, returnToPick, splitRouteNote, stopsLabel, type Place } from "./plan-meta";
import { Time } from "./time";

/**
 * A plan as a boarding pass: the summary and one row per flight on the pass, the price and Book on the stub past a tear line.
 * Laid out by container width: the stub sits beside the pass from 47rem (200px stub, padding, 32rem of flights), else below it.
 * `compact` drops the summary and the tear-line notches (`.ticket-bites` in globals.css). Clicking the card opens the details.
 */

/** One flight row: carrier and date, times and airports, duration and stops. */
function LegLine({ leg, eager, locale }: { leg: FlightLeg; eager: boolean; locale: string }) {
  const codes = carrierCodes(leg);
  const names = leg.airline.split(" · ");
  const date = leg.isoDate ? dayLabel(leg.isoDate, locale) : leg.date;
  const stops = layovers(leg);
  const long = stops.some((x) => longLayover(x.dur));
  return (
    // When narrow, duration and stops wrap under the times. Sized by container width because the date grid's pane
    // is narrow even on wide screens.
    <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 py-3 @lg:grid-cols-[34px_150px_minmax(0,1fr)_auto] @lg:gap-x-5">
      {/* Two 16px logos fit side by side in the 34px column. */}
      <span className="row-span-3 flex justify-center @lg:row-span-1">{codes.length > 0 && <AirlineLogos codes={codes} names={names} size={codes.length > 1 ? 16 : 30} eager={eager} />}</span>
      <span className="flex min-w-0 flex-col">
        <span className="nums truncate text-[13.5px] font-semibold text-ink">{date}</span>
        <span className="truncate text-[12.5px] text-ink-muted">{leg.airline}</span>
      </span>
      <span className="col-start-2 row-start-2 flex min-w-0 flex-col @lg:col-start-3 @lg:row-start-1">
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <Time value={leg.departTime} locale={locale} size={18} />
          <span className="text-[13px] text-ink-faint" aria-hidden>
            →
          </span>
          <Time value={leg.arriveTime} locale={locale} size={18} />
        </span>
        <span className="nums text-[12px] text-ink-muted">
          {leg.from} → {leg.to}
        </span>
      </span>
      <span className="col-start-2 row-start-3 flex flex-wrap items-baseline gap-x-1.5 @lg:col-start-4 @lg:row-start-1 @lg:flex-col @lg:items-end @lg:text-right">
        <span className="nums text-[13px] font-medium text-ink-soft">{leg.duration}</span>
        <span className="text-[12.5px] text-ink-faint @lg:hidden" aria-hidden>
          ·
        </span>
        <span className={cx("text-[12.5px] font-medium whitespace-nowrap", leg.stops === 0 ? "text-good" : long ? "text-warn" : "text-ink-muted")}>
          {leg.stops === 0 ? "Nonstop" : `${stopsLabel(leg.stops)} · ${stops.map((x) => x.code).filter(Boolean).join(", ")}`}
        </span>
      </span>
    </div>
  );
}

/** Return row for a round-trip fare with no return leg. The flight home is chosen at booking; the price covers the cheapest. */
function ReturnToPick({ plan, locale }: { plan: FlightPlan; locale: string }) {
  const iso = returnIso(plan);
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 py-3 @lg:grid-cols-[34px_150px_minmax(0,1fr)] @lg:gap-x-5">
      <span className="flex justify-center">
        <span className="h-7 w-7 rounded-lg border-[1.5px] border-dashed border-rule-strong" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="nums text-[13.5px] font-semibold text-ink">{iso ? dayLabel(iso, locale) : (plan.returnDate ?? "Return")}</span>
        <span className="text-[12.5px] text-ink-muted">Flight home</span>
      </span>
      <span className="col-start-2 text-[13px] leading-snug text-ink-muted @lg:col-start-auto">The price includes the cheapest flight home. You’ll choose yours when you book.</span>
    </div>
  );
}

/** Card title for an open-destination plan: flag, city, and muted country ("Cancún Mexico"). */
function PlaceTitle({ place }: { place: Place }) {
  const country = place.country && /^[A-Za-z]{2}$/.test(place.country) ? countryName(place.country) : place.country;
  return (
    <p className="flex min-w-0 items-center gap-2.5">
      <Flag country={place.country} size={22} />
      <span className="display min-w-0 truncate text-[20px] leading-tight font-semibold text-ink sm:text-[22px]">{place.name}</span>
      {country && country !== place.name && <span className="shrink-0 text-[14.5px] text-ink-muted">{country}</span>}
    </p>
  );
}

function Tag({ tone, children }: { tone: "good" | "quiet" | "warn"; children: React.ReactNode }) {
  const t = { good: "bg-good-soft text-good", quiet: "bg-soft text-ink-soft", warn: "bg-warn-soft text-warn" }[tone];
  return <span className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] font-semibold whitespace-nowrap", t)}>{children}</span>;
}

export function PlanCard({
  plan,
  cheapest,
  saved = null,
  slug,
  locale,
  index = 0,
  compact = false,
  place = null,
}: {
  plan: FlightPlan;
  /** The cheapest price among the plans shown with this one; null when it stands alone. */
  cheapest: number | null;
  /** Savings versus the requested dates, shown on the cheapest plan. */
  saved?: number | null;
  slug: string;
  locale: string;
  index?: number;
  compact?: boolean;
  /** Destination title for open searches ("Anywhere warm"), where airport codes alone aren't enough. */
  place?: Place | null;
}) {
  const { open } = useDetails();
  const named = useNamed();
  const out = plan.legs.find((l) => l.direction === "outbound") ?? plan.legs[0];
  const back = plan.legs.find((l) => l.direction === "return");
  const isCheapest = cheapest != null && plan.price <= cheapest;
  const price = money(plan.price, plan.currency, locale);
  const trip = back || plan.roundTripFare ? "Round trip" : "One way";
  const showOpen = () => open(plan, { slug, locale, cheapest, saved, named });
  const { text: line } = splitRouteNote(plan.summary);
  const tags: { tone: "good" | "quiet" | "warn"; text: string }[] = [
    ...(isCheapest && saved != null && saved > 0 ? [{ tone: "good" as const, text: `${money(saved, plan.currency, locale)} under your dates` }] : []),
    ...cautions(plan, named).map((c) => ({ tone: c === "2 tickets" || /\bvia /.test(c) ? ("quiet" as const) : ("warn" as const), text: c })),
  ];

  const detailsClass =
    "press pointer-events-auto relative z-20 h-9 items-center justify-center rounded-full px-3.5 text-[13.5px] font-semibold text-ink-soft hover:bg-soft hover:text-ink pointer-coarse:h-11";
  const bookClass =
    "btn-primary press pointer-events-auto relative z-20 inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[14.5px] font-semibold @[47rem]/card:w-full";
  const bookInner = (
    <>
      {bookLabel(plan)}
      <ArrowRight className="h-4 w-4" strokeWidth={2.4} aria-hidden />
    </>
  );
  const book = isPaired(plan) ? (
    <button type="button" onClick={showOpen} className={bookClass}>
      {bookInner}
    </button>
  ) : (
    <a href={plan.booking.url} target="_blank" rel="noopener noreferrer" onClick={() => recordBookClick(slug, plan.id, plan.booking.precision)} className={bookClass}>
      {bookInner}
    </a>
  );

  return (
    <article
      className={cx("@container/card ticket group relative rounded-[24px] transition-[filter,translate] duration-300 ease-[var(--ease-out)] hover:-translate-y-0.5", !compact && "rise")}
      style={{ animationDelay: `${index * 80}ms` } as CSSProperties}
    >
      <div className={cx("relative overflow-hidden rounded-[24px] bg-paper shadow-[inset_0_0_0_1px_var(--color-rule)]", !compact && "ticket-bites")}>
        {/* Full-card hit area for the details, under Details and Book. Inset focus ring, since the card clips overflow. */}
        <button
          type="button"
          onClick={showOpen}
          aria-label={`${place ? `${place.name}: ` : ""}${line || "This way to fly it"}, ${price}. Show the details`}
          className="absolute inset-0 z-0 cursor-pointer rounded-[24px] focus-visible:outline-offset-[-3px]"
        />
        <div className="pointer-events-none relative z-10 flex flex-col @[47rem]/card:flex-row">
          {/* The pass. Beside the stub it centres vertically, so cards with one or two flights look alike. */}
          <div className={cx("flex min-w-0 flex-1 flex-col", compact ? "gap-2 px-4 pt-3" : "gap-3 px-4 pt-4 sm:px-5 sm:pt-5", "@[47rem]/card:justify-center @[47rem]/card:pb-2")}>
            {place && <PlaceTitle place={place} />}
            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((t) => (
                  <Tag key={t.text} tone={t.tone}>
                    {t.text}
                  </Tag>
                ))}
              </div>
            )}
            {!compact && line && <p className="words max-w-[34rem] text-[17px] leading-[1.4] text-ink sm:text-[18px]">{line}</p>}
            {/* A container, so flight rows lay out by the pass's width: one line each from 32rem (@lg). */}
            <div className="@container flex flex-col divide-y divide-rule">
              <LegLine leg={out} eager={index < 3} locale={locale} />
              {back ? <LegLine leg={back} eager={index < 3} locale={locale} /> : returnToPick(plan) ? <ReturnToPick plan={plan} locale={locale} /> : null}
            </div>
          </div>

          {/* The stub, past the dashed tear line. Fixed height below the pass so the notches (non-compact only) line up. */}
          <div
            className={cx(
              "relative flex shrink-0 items-center justify-between gap-3 px-4 sm:px-5",
              compact ? "py-3.5" : "h-20 @[47rem]/card:h-auto",
              "before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:border-t-[1.5px] before:border-dashed before:border-rule-strong",
              "@[47rem]/card:w-[200px] @[47rem]/card:flex-col @[47rem]/card:items-stretch @[47rem]/card:justify-start @[47rem]/card:gap-4 @[47rem]/card:py-5",
              "@[47rem]/card:before:inset-x-auto @[47rem]/card:before:inset-y-4 @[47rem]/card:before:left-0 @[47rem]/card:before:border-t-0 @[47rem]/card:before:border-l-[1.5px]"
            )}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[13px] text-ink-muted">{plan.travellers && plan.travellers > 1 ? `${trip} for ${plan.travellers}` : trip}</span>
              <span className={cx("nums leading-none font-semibold tracking-[-0.03em]", compact ? "text-[22px]" : "text-[28px] sm:text-[30px]", isCheapest && !compact ? "text-good" : "text-ink")}>{price}</span>
            </div>
            <div className="flex items-center gap-2 @[47rem]/card:flex-col @[47rem]/card:items-stretch">
              {/* Details before Book in a row, after it in a column: two buttons so tab order matches visual order. */}
              <button type="button" onClick={showOpen} className={cx(detailsClass, "inline-flex max-sm:hidden @[47rem]/card:hidden")}>
                Details
              </button>
              {/* On phones Details is a full 44px button, like Book. */}
              <Button variant="secondary" className="pointer-events-auto relative z-20 sm:hidden" onClick={showOpen}>
                Details
              </Button>
              {book}
              <button type="button" onClick={showOpen} className={cx(detailsClass, "hidden @[47rem]/card:inline-flex")}>
                Details
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
