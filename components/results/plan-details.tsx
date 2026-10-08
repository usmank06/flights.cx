"use client";

import { createContext, useCallback, useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, Armchair, Clock, ExternalLink, Moon, Plug, Tv, Wifi } from "lucide-react";
import { airlineName } from "@/lib/airports";
import { money, twelveHour } from "@/lib/format";
import type { FlightLeg, FlightPlan } from "@/lib/types";
import { cx, Eyebrow } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlay";
import { dayLabel } from "@/components/search/dates";
import {
  airportSwaps,
  carrierCodes,
  cityOf,
  isExact,
  isPaired,
  layovers,
  longLayover,
  perTravellerNote,
  recordBookClick,
  returnIso,
  returnToPick,
  routeTags,
  shiftTags,
  splitRouteNote,
  stopsLabel,
  type Named,
} from "./plan-meta";
import { Time } from "./time";

/**
 * Plan details in a sheet: price, cautions, a timeline per leg, and Book pinned at the bottom. One sheet per page, opened via
 * `useDetails().open`. DetailsProvider also supplies the requested airports (`named`) so any card below it can flag a different
 * airport; a place's flights override them with `NamedAirports`.
 */
type Opts = { slug: string; locale: string; cheapest: number | null; saved: number | null; named?: Named | null };
type Ctx = { open: (plan: FlightPlan, opts: Opts) => void };

const DetailsContext = createContext<Ctx>({ open: () => {} });
export const useDetails = () => useContext(DetailsContext);

const NamedContext = createContext<Named | null>(null);
export const useNamed = () => useContext(NamedContext);
export function NamedAirports({ named, children }: { named: Named | null; children: ReactNode }) {
  return <NamedContext.Provider value={named}>{children}</NamedContext.Provider>;
}

export function DetailsProvider({ named = null, children }: { named?: Named | null; children: ReactNode }) {
  const [shown, setShown] = useState<{ plan: FlightPlan; opts: Opts } | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback((plan: FlightPlan, opts: Opts) => {
    setShown({ plan, opts });
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <DetailsContext.Provider value={value}>
      <NamedAirports named={named}>{children}</NamedAirports>
      {shown && (
        <Sheet open={isOpen} onClose={close} label="The flights, in detail" footer={<BookFooter plan={shown.plan} slug={shown.opts.slug} />}>
          <PlanDetails plan={shown.plan} {...shown.opts} />
        </Sheet>
      )}
    </DetailsContext.Provider>
  );
}

/* --------------------------------- A leg ---------------------------------- */

/** Time column width (`--clock`), wider for 12-hour clocks ("10:40 PM⁺¹" vs "22:40⁺¹"). */
const clockColumn = (locale: string) => ({ "--clock": twelveHour(locale) ? "80px" : "58px" }) as CSSProperties;

function Point({ time, code, sub, locale }: { time: string; code: string; sub?: string; locale: string }) {
  return (
    <div className="grid grid-cols-[18px_var(--clock)_minmax(0,1fr)] items-baseline gap-x-2">
      <span className="flex h-full items-center justify-center self-center" aria-hidden>
        <span className="h-3 w-3 rounded-full border-[2.5px] border-ink bg-paper" />
      </span>
      <Time value={time} locale={locale} size={16} />
      <span className="min-w-0 text-[15px] text-ink">
        {cityOf(code)} <span className="text-ink-muted">{code}</span>
        {sub && <span className="block text-[12.5px] text-ink-muted">{sub}</span>}
      </span>
    </div>
  );
}

function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2">
      <span className="flex justify-center" aria-hidden>
        <span className="w-0.5 rounded-full bg-rule-strong" />
      </span>
      <div className="py-2.5 pl-[calc(var(--clock)+8px)]">{children}</div>
    </div>
  );
}

function Amenities({ leg }: { leg: FlightLeg }) {
  const x = leg.extras;
  if (!x) return null;
  const items: { key: string; icon: typeof Wifi; text: string; warn?: boolean }[] = [];
  if (x.legroom || x.legroomClass)
    items.push({
      key: "legroom",
      icon: Armchair,
      text: x.legroomClass === 2 ? `Tight legroom${x.legroom ? `, ${x.legroom}` : ""}` : x.legroomClass === 3 ? `Extra legroom${x.legroom ? `, ${x.legroom}` : ""}` : `${x.legroom ?? "Average"} legroom`,
      warn: x.legroomClass === 2,
    });
  if (x.wifi) items.push({ key: "wifi", icon: Wifi, text: x.wifi === "free" ? "Free Wi-Fi" : "Wi-Fi, paid" });
  if (x.power) items.push({ key: "power", icon: Plug, text: "Power" });
  if (x.video) items.push({ key: "video", icon: Tv, text: "Screens" });
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 pt-1.5">
      {items.map((i) => (
        <li key={i.key} className={cx("flex items-center gap-1.5 text-[12.5px]", i.warn ? "text-warn" : "text-ink-muted")}>
          <i.icon className="h-3.5 w-3.5" strokeWidth={2} />
          {i.text}
        </li>
      ))}
    </ul>
  );
}

