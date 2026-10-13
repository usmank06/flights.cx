import type { Incomplete } from "@/lib/types";
import { rangeLabel, shortDay } from "@/components/search/dates";

/** How many unconfirmed dates the note lists before "and N more". */
const NAMED = 3;

/**
 * The note under the write-up when a search left lookups out (`Verdict.incomplete`). It lists the dates it couldn't confirm, or
 * else mentions the date grid or other lookups. `except` is the dates the grid's own note already covers. Null when there's
 * nothing to say.
 */
export function leftOutLine(x: Incomplete, locale: string, except?: { outDate: string; returnDate: string } | null): string | null {
  const dates = x.dates.filter((d) => !except || d.outDate !== except.outDate || (d.returnDate ?? d.outDate) !== except.returnDate);
  if (!dates.length && !x.grid && !x.other) return null;
  const label = (d: Incomplete["dates"][number]) => `${d.returnDate ? rangeLabel(d.outDate, d.returnDate, locale) : shortDay(d.outDate, locale)}${d.route ? ` (${d.route})` : ""}`;
  const named = dates.slice(0, NAMED).map(label);
  const more = dates.length - named.length;
  const list = more ? `${named.join(", ")} and ${more} more` : named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
  const better = "there may be a better option we didn’t see";
  if (dates.length && x.grid) return `We couldn’t confirm these dates in time: ${list}. Part of the date grid didn’t come back either, so ${better}.`;
  if (dates.length) return `We couldn’t confirm these dates in time: ${list}. There may be a better option we didn’t see.`;
  return `${x.grid ? "Part of the date grid" : "A few checks"} didn’t come back in time, so ${better}.`;
}
