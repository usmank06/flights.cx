"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle } from "lucide-react";
import { askedInWords, isOpenDestination } from "@/lib/search/intake";
import { money } from "@/lib/format";
import type { FollowUp, GridCell, GridView, SearchRecord } from "@/lib/types";
import { SiteHeader } from "@/components/site/header";
import { CloudBand } from "@/components/site/cloud-band";
import { useNowSecond } from "@/components/ui/use-now";
import { Button, cx } from "@/components/ui/primitives";
import { DetailsProvider } from "@/components/results/plan-details";
import { PlanCard } from "@/components/results/plan-card";
import { DatesButton, GridPanel } from "@/components/results/dates";
import { Places } from "@/components/results/places";
import { InsightChip } from "@/components/results/insight";
import { CurrencyNote, EditSearchButton, Freshness, RailFreshness, SearchAgainButton, ShareButton, TrackButton } from "@/components/results/actions";
import { useWatch } from "@/components/watch/watch-price";
import { PAGE, RAILED } from "@/components/results/columns";
import { HowItWorks } from "@/components/site/how-it-works";
import { FollowUps, useAsk } from "@/components/results/follow-ups";
import { preloadLogos } from "@/components/results/airline-logo";
import { carrierCodes, endsFlown, placeOf, plansDifferOnlyInPrice, type Named } from "@/components/results/plan-meta";
import { ChatIndex } from "@/components/results/chat-index";
import { leftOutLine } from "@/components/results/left-out";
import { addDays, rangeLabel, shortDay, todayDay } from "./dates";
import { TripSummary } from "./edit-search";
import { SearchProgress, takesAbout } from "./progress";
import { recaptchaHeaders, useLiveSearch } from "./search-client";
import { useTitle } from "./use-title";
import { shownError } from "@/components/ui/errors";

const WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * A sideways-scrolling chip row looks complete if its edge falls between two chips. Until the row is scrolled, this pulls the fade in
 * (`--cut`) far enough to cut through the last visible chip, so the row clearly continues.
 */
function usePeek(row: RefObject<HTMLDivElement | null>, key: unknown) {
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const fit = () => {
      let cut = 0;
      if (el.scrollLeft < 1 && el.scrollWidth > el.clientWidth + 1) {
        const edge = el.getBoundingClientRect().right;
        // The last chip showing at least 24px of itself.
        const last = [...el.children]
          .map((c) => c.getBoundingClientRect())
          .filter((b) => b.width > 0 && b.left < edge - 24)
          .at(-1);
        // Move the fade in until it cuts at least 8px off that chip.
        if (last && last.right < edge + 8) cut = Math.ceil(edge + 8 - last.right);
      }
      el.style.setProperty("--cut", `${cut}px`);
    };
    // Chip labels change width ("Link copied") and chips come and go, so re-measure on any change.
    const sizes = new ResizeObserver(fit);
    const observe = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const c of el.children) sizes.observe(c);
    };
    observe();
    const kids = new MutationObserver(observe);
    kids.observe(el, { childList: true });
    el.addEventListener("scroll", fit, { passive: true });
    return () => {
      sizes.disconnect();
      kids.disconnect();
      el.removeEventListener("scroll", fit);
    };
  }, [row, key]);
}

/**
 * The search page from start to finish: progress, results, sharing and follow-up questions. While running it follows this browser's
 * stream if it has one, and otherwise polls the record.
 */