/** "Vueling VY 7642". Falls back to the leg's airline name ("LEVEL LL 2628"), then to the bare flight number. */
function segmentLabel(n: string, leg: FlightLeg) {
  const code = n.slice(0, 2);
  const known = airlineName(code);
  const name = known !== code ? known : leg.airline.split(" · ")[carrierCodes(leg).indexOf(code)];
  return name && name !== code ? `${name} ${n}` : n;
}

function LegTimeline({ leg, label, locale }: { leg: FlightLeg; label: string; locale: string }) {
  const numbers = leg.flightNumber.split("/").map((s) => s.trim());
  const craft = (leg.extras?.aircraft ?? "").split("/").map((s) => s.trim());
  const lays = layovers(leg);
  const date = leg.isoDate ? dayLabel(leg.isoDate, locale) : leg.date;
  const flags = [leg.extras?.overnight ? { icon: Moon, text: "Overnight" } : null, leg.extras?.oftenDelayed ? { icon: Clock, text: "Often delayed" } : null].filter(Boolean) as { icon: typeof Moon; text: string }[];
  return (
    <section className="flex flex-col gap-3" aria-label={`${label}, ${date}`} style={clockColumn(locale)}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>
          {label} · {date}
        </Eyebrow>
        <span className="nums text-[13px] text-ink-soft">
          {leg.duration} · {stopsLabel(leg.stops).toLowerCase()}
        </span>
      </div>
      <div className="flex flex-col">
        <Point time={leg.departTime} code={leg.from} locale={locale} />
        {numbers.map((n, i) => (
          <div key={n + i}>
            <Rail>
              <p className="text-[13.5px] text-ink-soft">
                {segmentLabel(n, leg)}
                {craft[i] ? <span className="text-ink-muted"> · {craft[i]}</span> : null}
              </p>
              {i === 0 && <Amenities leg={leg} />}
            </Rail>
            {lays[i] && (
              <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2">
                <span className="flex justify-center" aria-hidden>
                  <span className="h-2.5 w-2.5 rounded-full bg-rule-strong" />
                </span>
                <span
                  className={cx(
                    "ml-[calc(var(--clock)+8px)] inline-flex w-fit items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium",
                    longLayover(lays[i].dur) ? "bg-warn-soft text-warn" : "bg-soft text-ink-soft"
                  )}
                >
                  <Clock className="h-3.5 w-3.5" strokeWidth={2} />
                  {lays[i].dur} in {cityOf(lays[i].code)}
                </span>
              </div>
            )}
          </div>
        ))}
        <Point time={leg.arriveTime} code={leg.to} locale={locale} />
      </div>
      {flags.length > 0 && (
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 pl-[calc(var(--clock)+34px)]">
          {flags.map((f) => (
            <li key={f.text} className="flex items-center gap-1.5 text-[12.5px] font-medium text-warn">
              <f.icon className="h-3.5 w-3.5" strokeWidth={2} />
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------- The panel -------------------------------- */

export function PlanDetails({ plan, locale, cheapest, saved, named }: { plan: FlightPlan } & Omit<Opts, "slug">) {
  const { text: why, note } = splitRouteNote(plan.summary);
  // Full airport-swap notes, or the summary's route note when the requested airports are unknown.
  const route = named ? airportSwaps(plan, named).map((s) => s.note) : routeTags(note);
  const cautions = [...route, ...shiftTags(plan), ...(plan.carryOnIncluded === 0 ? ["No carry-on bag in this fare"] : [])];
  const out = plan.legs.find((l) => l.direction === "outbound") ?? plan.legs[0];
  const back = plan.legs.find((l) => l.direction === "return");
  const single = !back && !plan.roundTripFare;
  const per = perTravellerNote(plan, locale);
  const isCheapest = cheapest != null && plan.price <= cheapest;
  const ret = returnIso(plan);
  // The saving is green and worded as on the card.
  const facts = [
    plan.nights != null && plan.nights > 0 ? { text: `${plan.nights} night${plan.nights === 1 ? "" : "s"} away` } : null,
    isPaired(plan) ? { text: "Two separate tickets" } : null,
    isCheapest && saved != null && saved > 0 ? { text: `${money(saved, plan.currency, locale)} under your dates`, good: true } : null,
  ].filter((f): f is { text: string; good?: boolean } => Boolean(f));
  return (
    // Focusable so keyboard users can scroll it; nothing else in the scroll area takes focus.
    <div tabIndex={0} role="region" aria-label="The flights" className="flex flex-col gap-6 px-5 pt-6 pb-6 outline-offset-[-3px] md:px-7 md:pt-7">
      <div className="flex flex-col gap-3 pr-12">
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className={cx("nums text-[36px] leading-none font-semibold tracking-[-0.04em]", isCheapest ? "text-good" : "text-ink")}>{money(plan.price, plan.currency, locale)}</span>
          <span className="text-[14px] text-ink-muted">
            {single ? "one way" : "round trip"}
            {plan.travellers && plan.travellers > 1 ? ` for ${plan.travellers}` : ""}
            {per ? ` · ${per}` : ""}
          </span>
        </p>
        {why && <p className="words text-[17px] leading-relaxed text-ink-soft">{why}</p>}
        {facts.length > 0 && (
          <p className="flex flex-wrap gap-1.5">
            {facts.map((f) => (
              <span
                key={f.text}
                className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] font-semibold", f.good ? "bg-good-soft text-good" : "bg-soft text-ink-soft")}
              >
                {f.text}
              </span>
            ))}
          </p>
        )}
      </div>

      {cautions.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-2xl bg-warn-soft px-4 py-3">
          {cautions.map((c) => (
            <li key={c} className="flex items-start gap-2 text-[13.5px] font-medium text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
              {c}
            </li>
          ))}
        </ul>
      )}

      <LegTimeline leg={out} label={single ? "Flight" : "Out"} locale={locale} />
      {back && <LegTimeline leg={back} label="Back" locale={locale} />}
      {returnToPick(plan) && (
        <section className="flex flex-col gap-2">
          <Eyebrow>Back · {ret ? dayLabel(ret, locale) : (plan.returnDate ?? "")}</Eyebrow>
          <div className="flex flex-col gap-1.5 rounded-2xl bg-soft px-4 py-3.5 text-[14px] leading-relaxed text-ink-soft">
            <p className="font-semibold text-ink">One ticket, there and back. You pick the flight home when you book.</p>
            <p>The cheapest flight home{plan.backFrom ? `, leaving from ${cityOf(plan.backFrom)},` : ""} is the price above.</p>
          </div>
        </section>
      )}
    </div>
  );
}

/** Pinned under the panel: one Book button, or two for two tickets. */
function BookFooter({ plan, slug }: { plan: FlightPlan; slug: string }) {
  const b = plan.booking;
  const exact = isExact(plan);
  const click = () => recordBookClick(slug, plan.id, b.precision);
  if (isPaired(plan)) {
    const out = plan.legs.find((l) => l.direction === "outbound");
    const back = plan.legs.find((l) => l.direction === "return");
    const ticket = (n: number, leg: FlightLeg | undefined, url: string, primary: boolean) => (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={click}
        className={cx("press flex h-12 flex-1 flex-col items-center justify-center rounded-2xl px-3 text-center", primary ? "btn-primary" : "float text-ink")}
      >
        <span className="text-[14px] font-semibold">
          {exact ? "Book" : "See"} ticket {n}
        </span>
        {leg && <span className={cx("text-[11.5px]", primary ? "text-white/85" : "text-ink-muted")}>{`${cityOf(leg.from)} → ${cityOf(leg.to)}`}</span>}
      </a>
    );
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {ticket(1, out, b.url, true)}
          {ticket(2, back, b.returnUrl!, false)}
        </div>
        <p className="text-center text-[12px] text-ink-muted">Two tickets, booked separately. The price above is for both.</p>
      </div>
    );
  }
  return (
    <a
      href={b.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={click}
      className="btn-primary press flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15.5px] font-semibold"
    >
      {!exact ? "See these flights" : returnToPick(plan) ? "Book and pick the flight home" : "Book these flights"}
      <ExternalLink className="h-4 w-4" strokeWidth={2.2} />
    </a>
  );
}
