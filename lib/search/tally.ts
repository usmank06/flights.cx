import type { SearchPhase } from "@/lib/types";

/**
 * A running search's totals for the progress card, counted from the engine's log lines ("→ N itineraries" and price grid lines).
 * Lines are counted once as they arrive, so totals only rise. The server keeps the same count (run.ts) for pages that join late.
 */
export type Tally = { flights: number; searches: number };

export const NO_TALLY: Tally = { flights: 0, searches: 0 };

/** Adds one log line to the totals. Returns the same object when the line doesn't count. */
export function countLine(t: Tally, text: string): Tally {
  const m = text.match(/→ (\d+) itineraries/);
  if (m) return { flights: t.flights + Number(m[1]), searches: t.searches + 1 };
  if (/^Price grid(?: to [^:]+)?: \d+ date pairs/.test(text.trim())) return { ...t, searches: t.searches + 1 };
  return t;
}

/** Records when each phase is first seen, in ms from the start. A repeated phase (an open search's rounds) keeps its first time. */
export function phaseSeen(began: Partial<Record<SearchPhase, number>>, phase: SearchPhase, at: number): Partial<Record<SearchPhase, number>> {
  return began[phase] != null ? began : { ...began, [phase]: Math.max(0, Math.round(at)) };
}
