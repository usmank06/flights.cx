"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Grid3x3, Minus, Plus } from "lucide-react";
import { money } from "@/lib/format";
import { AIRPORTS } from "@/lib/airports";
import type { FlightPlan, GridCell, GridView } from "@/lib/types";
import { cx, Spinner } from "@/components/ui/primitives";
import { CloseButton, Sheet, useOverlay } from "@/components/ui/overlay";
import { usePresence } from "@/components/ui/presence";
import { useMedia } from "@/components/ui/use-media";
import { addDays, dayLabel, rangeLabel, shortDay, todayDay, weekday } from "@/components/search/dates";
import { createPortal } from "react-dom";
import { PlanCard } from "./plan-card";
import { CardSkeleton } from "./skeleton";
import { shownError } from "@/components/ui/errors";
import { recaptchaHeaders } from "@/components/search/search-client";

/**
 * The date grid: departure days down the side, return days across, each cell the cheapest fare for that pair.
 * One grid per search. A follow-up about other dates rebuilds it, and widening it prices only the new days.
 */

const city = (code: string) => AIRPORTS[code]?.city ?? code;
/** The most days a side can span. Matches MAX_GRID_DAYS in lib/search/grid.ts. */
const MAX_DAYS = 14;

type Win = { out: [string, string]; ret: [string, string] | null };
type Pick = { out: string; ret: string; via?: GridCell["via"] };
/** Cell flights cached by request body, so closing or widening the grid doesn't refetch them. */
type Fetched = Map<string, { plans?: FlightPlan[]; wait: Promise<FlightPlan[]> }>;

function daysOf(w: [string, string]): string[] {
  const xs: string[] = [];
  for (let d = w[0]; d <= w[1]; d = addDays(d, 1)) xs.push(d);
  return xs;
}
const span = (w: [string, string]) => daysOf(w).length;
const within = (d: string, w: [string, string]) => d >= w[0] && d <= w[1];

/** A plan's days as grid keys. One-ways repeat the out day; a round-trip fare without a return leg adds its nights. */
function planDays(p: FlightPlan): { out: string; ret: string } | null {
  const out = p.legs.find((l) => l.direction === "outbound")?.isoDate;
  if (!out) return null;
  const ret = p.legs.find((l) => l.direction === "return")?.isoDate ?? (!p.roundTripFare ? out : p.nights != null ? addDays(out, p.nights) : null);
  return ret ? { out, ret } : null;
}

function stats(grid: GridView, plans: FlightPlan[] = []) {
  const priced = grid.cells.filter((c) => c.price != null) as (GridCell & { price: number })[];
  const min = priced.length ? Math.min(...priced.map((c) => c.price)) : null;
  const max = priced.length ? Math.max(...priced.map((c) => c.price)) : null;
  const ties = priced.filter((c) => c.price === min);
  // Among pairs tied for cheapest, prefer one a card flies, so the rail and the cards show the same days.
  const flown = [...plans].sort((a, b) => a.price - b.price).map(planDays);
  const best = flown.map((d) => d && ties.find((c) => c.outDate === d.out && c.returnDate === d.ret)).find((c) => c != null) ?? ties[0] ?? null;
  return { priced, min, max, best };
}

/** Cell fill by where a price sits between the cheapest and the dearest: green near the bottom, muted above. */
function tone(price: number | null | undefined, min: number | null, max: number | null) {
  if (price == null || min == null || max == null) return "text-ink-muted";
  if (price === min) return "bg-good text-white";
  const t = max === min ? 0 : (price - min) / (max - min);
  if (t < 0.15) return "bg-good-soft text-good";
  if (t < 0.45) return "bg-soft text-ink";
  return "bg-soft/50 text-ink-muted";
}

/* --------------------------------- Button --------------------------------- */

