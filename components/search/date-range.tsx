"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, cx, IconButton } from "@/components/ui/primitives";
import { useMedia } from "@/components/ui/use-media";
import { addDays, dayLabel, monthGrid, monthLabel, monthStart, nightsBetween, partsOf, todayDay, type Day } from "./dates";

/**
 * Date range picker: two months side by side (one on a phone). The first click sets departure and the second the return, with the
 * range previewed under the pointer. The keyboard follows the standard calendar grid pattern with a single tab stop.
 */
const WEEK = ["S", "M", "T", "W", "T", "F", "S"];

function Month({
  first,
  today,
  depart,
  end,
  stop,
  onPick,
  onHover,
  onKey,
  locale,
}: {
  first: Day;
  today: Day;
  depart: Day | "";
  /** The return, or the day under the pointer while the return is being chosen. */
  end: Day | "";
  /** The one day the Tab key reaches. */
  stop: Day;
  onPick: (d: Day) => void;
  onHover: (d: Day | null) => void;
  onKey: (e: React.KeyboardEvent, d: Day) => void;
  locale: string;
}) {
  const { y, m: month } = partsOf(first);
  // Weeks this month spans. On a phone (one month shown) the empty sixth row is hidden.
  const lead = new Date(Date.UTC(y, month, 1)).getUTCDay();
  const weeks = Math.ceil((lead + new Date(Date.UTC(y, month + 1, 0)).getUTCDate()) / 7);
  const days = monthGrid(first);
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <p className="text-center text-[15px] font-semibold text-ink">{monthLabel(first, locale)}</p>
      <div className="grid grid-cols-7 text-center text-[12px] font-medium text-ink-muted" aria-hidden>
        {WEEK.map((w, i) => (
          <span key={i} className="py-1.5">
            {w}
          </span>
        ))}
      </div>
      <div className="flex flex-col" role="grid" aria-label={monthLabel(first, locale)} onPointerLeave={() => onHover(null)}>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} role="row" className={cx("grid grid-cols-7", row >= weeks && "max-sm:hidden")}>
            {days.slice(row * 7, row * 7 + 7).map((d) => {
              if (partsOf(d).m !== month) return <span key={d} role="gridcell" className="h-11" />;
              const past = d < today;
              const start = d === depart;
              const last = Boolean(end) && d === end;
              const between = Boolean(depart && end) && d > depart && d < end;
              const band = between || (start && end && end > depart) || (last && depart && end > depart);
              return (
                <div key={d} role="gridcell" aria-selected={start || last} className="relative flex h-11 items-center justify-center">
                  {band && (
                    <span
                      aria-hidden
                      className={cx(
                        "absolute inset-y-[3px] bg-accent-soft",
                        start ? "right-0 left-1/2" : last ? "right-1/2 left-0" : "inset-x-0"
                      )}
                    />
                  )}
                  <button
                    type="button"
                    data-day={d}
                    disabled={past}
                    tabIndex={d === stop ? 0 : -1}
                    onClick={() => onPick(d)}
                    onPointerEnter={() => onHover(d)}
                    onFocus={() => onHover(d)}
                    onBlur={() => onHover(null)}
                    onKeyDown={(e) => onKey(e, d)}
                    aria-label={dayLabel(d, locale)}
                    aria-pressed={start || last}
                    className={cx(
                      "press nums relative flex h-10 w-full max-w-10 items-center justify-center rounded-full text-[14px] font-medium",
                      past && "cursor-default text-ink-faint",
                      !past && (start || last ? "btn-primary font-semibold" : between ? "text-accent-ink hover:bg-white" : "text-ink hover:bg-soft hover:ring-1 hover:ring-rule-strong"),
                      d === today && !start && !last && "ring-1 ring-ink/30"
                    )}
                  >
                    {partsOf(d).d}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The last day of `day`'s month. */
const monthEnd = (day: Day) => addDays(monthStart(day, 1), -1);

export function DateRangePicker({
  depart,
  ret,
  oneWay,
  onChange,
  locale,
}: {
  depart: Day | "";
  ret: Day | "";
  oneWay: boolean;
  onChange: (depart: Day | "", ret: Day | "") => void;
  locale: string;
}) {
  const [today] = useState(todayDay);
  // On a phone (one month shown), open on next month if less than a week of this one is left.
  // Reading `window` is safe: the picker only mounts after a tap.
  const [view, setView] = useState(() => {
    if (depart && depart >= today) return monthStart(depart);
    const { y, m, d } = partsOf(today);
    const left = new Date(Date.UTC(y, m + 1, 0)).getUTCDate() - d + 1;
    const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
    return monthStart(today, !depart && narrow && left < 7 ? 1 : 0);
  });
  const [hover, setHover] = useState<Day | null>(null);
  /** The keyboard's day. Null until it moves, while the tab stop is the departure or the first pickable day. */
  const [cursor, setCursor] = useState<Day | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const choosingReturn = !oneWay && Boolean(depart) && !ret;
  const end: Day | "" = oneWay ? "" : ret || (choosingReturn && hover && hover >= depart ? hover : "");

  function pick(d: Day) {
    if (oneWay || !depart || ret || d < depart) {
      onChange(d, "");
      return;
    }
    onChange(depart, d);
  }

  const shown = useMedia("(max-width: 639px)") ? 1 : 2;
  const lastShown = monthEnd(monthStart(view, shown - 1));
  const visible = (d: Day) => d >= view && d <= lastShown;
  const firstOpen = view < today ? today : view;
  const stop = cursor && visible(cursor) && cursor >= today ? cursor : depart && visible(depart) ? depart : firstOpen;

  function onKey(e: React.KeyboardEvent, d: Day) {
    const { y, m, d: n } = partsOf(d);
    const weekday = new Date(Date.UTC(y, m, n)).getUTCDay();
    // The same day `delta` months away, clamped to that month's last day.
    const inMonth = (delta: number) => {
      const s = monthStart(d, delta);
      const e2 = monthEnd(s);
      const want = addDays(s, n - 1);
      return want > e2 ? e2 : want;
    };
    const to: Day | null =
      e.key === "ArrowLeft" ? addDays(d, -1)
      : e.key === "ArrowRight" ? addDays(d, 1)
      : e.key === "ArrowUp" ? addDays(d, -7)
      : e.key === "ArrowDown" ? addDays(d, 7)
      : e.key === "Home" ? addDays(d, -weekday)
      : e.key === "End" ? addDays(d, 6 - weekday)
      : e.key === "PageUp" ? inMonth(e.shiftKey ? -12 : -1)
      : e.key === "PageDown" ? inMonth(e.shiftKey ? 12 : 1)
      : null;
    if (!to) return;
    e.preventDefault();
    // Past days can't be picked, so the keyboard stops at today.
    const next = to < today ? today : to;
    if (next < view) setView(monthStart(next));
    else if (next > lastShown) setView(monthStart(next, 1 - shown));
    moved.current = true;
    setCursor(next);
  }

  // Move focus to the keyboard's day once its month has rendered.
  useEffect(() => {
    if (!moved.current || !cursor) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${cursor}"]`)?.focus();
  }, [cursor, view]);

  const nights = depart && ret ? nightsBetween(depart, ret) : null;
  const range = depart && ret ? `${dayLabel(depart, locale)} → ${dayLabel(ret, locale)}` : "";
  const length = nights == null ? "" : `${nights} night${nights === 1 ? "" : "s"}`;
  // Empty until a day is picked. A no-break space keeps "9 nights" together.
  const summary = !depart ? "" : oneWay ? `${dayLabel(depart, locale)}, one way` : ret ? `${range} · ${length}` : `Leaving ${dayLabel(depart, locale)}`;

  const canBack = view > monthStart(today);
  return (
    <div className="flex flex-col gap-3 p-2 sm:p-3">
      <div ref={grid} className="relative grid gap-6 sm:grid-cols-2 sm:gap-8">
        {/* 36px visually, with an ::after hit area extending it to 44px. */}
        <IconButton label="Previous month" onClick={() => setView((v) => monthStart(v, -1))} disabled={!canBack} className="absolute top-[-6px] left-0 after:absolute after:-inset-1 after:content-[''] disabled:opacity-30" size={36}>
          <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
        </IconButton>
        <IconButton label="Next month" onClick={() => setView((v) => monthStart(v, 1))} className="absolute top-[-6px] right-0 after:absolute after:-inset-1 after:content-['']" size={36}>
          <ChevronRight className="h-4 w-4" strokeWidth={2.2} />
        </IconButton>
        <Month first={view} today={today} depart={depart} end={end} stop={stop} onPick={pick} onHover={setHover} onKey={onKey} locale={locale} />
        <div className="hidden min-w-0 sm:block">
          <Month first={monthStart(view, 1)} today={today} depart={depart} end={end} stop={stop} onPick={pick} onHover={setHover} onKey={onKey} locale={locale} />
        </div>
      </div>
      {/* On a phone a round trip's summary wraps to two lines (dates, then nights) beside Clear. */}
      {depart && (
        <div className="flex items-center justify-between gap-3">
          <p className="nums min-w-0 flex-1 text-[13.5px] text-ink-soft">
            {ret && !oneWay ? (
              <>
                {range}
                <span className="max-sm:hidden"> · </span>
                <span className="max-sm:block">{length}</span>
              </>
            ) : (
              summary
            )}
          </p>
          <Button variant="ghost" size="sm" className="max-sm:h-11" onClick={() => onChange("", "")}>
            Clear
          </Button>
        </div>
      )}
      {/* Always mounted, so the first pick is announced too. */}
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
    </div>
  );
}