export function SearchView({ initial, estimate = null }: { initial: SearchRecord; estimate?: number | null }) {
  const live = useLiveSearch(initial.slug);
  // Prefer the stream's final record, then the polled one, then the served one. Follow-ups patch whichever is shown.
  const [polled, setPolled] = useState<SearchRecord | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[] | null>(null);
  const base = live?.record ?? polled ?? initial;
  const record: SearchRecord = followUps ? { ...base, followUps } : base;
  const now = useNowSecond();

  // A stream that dropped before its last frame counts as none, so the page falls back to polling.
  const streaming = live != null && (live.running || live.record != null);
  const running = streaming ? live.running && !live.record : record.status === "running";

  // Without a stream, poll the record until it stops running (a lost search reads as stopped once stale, via `withLiveness`).
  // After two failed polls show "reconnecting" and back off, retrying at once when the browser comes back online.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (!running || streaming) return;
    let cancelled = false;
    let busy = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        const res = await fetch(`/api/search/${initial.slug}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as SearchRecord;
        if (cancelled) return;
        misses = 0;
        setReconnecting(false);
        setPolled(next);
        if (next.status !== "running") return;
      } catch {
        if (cancelled) return;
        if (++misses >= 2) setReconnecting(true);
      } finally {
        busy = false;
      }
      timer = setTimeout(tick, Math.min(10_000, 2_000 * 1.5 ** misses));
    };
    const back = () => void tick();
    const lost = () => setReconnecting(true);
    window.addEventListener("online", back);
    window.addEventListener("offline", lost);
    timer = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", back);
      window.removeEventListener("offline", lost);
    };
  }, [running, streaming, initial.slug]);

  // The stream has no plan, so fetch the record once planning is done to show the route.
  const livePhase = streaming ? live.phase : null;
  const hasPlan = record.plan != null;
  useEffect(() => {
    if (!running || !livePhase || livePhase === "starting" || livePhase === "planning" || hasPlan) return;
    let cancelled = false;
    fetch(`/api/search/${initial.slug}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SearchRecord>) : null))
      .then((next) => {
        if (!cancelled && next?.plan && next.status === "running") setPolled(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, livePhase, hasPlan, initial.slug]);
  useTitle(record);

  const started = useMemo(() => live?.startedAt ?? Date.parse(record.createdAt), [live?.startedAt, record.createdAt]);
  const runFor = now ? now - started : 0;

  const req = record.request;
  const planned = record.plan;
  const open = record.view?.kind === "open" || (planned != null && planned.destinations.length === 0) || (!planned && !askedInWords(req) && isOpenDestination(req.to));
  const plans = useMemo(() => record.plans ?? [], [record.plans]);
  const cheapest = plans.length ? Math.min(...plans.map((p) => p.price)) : null;
  const done = !running && record.status !== "error";
  const view = record.view;
  const v = record.verdict;
  const saved = v?.saved != null && v.saved > 0 ? v.saved : null;
  const n = plans.length;
  // The requested airports, so cards can flag others. The heading lists every airport the cards use, requested ones first.
  const named = useMemo<Named | null>(() => (planned ? { from: planned.origins.map((o) => o.code), to: planned.destinations.map((d) => d.code) } : null), [planned]);
  const heading = useMemo(() => (planned && done && plans.length ? endsFlown(planned, plans) : planned), [planned, done, plans]);
  // One watch for the page, shared by the rail's Track prices and the row's.
  const watch = useWatch(record.slug);

  // Preload airline logos as soon as results arrive, before the cards animate in.
  useEffect(() => {
    if (plans.length) preloadLogos(plans.flatMap((p) => p.legs.flatMap(carrierCodes)));
  }, [plans]);

  /* ---- the chat: questions, answers, and the one date grid ---- */

  const onFollowUp = useCallback(
    (f: FollowUp) =>
      setFollowUps((cur) => {
        const list = cur ?? base.followUps;
        return list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f];
      }),
    [base.followUps]
  );
  const { ask, sending, error: askError } = useAsk(record.slug, record.followUps, onFollowUp);

  const [grid, setGrid] = useState<GridView | null>(view?.grid ?? null);
  const [gridOpen, setGridOpen] = useState(false);
  const [gridFocus, setGridFocus] = useState<{ out: string; ret: string; via?: GridCell["via"] } | null>(null);
  const [building, setBuilding] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  // Adopt the record's grid when it changes underneath (e.g. the stream's final record).
  const recordGrid = view?.grid ?? null;
  const [seenGrid, setSeenGrid] = useState(recordGrid);
  if (recordGrid !== seenGrid) {
    setSeenGrid(recordGrid);
    if (recordGrid) setGrid(recordGrid);
  }
  // When a follow-up rebuilds the grid, fetch the new one.
  const rebuilt = record.followUps.filter((f) => f.gridUpdated && f.status === "answered").map((f) => f.id).join(",");
  useEffect(() => {
    if (!rebuilt) return;
    let live = true;
    fetch(`/api/search/${record.slug}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((rec: SearchRecord | null) => {
        if (live && rec?.view?.grid) setGrid(rec.view.grid);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rebuilt, record.slug]);

  // With a route but no grid (fixed dates), build one around the dates on first open.
  const canGrid = done && n > 0 && !open && (grid != null || planned != null);
  async function openGrid() {
    setGridError(null);
    if (grid) return setGridOpen(true);
    if (!planned) return;
    const today = todayDay();
    const around = (d: string): [string, string] => {
      const a = addDays(d, -3) < today ? today : addDays(d, -3);
      return [a, addDays(d, 3)];
    };
    const out = around(planned.dates.anchor.out);
    const ret = planned.dates.anchor.ret ? around(planned.dates.anchor.ret) : null;
    setBuilding(true);
    try {
      const res = await fetch(`/api/search/${record.slug}/grid`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await recaptchaHeaders("grid")) },
        body: JSON.stringify({ out, ret }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.grid) throw new Error(data?.error ?? "Couldn’t price the dates around yours");
      setGrid(data.grid as GridView);
      setGridOpen(true);
    } catch (e) {
      setGridError(shownError(e, "Couldn’t price the dates around yours just now. Try again in a moment."));
    } finally {
      setBuilding(false);
    }
  }

  // Edit panel state sits at page level so a failed search's card can open it.
  const [editing, setEditing] = useState(false);
  const change = (
    <Button variant="primary" size="md" onClick={() => setEditing(true)} className="max-sm:w-full">
      Edit search
    </Button>
  );

  // Below sm the actions are one sideways-scrolling row; usePeek makes that visible.
  const actionsRow = useRef<HTMLDivElement>(null);
  usePeek(actionsRow, done && n > 0);

  // Scroll to the top when the search finishes.
  useEffect(() => {
    if (!running) window.scrollTo({ top: 0 });
  }, [running]);

  const title = running
    ? "Finding the best way to fly it"
    : record.status === "error"
      ? // Stopped by a problem on our side, or the request needs a change. The card below says which.
        record.errorTheirs
        ? "No flights to show"
        : "We ran into an issue"
      : !n
        ? "No flights found"
        : n === 1
          ? open
            ? "The place we found"
            : "The result we found"
          : `The ${WORD[n] ?? n} ${open ? "places" : "results"} we found`;

  const same = n > 1 && plansDifferOnlyInPrice(plans);
  // Show the rail when it has content, and while running so the layout doesn't jump when results land.
  const rail = running || (done && (n > 0 || record.followUps.length >= 2));
  // Grid days cheaper than every plan: the grid price wasn't a bookable fare (no flights, or pricier when checked).
  const missed = done && n > 0 && grid ? (v?.gridCheaper ?? null) : null;
  const seeInGrid = (days: { outDate: string; returnDate: string }) => {
    if (!grid) return;
    const cell = grid.cells.find((c) => c.outDate === days.outDate && c.returnDate === days.returnDate);
    setGridFocus({ out: days.outDate, ret: days.returnDate, via: cell?.via });
    void openGrid();
  };
  // Lookups that never answered in time, apart from the dates the note above already covers.
  const leftOut = done && n > 0 && v?.incomplete ? leftOutLine(v.incomplete, req.locale, missed?.unconfirmed ? missed : null) : null;
  const leftOutDays =
    (leftOut && grid
      ? (v?.incomplete?.dates ?? []).flatMap(({ outDate, returnDate }) =>
          returnDate && !(missed?.unconfirmed && outDate === missed.outDate && returnDate === missed.returnDate) && grid.cells.some((c) => c.outDate === outDate && c.returnDate === returnDate) ? [{ outDate, returnDate }] : []
        )[0]
      : null) ?? null;

  const insight = done && view && view.kind !== "open" ? <InsightChip insights={view.insights} hints={view.hints} currency={req.currency} locale={req.locale} /> : null;
  const railInsight = done && view && view.kind !== "open" ? <InsightChip wide insights={view.insights} hints={view.hints} currency={req.currency} locale={req.locale} /> : null;

  return (
    <DetailsProvider named={named}>
      <div className="relative isolate min-h-dvh bg-ground">
        <CloudBand className="h-[260px] sm:h-[330px]" />
        <SiteHeader />
        <HowItWorks />
        <div className={cx(PAGE, "pt-4 pb-10 sm:pt-8 has-[[data-bar-room]]:pb-0", rail && RAILED)}>
          {/* The rail (lg and up): search actions and the follow-up index. */}
          {rail && (
            <aside data-rail className="hidden lg:block" aria-label="This search">
              {/* z-10: the price popover opens over the pane. */}
              {/* top-22 (56px header + 32px) is where it already sits, so it doesn't shift on scroll; pt-8 levels it with the trip. */}
              {/* Capped at the viewport minus top-22 and the How it works pill (1rem + 2.5rem + 1rem), so only the chat index scrolls. */}
              {/* data-short (set in chat-index.tsx) means the window is too short for that, so the rail scrolls with the page. */}
              <div className="sticky top-22 z-10 flex max-h-[calc(100dvh-10rem)] flex-col gap-0.5 pt-8 data-short:static data-short:max-h-none">
                {done && <RailFreshness capturedAt={record.capturedAt} locale={req.locale} />}
                <EditSearchButton onClick={() => setEditing(true)} />
                {done && record.capturedAt && <SearchAgainButton slug={record.slug} />}
                {done && n > 0 && <div aria-hidden className="mx-2.5 my-2 h-px bg-rule" />}
                {done && n > 0 && (
                  <>
                    {canGrid && <DatesButton wide grid={grid} plans={plans} currency={req.currency} locale={req.locale} onOpen={() => void openGrid()} busy={building} />}
                    {railInsight}
                    <ShareButton wide />
                    <TrackButton wide slug={record.slug} best={cheapest} departDate={req.departDate} currency={req.currency} locale={req.locale} state={watch} />
                    {gridError && <p className="px-1 text-[12.5px] text-warn">{gridError}</p>}
                  </>
                )}
                <ChatIndex followUps={record.followUps} />
              </div>
            </aside>
          )}

          <main className="relative isolate mx-auto flex w-full max-w-[820px] min-w-0 flex-col gap-5 px-1.5 py-5 sm:gap-7 sm:px-2 sm:py-8 has-[[data-bar-room]]:pb-0">
            <TripSummary slug={record.slug} request={req} plan={heading} running={running} editing={editing} onEditing={setEditing} railed={rail} failed={!running && record.status === "error"} />

            {running ? (
              // From the stream while it flows, otherwise from the record.
              <SearchProgress
                title={title}
                phase={streaming ? live.phase : record.phase}
                began={streaming ? live.began : (record.tally?.began ?? live?.began ?? {})}
                found={streaming ? live.found : (record.tally ?? live?.found ?? null)}
                lines={live?.lines ?? null}
                ms={runFor}
                expectMs={estimate ?? (open ? 120_000 : 70_000)}
                takes={takesAbout(estimate, open)}
                reconnecting={reconnecting}
              />
            ) : (
              <header className="flex flex-col gap-3">
                {/* Phone sizes keep the first card above the ask bar. "Demo data" wraps under the title when both don't fit. */}
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <h1 className="display text-[26px] leading-[1.08] font-semibold text-balance text-ink sm:text-[46px] sm:leading-[1.02]">{title}</h1>
                  {record.mode === "demo" && (
                    <span title="This search ran against a simulated market, and its prices were invented." className="shrink-0 rounded-full bg-warn-soft px-2.5 py-1 text-[12.5px] font-semibold text-warn">
                      Demo data
                    </span>
                  )}
                </div>
                {done && n > 0 && record.analysis && <p className="words max-w-[44rem] text-[16px] leading-[1.55] text-ink-soft sm:text-[18.5px] sm:leading-[1.6]">{record.analysis}</p>}
                {missed && (
                  <p className="max-w-[44rem] text-[13.5px] leading-relaxed text-ink-muted">
                    {grid && grid.returnDates.length ? rangeLabel(missed.outDate, missed.returnDate, req.locale) : shortDay(missed.outDate, req.locale)} looked cheaper at{" "}
                    <span className="nums">{money(missed.price, req.currency, req.locale)}</span> in the date grid, but{" "}
                    {missed.unconfirmed ? "we couldn’t confirm those dates in time" : missed.found == null ? "we couldn’t find those flights when we checked" : <>when we checked, the best we found was <span className="nums">{money(missed.found, req.currency, req.locale)}</span></>}.{" "}
                    <button type="button" onClick={() => seeInGrid(missed)} className="font-semibold text-accent hover:underline">
                      See them in the grid
                    </button>
                  </p>
                )}
                {leftOut && (
                  <p className="max-w-[44rem] text-[13.5px] leading-relaxed text-warn">
                    {leftOut}
                    {leftOutDays && (
                      <>
                        {" "}
                        <button type="button" onClick={() => seeInGrid(leftOutDays)} className="font-semibold text-accent hover:underline">
                          See them in the grid
                        </button>
                      </>
                    )}
                  </p>
                )}
                {same && <p className="text-[13.5px] text-warn">These are the same flights, just at different prices.</p>}
                {done && n > 0 && <CurrencyNote slug={record.slug} currency={req.currency} />}
                {/* Rail actions below lg; on phones one scrolling row, padded so chip shadows aren't clipped. */}
                {done && n > 0 && (
                  <div
                    ref={actionsRow}
                    className="no-scrollbar flex gap-2 pt-1 lg:hidden max-sm:-mx-4 max-sm:-mt-1 max-sm:-mb-7 max-sm:scroll-px-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-7 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%_-_1rem_-_var(--cut,0px)),transparent_calc(100%_-_var(--cut,0px)))] sm:flex-wrap"
                  >
                    {canGrid && <DatesButton grid={grid} currency={req.currency} locale={req.locale} onOpen={() => void openGrid()} busy={building} className="max-sm:h-10 pointer-coarse:h-10" />}
                    <TrackButton slug={record.slug} best={cheapest} departDate={req.departDate} currency={req.currency} locale={req.locale} state={watch} />
                    {insight}
                    <ShareButton />
                  </div>
                )}
                {gridError && <p className="text-[13px] text-warn lg:hidden">{gridError}</p>}
              </header>
            )}

            {!running && record.status === "error" && (
              <section className="rise flex flex-col gap-4 rounded-[24px] bg-warn-soft px-5 py-5 sm:px-6">
                <p className="flex items-start gap-2.5 text-[15px] leading-relaxed text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.2} />
                  {record.error ?? "Something on our side stopped this search before it finished. It’s been logged — try again in a little while."}
                </p>
                <Freshness record={record} before={change} />
              </section>
            )}

            {done && n > 0 && (
              <>
                <div className="flex flex-col gap-5">
                  {plans.map((p, i) => (
                    <PlanCard key={p.id} plan={p} cheapest={cheapest} saved={saved} slug={record.slug} locale={req.locale} index={i} place={view?.kind === "open" ? placeOf(p, view.destinations) : null} />
                  ))}
                </div>
                {view?.kind === "open" && view.destinations && view.destinations.some((d) => d.price != null) && (
                  <div className="pt-2">
                    <Places
                      destinations={view.destinations}
                      slug={record.slug}
                      currency={req.currency}
                      locale={req.locale}
                      cards={plans}
                      heading={{ title: "More places you could go", sub: "The cheapest fare to each, on your dates." }}
                    />
                  </div>
                )}
                <Freshness record={record} railed={rail} />
              </>
            )}

            {done && n === 0 && (
              <section className="slip flex flex-col gap-4 rounded-[24px] px-5 py-5 sm:px-6">
                <p className="text-[15px] leading-relaxed text-ink-soft">We couldn’t find any flights for this trip. Try other dates or a nearby airport.</p>
                <Freshness record={record} before={change} />
              </section>
            )}

            {done && (
              <div className={cx("pt-2")}>
                <FollowUps
                  slug={record.slug}
                  followUps={record.followUps}
                  currency={req.currency}
                  locale={req.locale}
                  cheapest={cheapest}
                  plans={plans}
                  ask={ask}
                  sending={sending}
                  error={askError}
                  onOpenGrid={() => void openGrid()}
                  rail={rail}
                />
              </div>
            )}
          </main>
        </div>
      </div>
      {grid && (
        <GridPanel
          open={gridOpen}
          onClose={() => setGridOpen(false)}
          grid={grid}
          onGrid={setGrid}
          slug={record.slug}
          currency={req.currency}
          locale={req.locale}
          onAsk={ask}
          sending={sending}
          error={askError}
          focus={gridFocus}
        />
      )}
    </DetailsProvider>
  );
}
