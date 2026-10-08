"use client";

import { useState } from "react";
import { Check, Plane } from "lucide-react";
import type { SearchPhase } from "@/lib/types";
import type { Tally } from "@/lib/search/tally";
import { cx, Spinner } from "@/components/ui/primitives";
import type { LiveLine } from "./search-client";

/**
 * A search in progress: progress bar, running totals and steps. The page that started the search reads its stream; a page that joins
 * later (reload, share link) reads the record, which the server updates as the search runs.
 */
const STEPS: { label: string; phases: SearchPhase[] }[] = [
  { label: "Reading your trip", phases: ["starting", "planning"] },
  { label: "Pricing your dates", phases: ["pricing", "exploring"] },
  { label: "Checking nearby dates and airports", phases: ["widening"] },
  { label: "Picking the best options", phases: ["picking"] },
  { label: "Writing up the results", phases: ["writing", "done"] },
];

/** A typical duration (lib/metrics `typicalDurationMs`) in loose words, e.g. "about a minute". Without data, a guess by search type. */
export function takesAbout(ms: number | null, open: boolean): string {
  if (ms == null) return open ? "a few minutes" : "a minute or two";
  const s = ms / 1000;
  if (s < 40) return `about ${Math.max(10, Math.round(s / 5) * 5)} seconds`;
  if (s < 70) return "about a minute";
  if (s < 100) return "about a minute and a half";
  if (s < 150) return "about two minutes";
  if (s < 210) return "about three minutes";
  return "a few minutes";
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function SearchProgress({
  phase,
  began,
  found,
  lines,
  ms,
  expectMs,
  takes,
  title,
  reconnecting = false,
}: {
  phase: SearchPhase;
  /** When each phase began, on the same clock as `ms`. */
  began: Partial<Record<SearchPhase, number>>;
  /** Flights found and searches run so far, or null when the record has no counts. */
  found: Tally | null;
  /** The stream's latest lines, showing what the current step is doing. Null without a stream. */
  lines: LiveLine[] | null;
  /** How long the search has run. */
  ms: number;
  /** Typical total duration, which paces the bar within a step. */
  expectMs: number;
  /** "about a minute", from `takesAbout`. */
  takes: string;
  title: string;
  /** The page lost its connection and is retrying. */
  reconnecting?: boolean;
}) {
  // Steps and totals only move forward: after a dropped stream the page reads the record, which can lag slightly.
  const now = Math.max(0, STEPS.findIndex((s) => s.phases.includes(phase)));
  const [at, setAt] = useState(now);
  if (now > at) setAt(now);
  const [most, setMost] = useState(found);
  if (found && (!most || found.flights > most.flights || found.searches > most.searches))
    setMost({ flights: Math.max(found.flights, most?.flights ?? 0), searches: Math.max(found.searches, most?.searches ?? 0) });
  const doing = [...(lines ?? [])].reverse().find((l) => l.kind === "action")?.text?.replace(/(…|\.\.\.)$/, "") ?? null;

  // Each step's start is its earliest phase. Null for a skipped step (open searches have no nearby-dates step).
  const start = STEPS.map((st) => {
    const times = st.phases.flatMap((p) => (began[p] != null ? [began[p]] : []));
    return times.length ? Math.min(...times) : null;
  });
  const startAt = start[at];

  // Completed steps plus time in this step against its share of a typical search, capped short of the next step. Only moves forward.
  const share = 1 / STEPS.length;
  const inStep = startAt != null ? Math.min(0.92, (ms - startAt) / Math.max(1, expectMs * share)) : 0;
  const target = Math.min(0.98, (at + inStep) * share);
  const [shown, setShown] = useState(0);
  if (target > shown) setShown(target);
  const pct = Math.round(shown * 100);

  return (
    <section className="flex flex-col gap-5 sm:gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="display text-[26px] leading-[1.1] font-semibold text-balance text-ink sm:text-[40px] sm:leading-[1.08]">{title}</h1>
        {/* The search continues on the server while disconnected; the page catches up on reconnect. */}
        <p role="status" className={cx("text-[15px] leading-relaxed sm:text-[16px]", reconnecting ? "text-warn" : "text-ink-muted")}>
          {reconnecting ? "We lost the connection. Reconnecting… your search keeps going on our side." : `Usually ${takes}. You can close this page; this link will show the results.`}
        </p>
      </div>

      <div className="slip flex flex-col gap-4 rounded-[24px] p-5 sm:gap-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-3 text-[14px]">
          {/* Truncated to one line so the bar below doesn't jump; the step list shows the full label. */}
          <span className="min-w-0 truncate font-semibold text-ink">
            Step {at + 1} of {STEPS.length}
            <span className="font-normal text-ink-muted"> · {STEPS[at].label}</span>
          </span>
          <span className="nums shrink-0 font-semibold text-accent">{pct}%</span>
        </div>
        <div className="relative mr-3 h-2 rounded-full bg-soft-strong" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Search progress">
          <div className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-accent transition-[width] duration-700 ease-[var(--ease-out)]" style={{ width: `${Math.max(4, pct)}%` }}>
            <span aria-hidden className="sweep absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
          </div>
          <span
            aria-hidden
            className="absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-paper text-accent shadow-[0_0_0_1px_var(--color-rule),var(--shadow-xs)] transition-[left] duration-700 ease-[var(--ease-out)]"
            style={{ left: `${Math.max(4, pct)}%` }}
          >
            <Plane className="h-3.5 w-3.5 rotate-45" strokeWidth={2.2} fill="currentColor" />
          </span>
        </div>
        <dl className="grid grid-cols-3 gap-3">
          {/* Shows a dash when there are no counts. */}
          <Stat label="Flights found" value={most ? most.flights.toLocaleString() : "—"} />
          <Stat label="Searches run" value={most ? String(most.searches) : "—"} />
          <Stat label="Time" value={clock(ms)} />
        </dl>
      </div>

      {/* Announces each step once; the detail line and timer change too often to announce. */}
      <p className="sr-only" aria-live="polite">
        {STEPS[at] ? `Step ${at + 1} of ${STEPS.length}: ${STEPS[at].label}` : ""}
      </p>
      {/* Right padding lines the step times up with the card's percentage. */}
      <ol className="flex flex-col pr-5 pl-1 sm:pr-6">
        {STEPS.map((st, i) => {
          // Duration: from this step's start to the start of the next step that ran.
          const next = start.slice(i + 1, at + 1).find((t) => t != null) ?? null;
          const took = i < at && start[i] != null && next != null ? Math.max(1, Math.round((next - start[i]!) / 1000)) : null;
          const says = i === at && doing && doing.toLowerCase() !== st.label.toLowerCase() ? doing : null;
          return (
            <li key={st.label} className="relative flex gap-3.5 pb-3 last:pb-0 sm:pb-4">
              {i < STEPS.length - 1 && <span aria-hidden className={cx("absolute top-7 bottom-1 left-[11px] w-[2px] rounded-full", i < at ? "bg-good/35" : "bg-rule")} />}
              <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                {i < at ? (
                  <span className="fade flex h-6 w-6 items-center justify-center rounded-full bg-good text-white">
                    <Check className="h-3.5 w-3.5" strokeWidth={3.2} />
                  </span>
                ) : i === at ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft">
                    <Spinner className="h-4 w-4 text-accent" />
                  </span>
                ) : (
                  <span className="h-6 w-6 rounded-full border-2 border-rule-strong bg-paper" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className={cx("text-[15px]", i < at ? "text-ink-soft" : i === at ? "font-semibold text-ink" : "text-ink-muted")}>
                    <span className="sr-only">{i < at ? "Done: " : i === at ? "Now: " : "Next: "}</span>
                    {st.label}
                  </span>
                  {took != null && <span className="nums shrink-0 text-[12.5px] text-ink-muted">{took}s</span>}
                </span>
                {/* With a stream, the current step's detail line is always rendered (blank when empty) so the list doesn't jump. */}
                {i === at && lines && (
                  <span key={says ?? ""} aria-hidden={!says} className={cx("truncate text-[13.5px] leading-[20px] text-ink-muted", says && "fade")}>
                    {says ?? " "}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    // The value shows above its label, but the label comes first in reading order.
    <div className="flex flex-col-reverse gap-1.5">
      <dt className="text-[13px] text-ink-muted">{label}</dt>
      <dd className="nums text-[24px] leading-none font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">{value}</dd>
    </div>
  );
}
