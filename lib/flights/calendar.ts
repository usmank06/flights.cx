import type { DatePricePoint } from "./types";

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.parse(`${d}T12:00:00Z`);

/** The longest stay, in days, a date grid is trusted to price. Longer stays are asked one length at a time (`longStays`). */
export const GRID_MAX_STAY = 21;

/** A grid cell that counts toward a complete grid: priced, back after it leaves, and no longer than GRID_MAX_STAY. */
export const countsInGrid = (p: DatePricePoint): boolean =>
  p.price != null && !!p.returnDate && p.returnDate > p.outDate && parseDay(p.returnDate) - parseDay(p.outDate) <= GRID_MAX_STAY * DAY_MS;

/** How many cells a grid over these windows can hold: every pair that returns after it leaves, up to GRID_MAX_STAY days later. */
export function gridCellCount(outWindow: [string, string], returnWindow: [string, string]): number {
  let n = 0;
  for (let o = parseDay(outWindow[0]); o <= parseDay(outWindow[1]); o += DAY_MS)
    for (let r = parseDay(returnWindow[0]); r <= parseDay(returnWindow[1]); r += DAY_MS) if (r > o && r - o <= GRID_MAX_STAY * DAY_MS) n++;
  return n;
}

/**
 * The stay lengths in these windows that are longer than GRID_MAX_STAY, closest to `prefer` first, at most `cap`. Each comes with
 * the departure days whose return lands in the window (`range`) and how many of them there are (`cells`).
 */
export function longStays(outWindow: [string, string], returnWindow: [string, string], prefer: number, cap = 8): { days: number; cells: number; range: [string, string] }[] {
  const outs = new Map<number, number[]>();
  for (let o = parseDay(outWindow[0]); o <= parseDay(outWindow[1]); o += DAY_MS)
    for (let r = parseDay(returnWindow[0]); r <= parseDay(returnWindow[1]); r += DAY_MS) {
      const days = Math.round((r - o) / DAY_MS);
      if (days > GRID_MAX_STAY) outs.set(days, [...(outs.get(days) ?? []), o]);
    }
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [...outs]
    .map(([days, os]) => ({ days, cells: os.length, range: [day(Math.min(...os)), day(Math.max(...os))] as [string, string] }))
    .sort((a, b) => Math.abs(a.days - prefer) - Math.abs(b.days - prefer) || a.days - b.days)
    .slice(0, cap);
}
