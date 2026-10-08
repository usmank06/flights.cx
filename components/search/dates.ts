/**
 * Calendar arithmetic on ISO days (`YYYY-MM-DD`), the app's only date format. Days are formatted from midday UTC, so a
 * negative-offset timezone can't shift them to the previous day.
 */
import { DAY_FORMAT, dayRange, weekdayDate } from "@/lib/format";

export type Day = string;

const pad = (n: number) => String(n).padStart(2, "0");
export const toDay = (y: number, m: number, d: number): Day => `${y}-${pad(m + 1)}-${pad(d)}`;

export const partsOf = (day: Day) => {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m: m - 1, d };
};

/** Today in the traveller's own timezone. Read at call time, in the browser. */
export function todayDay(): Day {
  const now = new Date();
  return toDay(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(day: Day, delta: number): Day {
  const { y, m, d } = partsOf(day);
  const t = new Date(Date.UTC(y, m, d + delta));
  return toDay(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** The first of the month `delta` months from `day`'s month. */
export function monthStart(day: Day, delta = 0): Day {
  const { y, m } = partsOf(day);
  const t = new Date(Date.UTC(y, m + delta, 1));
  return toDay(t.getUTCFullYear(), t.getUTCMonth(), 1);
}

/** Always 42 cells (six weeks from Sunday), so paging months doesn't move the buttons under the pointer. */
export function monthGrid(first: Day): Day[] {
  const { y, m } = partsOf(first);
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return Array.from({ length: 42 }, (_, i) => {
    const t = new Date(Date.UTC(y, m, 1 - lead + i));
    return toDay(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  });
}

/** Number of nights between two days. */
export function nightsBetween(a: Day, b: Day): number {
  const pa = partsOf(a);
  const pb = partsOf(b);
  return Math.round((Date.UTC(pb.y, pb.m, pb.d) - Date.UTC(pa.y, pa.m, pa.d)) / 86_400_000);
}

const fmt = (day: Day, locale: string, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { ...opts, ...DAY_FORMAT });
  } catch {
    return day;
  }
};

/*
 * Formatters use one or two Intl fields that every ICU writes alike, so server and browser render the same text. Ranges use
 * lib/format.ts's `dayRange`, since Node and Chrome format en-GB ranges differently.
 */

/** "Nov 14" */
export const shortDay = (day: Day, locale = "en-US") => fmt(day, locale, { month: "short", day: "numeric" });
/** "Sat" */
export const weekday = (day: Day, locale = "en-US") => fmt(day, locale, { weekday: "short" });
/** "Sat, Nov 14", in the locale's weekday-and-date order (lib/format.ts). */
export const dayLabel = (day: Day, locale = "en-US") => weekdayDate(day, locale);
/** "November 2026" */
export const monthLabel = (day: Day, locale = "en-US") => fmt(day, locale, { month: "long", year: "numeric" });

/** A compact day range: "Nov 14 – 24", "Nov 28 – Dec 3", or "Nov 14" for one day. */
export const rangeLabel = (a: Day, b: Day | null | undefined, locale = "en-US"): string => dayRange(a, b, locale);
