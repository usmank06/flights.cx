"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Grid3x3, MessageCircle, AlertTriangle } from "lucide-react";
import { money } from "@/lib/format";
import type { FlightPlan, FollowUp } from "@/lib/types";
import { cx } from "@/components/ui/primitives";
import { Places } from "./places";
import { PlanCard } from "./plan-card";
import { returnToPick } from "./plan-meta";
import { shownError } from "@/components/ui/errors";
import { recaptchaHeaders } from "@/components/search/search-client";
import { PAGE, RAILED } from "./columns";

/** Same test as recaptchaToken() in search-client.ts: whether reCAPTCHA runs, and so whether its notice must be shown. */
const RECAPTCHA_SHOWN = (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_RECAPTCHA_LOCAL === "1") && Boolean(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY);

/** Smooth scrolling unless the user prefers reduced motion. */
export const scrollMotion = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** Height of the fade above the ask bar, px, so content scrolling under it fades out instead of cutting off sharply. */
const FADE = 24;

/** Whether the example questions show over the ask bar before the first follow-up. */
const EXAMPLES_ON = false;

/**
 * Up to three example questions, skipping any the cards already answer (no "Is there a nonstop?" when one is).
 * The last asks for 10% under the cheapest price, and is left out when there are no prices.
 */
function examples(currency: string, locale: string, cheapest: number | null, plans: FlightPlan[]): string[] {
  const under = cheapest ? Math.floor((cheapest * 0.9) / 10) * 10 : 0;
  const nonstop = plans.some((p) => p.legs.length > 0 && !returnToPick(p) && p.legs.every((l) => l.stops === 0));
  return ["Anything cheaper a day later?", ...(nonstop ? [] : ["Is there a nonstop?"]), ...(under > 0 ? [`Can you get it under ${money(under, currency, locale)}?`] : [])];
}