/** Opens the date grid. A null `grid` means a fixed-date search has none yet, and pressing builds one around its dates. */
export function DatesButton({
  grid,
  plans,
  currency,
  locale,
  onOpen,
  busy = false,
  className = "",
  wide = false,
}: {
  grid: GridView | null;
  /** The search's plans, for breaking ties on the cheapest pair. */
  plans?: FlightPlan[];
  currency: string;
  locale: string;
  onOpen: () => void;
  busy?: boolean;
  className?: string;
  /** The rail's full-width version, with the cheapest pair under it. */
  wide?: boolean;
}) {
  const s = grid ? stats(grid, plans) : null;
  const oneRow = grid ? grid.returnDates.length === 0 : false;
  return (
    <button
      type="button"
      // aria-disabled because a disabled button loses focus, and closing the grid returns focus to this button.
      onClick={() => !busy && onOpen()}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className={cx(
        "press flex shrink-0 items-center gap-2.5 text-left text-ink",
        wide ? "w-full rounded-xl px-2.5 py-2 hover:bg-soft" : "float h-9 rounded-full px-3.5",
        busy && "cursor-default",
        className
      )}
    >
      {busy ? <Spinner className="h-4 w-4 shrink-0 text-accent" /> : <Grid3x3 className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.2} />}
      <span className="flex min-w-0 flex-col">
        <span className="text-[13.5px] font-semibold whitespace-nowrap">
          {busy ? "Pricing the dates…" : "Date grid"}
          {!wide && s?.min != null && !busy && (
            <span className="font-medium text-ink-muted">
              {" "}
              · from <span className="nums">{money(s.min, currency, locale)}</span>
            </span>
          )}
          {!wide && !grid && !busy && <span className="font-medium text-ink-muted"> · nearby days</span>}
        </span>
        {/* Rendered while busy too, so the rail below doesn't shift. */}
        {wide && (
          <span className="text-[12.5px] text-ink-muted">
            {s?.best ? (
              <>
                <span className="whitespace-nowrap">
                  From <span className="nums">{money(s.best.price, currency, locale)}</span> ·
                </span>{" "}
                <span className="nums whitespace-nowrap">{rangeLabel(s.best.outDate, oneRow ? null : s.best.returnDate, locale)}</span>
              </>
            ) : (
              "The days around yours"
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---------------------------------- Panel --------------------------------- */

export function GridPanel({
  open,
  onClose,
  grid,
  onGrid,
  slug,
  currency,
  locale,
  onAsk,
  sending = false,
  error = null,
  focus,
}: {
  open: boolean;
  onClose: () => void;
  grid: GridView;
  /** Receives the server's updated grid after a widen or trim. */
  onGrid: (g: GridView) => void;
  slug: string;
  currency: string;
  locale: string;
  /** Sends a follow-up from the grid's ask box. Resolves true on success, which closes the panel; on failure the text stays. */
  onAsk: (q: string, source: "grid") => Promise<boolean>;
  sending?: boolean;
  error?: string | null;
  /** Date pair to open on, with its flights. Compared by identity, so pass a new object each time. */
  focus?: Pick | null;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const { render, state } = usePresence(open, 240);
  useOverlay(open, onClose, panel);
  const [pick, setPick] = useState<Pick | null>(null);
  const [focused, setFocused] = useState<Pick | null>(null);
  // Below lg the flights open in a sheet over the grid. Its content follows `pick`, which outlives the sheet,
  // so it doesn't empty while closing.
  const wide = useMedia("(min-width: 1024px)");
  const [sheetOpen, setSheetOpen] = useState(false);
  // A focus pair opens selected, with its flights beside the grid or in the sheet.
  if (open && focus && focus !== focused) {
    setFocused(focus);
    setPick(focus);
    if (!wide) setSheetOpen(true);
  }
  // Drop the pick if a rebuilt grid doesn't include its days.
  if (pick && !(grid.outDates.includes(pick.out) && (grid.returnDates.length === 0 || grid.returnDates.includes(pick.ret)))) setPick(null);
  const [fetched] = useState<Fetched>(() => new Map());
  const [question, setQuestion] = useState("");
  // Tracks this box's own failure, so an older error from the page's ask bar stays hidden.
  const [failed, setFailed] = useState(false);
  const roomy = useMedia("(min-width: 640px)");
  if (!open && sheetOpen) setSheetOpen(false);
  if (!render) return null;
  const title = grid.route ? `${city(grid.route.from)} → ${grid.route.to.map(city).join(" or ")}` : "The days around yours";
  const send = async () => {
    const q = question.trim();
    if (!q || sending) return;
    setFailed(false);
    if (await onAsk(q, "grid")) {
      setQuestion("");
      onClose();
    } else setFailed(true);
  };
  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-end justify-center sm:items-center sm:p-5 short:p-0">
      <div data-state={state} className="scrim absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Date grid"
        data-state={state}
        className="modal relative flex h-[94dvh] w-full max-w-[1360px] flex-col overflow-hidden rounded-t-[28px] bg-paper shadow-lg outline-none sm:h-[min(860px,92dvh)] sm:rounded-[28px] short:h-dvh short:rounded-none"
      >
        {/* Short screens (landscape phones) get a one-line title so the grid keeps the height. */}
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 pt-5 pb-4 sm:px-7 short:items-center short:py-1.5">
          <div className="flex min-w-0 flex-col gap-0.5 short:flex-row short:items-baseline short:gap-3">
            <h2 className="display text-[24px] font-semibold text-ink sm:text-[28px] short:shrink-0 short:text-[20px]">Date grid</h2>
            <p className="truncate text-[13.5px] text-ink-muted">{title}</p>
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 pt-2 pb-4 sm:px-7 lg:border-r lg:border-rule short:pb-2">
            <EditableGrid
              grid={grid}
              onGrid={onGrid}
              slug={slug}
              currency={currency}
              locale={locale}
              pick={pick}
              onPick={(p) => {
                setPick(p);
                if (p && !wide) setSheetOpen(true);
              }}
            />
          </div>
          {wide && (
            // The grid keeps 852px (ten by ten days plus a scrollbar); the flights get the rest, 384 to 480px.
            <aside className="bg-well px-5 py-4 sm:px-6 lg:min-h-0 lg:w-[clamp(384px,100%_-_852px,480px)] lg:shrink-0 lg:overflow-y-auto lg:overscroll-contain" aria-live="polite">
              {pick ? (
                <CellFlights key={`${pick.out}~${pick.ret}`} pick={pick} grid={grid} slug={slug} locale={locale} fetched={fetched} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <Grid3x3 className="h-6 w-6 text-ink-faint" strokeWidth={1.8} />
                  <p className="text-[14.5px] font-medium text-ink-soft">{grid.returnDates.length ? "Pick a pair of dates" : "Pick a day"}</p>
                </div>
              )}
            </aside>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="border-t border-rule px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 short:pt-1.5 short:pb-[max(0.375rem,env(safe-area-inset-bottom))]"
        >
          {/* A click anywhere on the pill except Send focuses the input. */}
          <div
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("button, input")) field.current?.focus();
            }}
            className="float field mx-auto flex h-12 w-full max-w-[760px] cursor-text items-center gap-3 rounded-full pr-1.5 pl-5 pointer-coarse:pr-0.5"
          >
            <label htmlFor="grid-ask" className="sr-only">
              Ask about these dates
            </label>
            <input
              ref={field}
              id="grid-ask"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={roomy ? "Ask about these dates, like “what about a week later?”" : "Ask about these dates…"}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted pointer-coarse:text-[16px]"
            />
            <button
              type="submit"
              disabled={!question.trim() || sending}
              aria-label="Send"
              className={cx(
                "press flex h-9 w-9 shrink-0 cursor-default items-center justify-center rounded-full pointer-coarse:h-11 pointer-coarse:w-11",
                question.trim() ? "btn-primary cursor-pointer" : "bg-ink/[0.06] text-ink-faint"
              )}
            >
              {sending ? <span className="spin h-4 w-4 rounded-full border-2 border-white/40 border-t-white" /> : <ArrowRight className="h-4 w-4" strokeWidth={2.4} />}
            </button>
          </div>
          {failed && error && <p role="alert" className="mx-auto mt-2 max-w-[760px] text-center text-[13.5px] text-warn">{error}</p>}
        </form>
      </div>
      {!wide && (
        // 640px on tablets (side sheet): a card's flight line needs about 620px to fit on one row.
        <Sheet open={sheetOpen && pick != null} onClose={() => setSheetOpen(false)} label="Flights on these dates" width={640}>
          {pick && (
            <div className="px-5 pt-1 pb-6 md:pt-5">
              <p className="pr-12 pb-3 text-[17px] font-semibold text-ink">{grid.returnDates.length ? `${dayLabel(pick.out, locale)} → ${dayLabel(pick.ret, locale)}` : dayLabel(pick.out, locale)}</p>
              <CellFlights key={`${pick.out}~${pick.ret}`} pick={pick} grid={grid} slug={slug} locale={locale} fetched={fetched} titled />
            </div>
          )}
        </Sheet>
      )}
    </div>,
    document.body
  );
}

/** Flights for one date pair, fetched on first pick. `titled` means the surrounding sheet already shows the dates. */
function CellFlights({ pick, grid, slug, locale, fetched, titled = false }: { pick: Pick; grid: GridView; slug: string; locale: string; fetched: Fetched; titled?: boolean }) {
  const oneRow = grid.returnDates.length === 0;
  const several = (grid.route?.to.length ?? grid.airports?.length ?? 1) > 1;
  // Keyed by the serialized request, so a widened grid (a new object, same route) doesn't refetch.
  const body = JSON.stringify({
    outDate: pick.out,
    returnDate: oneRow ? null : pick.ret,
    ...(grid.route ? { from: grid.route.from } : {}),
    ...(pick.via ? { to: pick.via.out, backFrom: pick.via.back, tickets: pick.via.tickets } : grid.route ? { to: grid.route.to[0] } : {}),
  });
  const [plans, setPlans] = useState<FlightPlan[] | null>(() => fetched.get(body)?.plans ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let entry = fetched.get(body);
    if (entry?.plans) return;
    if (!entry) {
      const wait = (async () => {
        const headers = { "content-type": "application/json", ...(await recaptchaHeaders("more")) };
        const res = await fetch(`/api/search/${slug}/more`, { method: "POST", headers, body });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Couldn’t load those dates");
        return data.plans as FlightPlan[];
      })();
      const made = { wait } as { plans?: FlightPlan[]; wait: Promise<FlightPlan[]> };
      wait.then(
        (p) => (made.plans = p),
        () => fetched.delete(body)
      );
      fetched.set(body, made);
      entry = made;
    }
    let live = true;
    entry.wait.then(
      (p) => live && setPlans(p),
      (e) => live && setError(shownError(e, "Couldn’t load those dates just now. Try again in a moment."))
    );
    return () => {
      live = false;
    };
  }, [body, slug, fetched]);
  const cheapest = plans?.length ? Math.min(...plans.map((p) => p.price)) : null;
  return (
    <div className="flex flex-col gap-3">
      {(!titled || (pick.via && (several || pick.via.tickets === "two"))) && (
        <div className={cx("flex flex-col gap-0.5", titled && "-mt-2")}>
          {!titled && (
            <p className="text-[15px] font-semibold text-ink">
              {dayLabel(pick.out, locale)}
              {!oneRow ? ` → ${dayLabel(pick.ret, locale)}` : ""}
            </p>
          )}
          {pick.via && (several || pick.via.tickets === "two") && (
            <p className="text-[13px] text-ink-muted">
              {pick.via.tickets === "two" ? "Two separate tickets" : "One ticket"}
              {several ? `, into ${city(pick.via.out)}${pick.via.back !== pick.via.out ? `, back from ${city(pick.via.back)}` : ""}` : ""}
            </p>
          )}
        </div>
      )}
      {!plans && !error && <CardSkeleton count={2} compact />}
      {error && <p className="text-[14px] text-warn">{error}</p>}
      {plans && plans.length === 0 && <p className="text-[14px] text-ink-muted">No flights on those days right now.</p>}
      {plans && plans.length > 0 && (
        <div className="flex flex-col gap-3">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} cheapest={cheapest} slug={slug} locale={locale} compact />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Grid ---------------------------------- */

/** An edge of the grid's date window, where the + and − buttons act. */
type Edge = "out-first" | "out-last" | "ret-first" | "ret-last";
const PLUS: Record<Edge, string> = { "out-first": "out-earlier", "out-last": "out-later", "ret-first": "ret-earlier", "ret-last": "ret-later" };

/**
 * The editable grid: + adds a day at an edge, − removes an edge day. Rapid clicks are debounced into one request.
 * The cells form a single Tab stop (roving tabindex); arrow keys move between them.
 */
function EditableGrid({
  grid,
  onGrid,
  slug,
  currency,
  locale,
  pick,
  onPick,
}: {
  grid: GridView;
  onGrid: (g: GridView) => void;
  slug: string;
  currency: string;
  locale: string;
  pick: Pick | null;
  onPick: (p: Pick | null) => void;
}) {
  const oneRow = grid.returnDates.length === 0;
  const fromGrid = (g: GridView): Win => ({
    out: [g.outDates[0], g.outDates[g.outDates.length - 1]],
    ret: g.returnDates.length ? [g.returnDates[0], g.returnDates[g.returnDates.length - 1]] : null,
  });
  const [win, setWin] = useState<Win>(() => fromGrid(grid));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The window waiting to be priced, debounced so several clicks become one request. */
  const [pending, setPending] = useState<Win | null>(null);
  const today = useMemo(() => todayDay(), []);
  /** Last focused cell, which holds the grid's Tab stop. */
  const [active, setActive] = useState<string | null>(null);
  // The + and − controls stay out of the way: with a mouse they show on hover or focus within the grid.
  // Touch screens have no hover, so they are hidden until "Change days" is pressed.
  const touch = useMedia("(pointer: coarse)");
  const [editing, setEditing] = useState(false);
  const controls = !touch || editing;
  const reveal = "transition-opacity duration-150 pointer-fine:opacity-0 pointer-fine:group-hover/grid:opacity-100 pointer-fine:group-focus-within/grid:opacity-100";

  // On open, centre the selected pair (else the asked dates, else the cheapest): horizontally below lg, vertically at any width.
  // Sets scrollLeft/scrollTop because scrollIntoView would scroll the panel too. Rects are divided by the panel's scale,
  // which is below 1 while it animates in.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = scroller.current;
    const cell = s?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? s?.querySelector<HTMLElement>("[data-asked]") ?? s?.querySelector<HTMLElement>("[data-best]");
    const head = s?.querySelector("thead");
    const pinned = s?.querySelector("thead th");
    if (!s || !cell || !head || !pinned) return;
    const box = s.getBoundingClientRect();
    const k = box.width / s.offsetWidth || 1;
    const c = cell.getBoundingClientRect();
    if (window.matchMedia("(max-width: 1023px)").matches) {
      const left = pinned.getBoundingClientRect().width;
      s.scrollLeft += (c.left + c.width / 2 - (box.left + left + (box.width - left) / 2)) / k;
    }
    const top = head.getBoundingClientRect().height;
    s.scrollTop += (c.top + c.height / 2 - (box.top + top + (s.clientHeight * k - top) / 2)) / k;
  }, []);

  // Reset the window when a follow-up rebuilds the grid.
  const shape = `${grid.outDates[0]}~${grid.outDates.at(-1)}~${grid.returnDates[0] ?? ""}~${grid.returnDates.at(-1) ?? ""}`;
  const [seenShape, setSeenShape] = useState(shape);
  if (shape !== seenShape) {
    setSeenShape(shape);
    setWin(fromGrid(grid));
  }

  function change(next: Win) {
    setWin(next);
    setError(null);
    setPending(next);
    // Clear the pick if its day is removed.
    if (pick && !(within(pick.out, next.out) && (!next.ret || within(pick.ret, next.ret)))) onPick(null);
  }
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/search/${slug}/grid`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await recaptchaHeaders("grid")) },
          body: JSON.stringify(pending),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.grid) throw new Error(data?.error ?? "Couldn’t price those dates");
        if (live) onGrid(data.grid as GridView);
      } catch (e) {
        if (live) {
          setError(shownError(e, "Couldn’t price those dates just now. Try again in a moment."));
          setWin(fromGrid(grid));
        }
      } finally {
        if (live) {
          setBusy(false);
          setPending(null);
        }
      }
    }, 650);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pending, slug, onGrid, grid]);

  // After a −, move focus to the new edge day's −, or to that edge's + when no more days can be removed.
  const refocus = useRef<Edge | null>(null);
  useEffect(() => {
    const edge = refocus.current;
    refocus.current = null;
    const s = scroller.current;
    if (!edge || !s) return;
    (s.querySelector<HTMLElement>(`[data-edge="${edge}"]`) ?? s.querySelector<HTMLElement>(`[data-edge="${PLUS[edge]}"]`))?.focus({ preventScroll: true });
  }, [win]);

  const outs = daysOf(win.out);
  const rets = win.ret ? daysOf(win.ret) : [];
  const byKey = new Map(grid.cells.map((c) => [`${c.outDate}~${c.returnDate}`, c]));
  const { min, max, best } = stats(grid);
  const into = grid.route?.to ?? grid.airports ?? [];
  const several = into.length > 1;
  const viaMark = (via: GridCell["via"]) => (!via || !several ? "" : via.out === via.back ? via.out : `${via.out}→${via.back}`);
  // The most common airport mark is left off the cells (the legend names it), so the exceptions stand out.
  const tally = new Map<string, number>();
  for (const c of grid.cells) {
    const m = viaMark(c.via);
    if (m) tally.set(m, (tally.get(m) ?? 0) + 1);
  }
  const usual = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const short = (n: number) => money(n, currency, locale);
  const markWords = (m: string) => {
    const [a, b] = m.split("→");
    return b ? `Into ${city(a)}, back from ${city(b)}` : `Into ${city(a)}`;
  };

  // Every edit must leave at least one possible pair: a return day after the first day out.
  const can = {
    outEarlier: win.out[0] > today && span(win.out) < MAX_DAYS,
    outLater: span(win.out) < MAX_DAYS,
    outTrimFirst: span(win.out) > 1 && (!win.ret || addDays(win.out[0], 1) < win.ret[1]),
    outTrimLast: span(win.out) > 1,
    retEarlier: !!win.ret && addDays(win.ret[0], -1) > win.out[0] && span(win.ret) < MAX_DAYS,
    retLater: !!win.ret && span(win.ret) < MAX_DAYS,
    retTrimFirst: !!win.ret && span(win.ret) > 1,
    retTrimLast: !!win.ret && span(win.ret) > 1 && addDays(win.ret[1], -1) > win.out[0],
  };
  const edit = {
    outEarlier: () => change({ ...win, out: [addDays(win.out[0], -1), win.out[1]] }),
    outLater: () => change({ ...win, out: [win.out[0], addDays(win.out[1], 1)] }),
    outTrimFirst: () => change({ ...win, out: [addDays(win.out[0], 1), win.out[1]] }),
    outTrimLast: () => change({ ...win, out: [win.out[0], addDays(win.out[1], -1)] }),
    retEarlier: () => win.ret && change({ ...win, ret: [addDays(win.ret[0], -1), win.ret[1]] }),
    retLater: () => win.ret && change({ ...win, ret: [win.ret[0], addDays(win.ret[1], 1)] }),
    retTrimFirst: () => win.ret && change({ ...win, ret: [addDays(win.ret[0], 1), win.ret[1]] }),
    retTrimLast: () => win.ret && change({ ...win, ret: [win.ret[0], addDays(win.ret[1], -1)] }),
  };

  // + and − use aria-disabled because a disabled button drops focus to the page.
  const addBtn = (label: string, edge: string, on: boolean, fn: () => void) => {
    const off = !on || busy;
    return (
      <button
        type="button"
        data-edge={edge}
        onClick={() => !off && fn()}
        aria-disabled={off || undefined}
        aria-label={label}
        title={label}
        // On touch screens ::after enlarges the hit area to 44px around the 20px button.
        className={cx(
          "press relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-accent-soft hover:text-accent aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']",
          reveal
        )}
      >
        <Plus className="h-3 w-3" strokeWidth={2.4} />
      </button>
    );
  };
  const trimBtn = (label: string, edge: Edge, on: boolean, fn: () => void, side: "top" | "left") =>
    on && controls ? (
      <button
        type="button"
        data-edge={edge}
        onClick={(e) => {
          if (busy) return;
          if (document.activeElement === e.currentTarget) refocus.current = edge;
          fn();
        }}
        aria-disabled={busy || undefined}
        aria-label={label}
        title={label}
        className={cx(
          // Already absolute, so the touch-target ::after (40px around the 16px dot) needs no `relative`.
          "press absolute z-10 flex h-4 w-4 items-center justify-center rounded-full text-ink-muted hover:bg-soft hover:text-ink aria-disabled:cursor-default aria-disabled:opacity-30 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']",
          reveal,
          // A column's − is centred above its header and a row's sits left of its label, so each clearly belongs to one day.
          side === "top" ? "-top-[17px] left-1/2 -translate-x-1/2" : "top-1/2 -left-[15px] -translate-y-1/2"
        )}
      >
        <Minus className="h-2.5 w-2.5" strokeWidth={2.6} />
      </button>
    ) : null;
  const head = (d: string, trim?: React.ReactNode) => (
    <span className="relative flex flex-col items-center rounded-lg px-1.5 py-0.5 leading-tight">
      <span className="text-[11px] font-medium text-ink-muted">{weekday(d, locale)}</span>
      <span className="nums text-[12.5px] font-semibold whitespace-nowrap text-ink">{shortDay(d, locale)}</span>
      {trim}
    </span>
  );
  // Pinned headers carry their own padding and background: sticky sticks at the scroller's padding edge, so scroller padding
  // would leave a gap that scrolled prices show through. The shadow paints over the gaps between cells. Top headers stack
  // above side headers, and the corner above both. The top padding makes room for the column − buttons.
  const pinned = cx("sticky left-0 z-20 bg-paper shadow-[2px_0_0_2px_var(--color-paper)]", controls ? "pl-6" : "pl-1");
  const stuck = cx("sticky top-0 z-30 bg-paper shadow-[0_2px_0_2px_var(--color-paper)]", controls ? "pt-5" : "pt-1");
  const corner = cx("sticky top-0 left-0 z-40 bg-paper shadow-[2px_2px_0_2px_var(--color-paper)]", controls ? "pt-5 pl-6" : "pt-1 pl-1");
  const plusCols = controls && !oneRow;
  const cols = oneRow ? 1 : rets.length;

  // Focusable cells by key. The Tab stop is the last focused, else the pick, the asked dates, the cheapest, or the first.
  const askedKey = `${grid.requested.out}~${oneRow ? grid.requested.out : grid.requested.ret}`;
  const loadingNow = busy || pending != null;
  const live = new Set<string>();
  for (const o of outs)
    for (const r of oneRow ? [o] : rets) {
      const k = `${o}~${r}`;
      if ((oneRow || r > o) && !(byKey.get(k) == null && loadingNow)) live.add(k);
    }
  const stop = [active, pick && `${pick.out}~${pick.ret}`, askedKey, best && `${best.outDate}~${best.returnDate}`].find((k): k is string => !!k && live.has(k)) ?? [...live][0];

  // Arrow keys move between cells, skipping impossible pairs; Home and End jump to the row's ends.
  // Scrolls manually so the focused cell clears the pinned headers.
  const onKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const s = scroller.current;
    const at = (e.target as HTMLElement).dataset.cell;
    if (!s || !at || e.altKey || e.ctrlKey || e.metaKey) return;
    const [oi, ci] = at.split(":").map(Number);
    const cellAt = (o: number, c: number) => s.querySelector<HTMLElement>(`button[data-cell="${o}:${c}"]`);
    const steps: Record<string, [number, number]> = oneRow
      ? { ArrowUp: [-1, 0], ArrowLeft: [-1, 0], ArrowDown: [1, 0], ArrowRight: [1, 0] }
      : { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    let next: HTMLElement | null = null;
    if (steps[e.key]) {
      const [dO, dC] = steps[e.key];
      for (let o = oi + dO, c = ci + dC; !next && o >= 0 && o < outs.length && c >= 0 && c < cols; o += dO, c += dC) next = cellAt(o, c);
    } else if (e.key === "Home" || e.key === "End") {
      const row = [...s.querySelectorAll<HTMLElement>(oneRow ? "button[data-cell]" : `button[data-cell^="${oi}:"]`)];
      next = (e.key === "Home" ? row[0] : row.at(-1)) ?? null;
    } else return;
    e.preventDefault();
    if (!next) return;
    next.focus({ preventScroll: true });
    const box = s.getBoundingClientRect();
    const c = next.getBoundingClientRect();
    const top = box.top + (s.querySelector("thead")?.getBoundingClientRect().height ?? 0);
    const left = box.left + (s.querySelector("thead th")?.getBoundingClientRect().width ?? 0);
    const bottom = box.top + s.clientTop + s.clientHeight;
    const right = box.left + s.clientLeft + s.clientWidth;
    if (c.top < top) s.scrollTop -= top - c.top + 6;
    else if (c.bottom > bottom) s.scrollTop += c.bottom - bottom + 6;
    if (c.left < left) s.scrollLeft -= left - c.left + 6;
    else if (c.right > right) s.scrollLeft += c.right - right + 6;
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* Above the table so it stays visible on a tall grid. Errors are rare, so the layout shift is acceptable. */}
      {error && <p role="alert" className="text-[12.5px] text-warn">{error}</p>}
      <p role="status" className="sr-only">
        {busy ? "Pricing the new days…" : ""}
      </p>
      {/* Scrolls both ways so headers stay pinned. pb-2 fits the last +'s touch target; lg:pr-4 keeps the + off the divider. */}
      <div ref={scroller} onKeyDown={onKeys} className="group/grid -mx-5 min-h-0 overflow-auto overscroll-contain pr-5 pb-2 sm:-mx-7 sm:pr-7 lg:pr-4">
        {/* Columns stretch up to about 6rem each, then the table centres; below 3.4rem each it scrolls sideways. */}
        <table className="mx-auto w-full border-separate border-spacing-1" style={{ maxWidth: `calc(${cols} * 6.25rem + 9rem)` }}>
          <thead>
            <tr>
              <th className={cx("w-px pr-1 text-left align-bottom", corner)}>
                {/* "Pricing…" fills the corner while new days price; both labels share one grid cell so nothing shifts. */}
                <span className="grid pb-1 text-[11px] leading-tight font-medium whitespace-nowrap">
                  <span className={cx("col-start-1 row-start-1 flex flex-col text-ink-muted", busy && "invisible")}>
                    {oneRow ? "Leaving" : <span className="sr-only">Leaving down the side, back along the top</span>}
                  </span>
                  <span aria-hidden className={cx("col-start-1 row-start-1 flex items-center gap-1 text-accent", !busy && "invisible")}>
                    <Spinner className="h-3 w-3" /> Pricing…
                  </span>
                </span>
              </th>
              {plusCols && <th className={cx("w-px px-0.5 align-middle", stuck)}>{addBtn("Come back a day earlier", "ret-earlier", can.retEarlier, edit.retEarlier)}</th>}
              {!oneRow &&
                rets.map((r, i) => (
                  // Named by the day alone, or the − button's label would be read out with every price in the column.
                  <th key={r} scope="col" aria-label={dayLabel(r, locale)} className={cx("pb-1 font-normal", stuck)}>
                    {head(
                      r,
                      i === 0
                        ? trimBtn(`Take ${shortDay(r, locale)} off the days back`, "ret-first", can.retTrimFirst, edit.retTrimFirst, "top")
                        : i === rets.length - 1
                          ? trimBtn(`Take ${shortDay(r, locale)} off the days back`, "ret-last", can.retTrimLast, edit.retTrimLast, "top")
                          : null
                    )}
                  </th>
                ))}
              {plusCols && <th className={cx("w-px px-0.5 align-middle", stuck)}>{addBtn("Come back a day later", "ret-later", can.retLater, edit.retLater)}</th>}
            </tr>
          </thead>
          <tbody>
            {controls && (
              <tr>
                <td className={cx("py-0.5", pinned)}>
                  <span className="flex justify-center">{addBtn("Leave a day earlier", "out-earlier", can.outEarlier, edit.outEarlier)}</span>
                </td>
                <td colSpan={cols + (plusCols ? 2 : 0)} />
              </tr>
            )}
            {outs.map((o, oi) => (
              <tr key={o}>
                <th scope="row" aria-label={dayLabel(o, locale)} className={cx("w-px pr-1.5 text-left font-normal whitespace-nowrap", pinned)}>
                  {head(
                    o,
                    oi === 0
                      ? trimBtn(`Take ${shortDay(o, locale)} off the days out`, "out-first", can.outTrimFirst, edit.outTrimFirst, "left")
                      : oi === outs.length - 1
                        ? trimBtn(`Take ${shortDay(o, locale)} off the days out`, "out-last", can.outTrimLast, edit.outTrimLast, "left")
                        : null
                  )}
                </th>
                {plusCols && <td />}
                {(oneRow ? [o] : rets).map((r, ci) => {
                  const key = `${o}~${r}`;
                  const cell = byKey.get(key);
                  const price = cell?.price;
                  const via = cell?.via;
                  const impossible = !oneRow && r <= o;
                  // New days shimmer during the debounce instead of showing "no fare".
                  const loading = !impossible && cell == null && loadingNow;
                  const asked = key === askedKey;
                  const selected = pick?.out === o && pick?.ret === r;
                  const mark = viaMark(via);
                  const two = via?.tickets === "two";
                  const how = via ? `${two ? "two separate tickets" : "one ticket"}${several ? `, into ${city(via.out)}${via.back !== via.out ? ` and back from ${city(via.back)}` : ""}` : ""}${two && cell?.oneTicket ? `; one ticket is ${short(cell.oneTicket)}` : ""}` : "";
                  return (
                    <td key={r} className="p-0">
                      {impossible ? (
                        <span className="block h-11 min-w-[3.4rem]" aria-hidden />
                      ) : loading ? (
                        <span className="shimmer block h-11 min-w-[3.4rem] rounded-[10px]" aria-hidden />
                      ) : (
                        <button
                          type="button"
                          data-cell={`${oi}:${ci}`}
                          tabIndex={key === stop ? 0 : -1}
                          onFocus={() => setActive(key)}
                          onClick={() => price != null && onPick({ out: o, ret: r, via })}
                          aria-disabled={price == null || undefined}
                          title={how || undefined}
                          aria-pressed={selected}
                          data-asked={asked || undefined}
                          data-best={(cell != null && cell === best) || undefined}
                          aria-label={`${dayLabel(o, locale)}${oneRow ? "" : ` to ${dayLabel(r, locale)}`}${price != null ? `, ${money(price, currency, locale)}` : ", no fare"}${how ? `, ${how}` : ""}${asked ? ", your dates" : ""}`}
                          className={cx(
                            // Tight padding fits a ² or open-jaw mark in 3.4rem, so ten columns fit beside the flights.
                            "press nums relative flex h-11 w-full min-w-[3.4rem] flex-col items-center justify-center rounded-[10px] px-0.5 text-[12.5px] font-semibold",
                            tone(price, min, max),
                            // Asked dates: dashed ring on ::before, so the focus (solid) and pick (inset) rings don't hide it.
                            asked &&
                              "before:pointer-events-none before:absolute before:-inset-[3px] before:rounded-[13px] before:border-[1.5px] before:border-dashed before:border-accent before:content-[''] focus-visible:outline-none focus-visible:before:-inset-[4px] focus-visible:before:rounded-[14px] focus-visible:before:border-2 focus-visible:before:border-solid",
                            selected && (asked ? "ring-2 ring-ink ring-inset" : "ring-2 ring-ink ring-offset-1"),
                            price == null ? "cursor-default" : "hover:brightness-[0.96]"
                          )}
                        >
                          <span className="leading-none">
                            {price != null ? short(price) : "—"}
                            {two && <sup className="ml-px text-[8.5px] font-bold opacity-80">2</sup>}
                          </span>
                          {mark && mark !== usual && <span className="mt-0.5 text-[9px] leading-none font-medium opacity-75">{mark}</span>}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {controls && (
              <tr>
                <td className={cx("pt-0.5", pinned)}>
                  <span className="flex justify-center">{addBtn("Leave a day later", "out-later", can.outLater, edit.outLater)}</span>
                </td>
                <td colSpan={cols + (plusCols ? 2 : 0)} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-good" /> Cheapest
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-good-soft ring-1 ring-good/25" /> Close to it
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] outline-[1.5px] outline-accent outline-dashed" /> Your dates
        </span>
        {grid.cells.some((c) => c.via?.tickets === "two") && (
          <span>
            <sup aria-hidden className="mr-0.5 text-[8.5px] font-bold">2</sup>Two separate tickets, cheaper than one
          </span>
        )}
        {several && usual && <span>{tally.size > 1 ? `${markWords(usual)} unless marked` : markWords(usual)}</span>}
        {several && !usual && (
          <span>
            Into {into.map(city).join(" or ")}
            {grid.mixed ? `, back from ${into.length > 2 ? "any" : "either"}` : ""}
          </span>
        )}
        {touch && (
          <button type="button" onClick={() => setEditing((e) => !e)} aria-pressed={editing} className="press ml-auto -my-3 flex h-11 items-center px-1 text-[13px] font-semibold text-accent">
            {editing ? "Done" : "Change days"}
          </button>
        )}
      </div>
    </div>
  );
}
