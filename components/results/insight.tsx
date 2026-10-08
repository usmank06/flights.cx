"use client";

import { useRef, useState, type FocusEvent } from "react";
import { ChevronDown, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { money } from "@/lib/format";
import type { HintsView, InsightsView } from "@/lib/types";
import { cx } from "@/components/ui/primitives";
import { Panel } from "@/components/ui/overlay";
import { usePhone } from "@/components/ui/use-media";
import { shortDay } from "@/components/search/dates";

/**
 * A chip saying whether prices for the route are low, typical or high, opening a panel with the usual range and history.
 * The band shows only numbers that came with the fares.
 */

/** Price level from the provider's code (1 low, 2 to 4 typical, 5 high), falling back to `level`. */
function levelOf(insights: InsightsView | null | undefined): "low" | "typical" | "high" | null {
  const code = insights?.levelCode;
  if (code === 1) return "low";
  if (code === 2 || code === 3 || code === 4) return "typical";
  if (code === 5) return "high";
  return insights?.level ?? null;
}
export function InsightChip({
  insights,
  hints,
  currency,
  locale,
  wide = false,
}: {
  insights: InsightsView | null | undefined;
  hints: HintsView | undefined;
  currency: string;
  locale: string;
  /** The rail's full-width version. */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const phone = usePhone();
  const fmt = (n: number) => money(n, currency, locale);
  const has = insights && (insights.level || insights.typical != null || insights.low != null);
  const hintLines = [
    ...(hints?.dates ?? []).filter((h) => h.price != null).map((h) => ({ key: `d${h.outDate}${h.returnDate ?? ""}`, text: `${shortDay(h.outDate, locale)}${h.returnDate ? ` → ${shortDay(h.returnDate, locale)}` : ""} at ${fmt(h.price!)}` })),
    ...(hints?.airports ?? []).filter((h) => h.price != null).map((h) => ({ key: `a${h.code}`, text: `${h.departure ? "leaving from" : "flying into"} ${h.code} at ${fmt(h.price!)}` })),
  ];
  if (!has && !hintLines.length) return null;

  const level = levelOf(insights);
  const Icon = level === "high" ? TrendingUp : level === "typical" ? Minus : TrendingDown;
  // On desktop the panel is a popover: close it when focus leaves, so it doesn't cover the newly focused element.
  const leave = (e: FocusEvent<HTMLDivElement>) => {
    if (!phone && open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };
  const label = level ? `Prices are ${level}` : "The usual range";
  const band = insights && insights.low != null && insights.high != null && insights.high > insights.low ? { low: insights.low, high: insights.high } : null;
  const place = (n: number) => (band ? Math.max(0, Math.min(100, ((n - band.low) / (band.high - band.low)) * 100)) : 50);

  return (
    // shrink-0 so the chip keeps its width in the phone's scrolling row.
    <div className="relative shrink-0" onBlur={leave}>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cx(
          "press flex shrink-0 items-center gap-2 text-[13.5px] font-semibold",
          wide ? "h-10 w-full gap-2.5 rounded-xl px-2.5 pointer-coarse:h-11" : "h-9 rounded-full px-3.5 max-sm:h-10 pointer-coarse:h-10",
          level === "high"
            ? "bg-warn-soft text-warn hover:bg-[color-mix(in_srgb,var(--color-warn-soft),var(--color-warn)_10%)]"
            : level === "low"
              ? "bg-good-soft text-good hover:bg-[color-mix(in_srgb,var(--color-good-soft),var(--color-good)_10%)]"
              : wide
                ? "font-medium text-ink-soft hover:bg-soft hover:text-ink"
                : "float text-ink-soft"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        <span className={cx("whitespace-nowrap", wide && "min-w-0 flex-1 truncate text-left text-[13px]")}>{label}</span>
        <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 transition-transform", wide && "ml-auto", open && "rotate-180")} strokeWidth={2.2} />
      </button>
      <Panel phone={phone} open={open} onClose={() => setOpen(false)} anchor={anchor} align={wide ? "start" : "end"} label="Is this a good price?" className="w-[min(380px,calc(100vw-2rem))] p-4">
        <div className="flex flex-col gap-4">
          {insights && (level || insights.typical != null) && (
            <p className="text-[14.5px] leading-relaxed text-ink-soft">
              {level ? (
                <>
                  Prices for this trip are <span className={cx("font-semibold", level === "high" ? "text-warn" : level === "low" ? "text-good" : "text-ink")}>{level}</span> right now.
                  {insights.typical != null && <> They&rsquo;re usually about {fmt(insights.typical)}.</>}
                </>
              ) : (
                <>Prices for this trip are usually about {fmt(insights.typical!)}.</>
              )}
            </p>
          )}
          {band && insights && (
            <div className="flex flex-col gap-1.5 pt-4">
              <div className="relative h-2 rounded-full bg-[linear-gradient(90deg,var(--color-good-soft),var(--color-soft-strong),var(--color-warn-soft))]">
                {insights.typical != null && <span aria-hidden className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted" style={{ left: `${place(insights.typical)}%` }} />}
                {insights.current != null && (
                  <>
                    <span aria-hidden className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-paper bg-ink shadow" style={{ left: `${place(insights.current)}%` }} />
                    <span
                      className="nums absolute -top-7 -translate-x-1/2 rounded-full bg-ink px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-white"
                      style={{ left: `clamp(2.5rem, ${place(insights.current)}%, calc(100% - 2.5rem))` }}
                    >
                      {fmt(insights.current)} now
                    </span>
                  </>
                )}
              </div>
              <div className="nums flex justify-between text-[12px] text-ink-muted">
                <span>usually from {fmt(band.low)}</span>
                <span>to {fmt(band.high)}</span>
              </div>
            </div>
          )}
          {insights && insights.history.length > 2 && <History points={insights.history} fmt={fmt} />}
          {hintLines.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[12.5px] text-ink-muted">Also worth a look</p>
              {/* Not interactive, so on phones they render as text lines instead of tappable-looking pills. */}
              <div className="flex flex-wrap gap-1.5 max-md:flex-col max-md:gap-1">
                {hintLines.map((l) => (
                  <span key={l.key} className="nums rounded-full bg-soft px-2.5 py-1 text-[12px] font-medium text-ink max-md:bg-transparent max-md:p-0 max-md:text-[13.5px] max-md:font-normal max-md:text-ink-soft">
                    {l.text}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Sparkline of the route's daily price history. */
function History({ points, fmt }: { points: { at: number; price: number }[]; fmt: (n: number) => string }) {
  const w = 340;
  const h = 64;
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(1, max - min);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 4 - ((p.price - min) / span) * (h - 8)] as const);
  const d = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const days = Math.max(1, Math.round((points[points.length - 1].at - points[0].at) / 86_400_000));
  return (
    <figure className="flex flex-col gap-1.5 rounded-2xl bg-soft px-3 pt-3 pb-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label={`Price over the last ${days} days, from ${fmt(min)} to ${fmt(max)}`}>
        <defs>
          <linearGradient id="hist-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${h} ${d} ${w},${h}`} fill="url(#hist-fill)" />
        <polyline points={d} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption className="nums flex justify-between text-[11.5px] text-ink-muted">
        <span>last {days} days</span>
        <span>
          {fmt(min)} – {fmt(max)}
        </span>
      </figcaption>
    </figure>
  );
}