/** Sends follow-up questions and polls each pending one. Also used by the date grid's ask box. */
export function useAsk(slug: string, followUps: FollowUp[], onFollowUp: (f: FollowUp) => void) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingIds = followUps
    .filter((f) => f.status === "queued" || f.status === "working")
    .map((f) => f.id)
    .join(",");

  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",");
    let live = true;
    const tick = async () => {
      for (const id of ids) {
        try {
          const res = await fetch(`/api/search/${slug}/ask?id=${encodeURIComponent(id)}`, { cache: "no-store" });
          if (!res.ok) continue;
          const data = (await res.json()) as { followUp: FollowUp };
          if (live) onFollowUp(data.followUp);
        } catch {
          /* transient; retried on the next tick */
        }
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pendingIds, slug, onFollowUp]);

  const ask = useCallback(
    // `source: "grid"` marks a question from the date grid, so a question about other dates rebuilds that grid.
    async (text: string, source?: "grid"): Promise<boolean> => {
      const q = text.trim();
      if (!q) return false;
      setSending(true);
      setError(null);
      try {
        const res = await fetch(`/api/search/${slug}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await recaptchaHeaders("ask")) },
          body: JSON.stringify({ question: q, ...(source ? { source } : {}) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Couldn’t send that");
        onFollowUp(data.followUp as FollowUp);
        return true;
      } catch (e) {
        setError(shownError(e, "Couldn’t send that just now. Try again in a moment."));
        return false;
      } finally {
        setSending(false);
      }
    },
    [slug, onFollowUp]
  );
  return { ask, sending, error };
}

/** The follow-up thread (questions, answers, and any flights, places or grid update) plus the ask box fixed to the bottom. */
export function FollowUps({
  slug,
  followUps,
  currency,
  locale,
  cheapest,
  plans,
  ask,
  sending,
  error,
  onOpenGrid,
  rail,
}: {
  slug: string;
  followUps: FollowUp[];
  currency: string;
  locale: string;
  cheapest: number | null;
  /** The search's plans; example questions they already answer are skipped. */
  plans: FlightPlan[];
  ask: (q: string) => Promise<boolean>;
  sending: boolean;
  error: string | null;
  onOpenGrid: () => void;
  /** Whether the page has a rail on lg, so the box aligns with the answers column. */
  rail: boolean;
}) {
  const [question, setQuestion] = useState("");

  // The bar's height varies (examples, error line), so measure it. Scroll padding follows it so focused controls
  // scroll clear of the bar and the header.
  const bar = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement.style;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      setBarHeight(h);
      root.scrollPaddingBottom = `${h + FADE}px`;
    });
    ro.observe(el);
    root.scrollPaddingTop = "4.5rem";
    return () => {
      ro.disconnect();
      root.scrollPaddingBottom = "";
      root.scrollPaddingTop = "";
    };
  }, []);

  // `data-composer` lets globals.css lift the reCAPTCHA badge above the bar and move the source button on narrow screens.
  useEffect(() => {
    document.documentElement.dataset.composer = "";
    return () => {
      delete document.documentElement.dataset.composer;
    };
  }, []);

  const end = useRef<HTMLDivElement>(null);
  const [endVisible, setEndVisible] = useState(true);
  // Mirrors endVisible, readable synchronously when an answer arrives.
  const atEnd = useRef(true);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        atEnd.current = entry.isIntersecting;
        setEndVisible(entry.isIntersecting);
      },
      { rootMargin: `0px 0px -${barHeight}px 0px` }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [barHeight]);
  const jump = () => end.current?.scrollIntoView({ behavior: scrollMotion(), block: "end" });

  // Scroll to a newly sent question, and bring its answer into view when it arrives.
  const follow = useRef(false);
  const awaiting = useRef(new Set<string>());
  const count = followUps.length;
  const last = followUps.at(-1)?.id;
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    if (last) awaiting.current.add(last);
    jump();
  }, [count, last]);

  // Before paint: if the user is still at the end, scroll so the answer's start and first card clear the bar.
  // If they scrolled away, leave them; the bar shows a jump button.
  useLayoutEffect(() => {
    for (const id of [...awaiting.current]) {
      const f = followUps.find((x) => x.id === id);
      if (!f || (f.status !== "answered" && f.status !== "failed")) continue;
      awaiting.current.delete(id);
      const box = document.getElementById(`f-${id}`);
      if (!box || !atEnd.current) continue;
      const top = box.getBoundingClientRect().top - 96;
      const shown = (box.querySelector("article") ?? box).getBoundingClientRect().bottom;
      const by = Math.min(top, shown - (window.innerHeight - barHeight - FADE));
      if (by > 1) window.scrollBy({ top: by, behavior: scrollMotion() });
    }
  }, [followUps, barHeight]);

  async function send(text: string) {
    if (sending) return;
    follow.current = true;
    if (await ask(text)) setQuestion("");
    else follow.current = false;
  }

  const showExamples = EXAMPLES_ON && followUps.length === 0;
  const exampleButton = (e: string, className: string) => (
    <button key={e} type="button" onClick={() => void send(e)} className={cx("float press shrink-0 rounded-full px-3.5 text-[13.5px] font-medium text-ink-soft hover:text-ink pointer-coarse:h-10", className)}>
      {e}
    </button>
  );

  // Screen-reader text for the latest question: its progress, then its answer.
  // A single persistent live region, so each change is announced.
  const latest = followUps.at(-1);
  const heard = !latest ? "" : latest.status === "answered" || latest.status === "failed" ? (latest.answer ?? "") : (latest.progress ?? "Looking through what I found…");

  return (
    <section className="flex flex-col gap-8" aria-label="Questions about this search">
      <p className="sr-only" aria-live="polite">
        {heard}
      </p>
      {followUps.length > 0 && <div className="h-px bg-rule" />}
      {followUps.map((f) => {
        const plansCheapest = f.plans?.length ? Math.min(...f.plans.map((p) => p.price)) : null;
        return (
          <div key={f.id} id={`f-${f.id}`} className="fade flex scroll-mt-6 flex-col gap-4">
            <p className="btn-primary ml-auto max-w-[85%] rounded-[22px] rounded-br-[8px] px-4 py-2.5 text-[15.5px] leading-relaxed font-medium">{f.question}</p>
            <div className="flex min-w-0 flex-col gap-4">
              {f.status === "answered" || f.status === "failed" ? (
                <>
                  {/* Failed answers use warning styling, like a failed search. */}
                  {f.status === "failed" ? (
                    <p className="flex items-start gap-2.5 self-start rounded-2xl bg-warn-soft px-4 py-3 text-[15px] leading-relaxed text-warn">
                      <AlertTriangle aria-hidden className="mt-1 h-4 w-4 shrink-0" strokeWidth={2.2} />
                      {f.answer}
                    </p>
                  ) : (
                    <p className="words text-[17px] leading-[1.6] text-ink">{f.answer}</p>
                  )}
                  {f.gridUpdated && (
                    <button type="button" onClick={onOpenGrid} className="float press flex h-10 items-center gap-2 self-start rounded-full px-4 text-[14px] font-semibold text-ink">
                      <Grid3x3 className="h-4 w-4 text-accent" strokeWidth={2.2} />
                      Open the updated date grid
                    </button>
                  )}
                  {f.plans && f.plans.length > 0 && (
                    <div className="flex flex-col gap-3">
                      {f.plans.map((p) => (
                        <PlanCard key={p.id} plan={p} cheapest={plansCheapest} slug={slug} locale={locale} compact />
                      ))}
                    </div>
                  )}
                  {f.destinations && f.destinations.length > 0 && (
                    <div className="flex flex-col gap-3">
                      {f.viewTitle && <p className="text-[14px] font-semibold text-ink">{f.viewTitle}</p>}
                      <Places destinations={f.destinations} slug={slug} currency={currency} locale={locale} />
                    </div>
                  )}
                </>
              ) : (
                <p className="flex items-center gap-2.5 pt-0.5 text-[15px] text-ink-muted">
                  <span className="flex gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="breathe h-1.5 w-1.5 rounded-full bg-ink-muted" style={{ animationDelay: `${i * 0.18}s` }} />
                    ))}
                  </span>
                  {f.progress ?? "Looking through what I found…"}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {/* Phones and short screens: examples sit in the page so the bar keeps one row. -mb-13 offsets the shadow room. */}
      {showExamples && cheapest != null && (
        <div className="no-scrollbar -mx-4 -mt-1 -mb-13 flex gap-2 overflow-x-auto px-4 pt-1 pb-5 [mask-image:linear-gradient(to_right,#000_calc(100%-1rem),transparent)] sm:[@media(min-height:481px)]:hidden">
          {examples(currency, locale, cheapest, plans).map((e) => exampleButton(e, "h-10"))}
        </div>
      )}

      {/* On phones the reCAPTCHA badge is hidden while this bar is up (globals.css), so its required notice goes in the page. */}
      {RECAPTCHA_SHOWN && (
        <p className="text-[11.5px] leading-snug text-ink-muted sm:hidden">
          This site is protected by reCAPTCHA and the Google{" "}
          <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className="underline">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer" className="underline">
            Terms of Service
          </a>{" "}
          apply.
        </p>
      )}

      {/* Spacer for the fixed bar and its fade, and the jump target. data-bar-room removes search-view's bottom padding. */}
      <div ref={end} aria-hidden data-bar-room style={{ height: barHeight + FADE }} />

      <div ref={bar} className="fixed inset-x-0 bottom-0 isolate z-30 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Page-coloured backdrop behind the bar, fading in above it, so cards scrolling under don't show between the chips. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-6 bottom-0 -z-10 bg-[linear-gradient(to_top,var(--color-ground)_calc(100%-1.5rem),transparent)]" />
        {/* Same columns as the page, so the box sits under the answers rather than the rail. */}
        <div className={cx(PAGE, rail && RAILED)}>
          {rail && <div className="hidden lg:block" aria-hidden />}
          {/* Matches the answers' width and padding. */}
          <div className="relative mx-auto flex w-full max-w-[820px] flex-col gap-2.5 px-1.5 sm:px-2">
            {/* No examples without prices: "a day later" would ask about nothing. */}
            {showExamples && cheapest != null && (
              <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 max-sm:hidden sm:mx-0 sm:flex-wrap sm:justify-center sm:px-0 [@media(max-height:480px)]:hidden">
                {examples(currency, locale, cheapest, plans).map((e) => exampleButton(e, "h-9"))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(question);
              }}
              className="float field flex h-14 items-center gap-1.5 rounded-full pr-1.5 [@media(max-height:480px)]:h-12"
            >
              {/* The label spans the pill, so a tap on the icon or edge focuses the input. */}
              <label htmlFor="ask" className="flex min-w-0 flex-1 cursor-text items-center gap-3 self-stretch pl-5">
                <MessageCircle className="h-[18px] w-[18px] shrink-0 text-ink-muted" strokeWidth={2} />
                <span className="sr-only">Ask about these flights</span>
                <input
                  id="ask"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask about these flights…"
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-[15.5px] text-ink outline-none placeholder:text-ink-muted pointer-coarse:text-[16px]"
                />
              </label>
              {/* Inside the bar, so it can't cover an answer or a card's Book button. */}
              {!endVisible && followUps.length > 0 && (
                <button
                  type="button"
                  onClick={jump}
                  aria-label="Jump to the latest answer"
                  title="Jump to the latest answer"
                  className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-soft hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
                >
                  <ArrowDown className="h-[18px] w-[18px]" strokeWidth={2.2} />
                </button>
              )}
              <button
                type="submit"
                disabled={!question.trim() || sending}
                aria-label="Send"
                className={cx("press flex h-11 w-11 shrink-0 items-center justify-center rounded-full", question.trim() ? "btn-primary" : "bg-ink/[0.06] text-ink-faint")}
              >
                {sending ? <span className="spin h-4 w-4 rounded-full border-2 border-white/40 border-t-white" /> : <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.4} />}
              </button>
            </form>
            {error && (
              <p role="alert" className="text-center text-[13.5px] text-warn">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
