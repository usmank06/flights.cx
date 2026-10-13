/**
 * Price watches: re-run a search on a schedule and email when the price crosses the traveller's trigger. Each re-run is an ordinary
 * search with its own slug, so the email can link to it.
 */

export type WatchTrigger =
  /** Tell me when it gets to this price or below. */
  | { kind: "target"; price: number }
  /** Tell me when it moves by this much in either direction. */
  | { kind: "move"; percent: number };

export type PriceWatch = {
  id: string;
  /** Watches need somewhere to send mail, so they need an account. */
  userId: string;
  email: string;
  /** The search this watches. Its stored request is what gets re-run. */
  slug: string;
  createdAt: string;

  /** Best price when the watch was created. */
  referencePrice: number;
  currency: string;
  locale: string;
  trigger: WatchTrigger;

  /** Re-run interval, in hours. */
  everyHours: number;
  nextRunAt: string;
  lastRunAt: string | null;
  /** Slug of the latest successful re-run, which has the freshest prices. */
  lastRunSlug?: string | null;
  /** Always null, since a tick finishes its re-run before releasing the watch. The store's due() and pending() filter on it. */
  pendingSlug: string | null;

  /** Price in the last alert. Triggers compare against this so a lower price doesn't alert on every run. */
  lastNotifiedPrice: number | null;
  lastNotifiedAt: string | null;
  notifications: number;

  /**
   * Lease held by the tick acting on this watch, so overlapping ticks (cron can redeliver) don't each pay for a search and send an
   * email. It expires after WATCH_LOCK_MS, so a tick that dies can't block the watch.
   */
  lockedBy?: string | null;
  lockedAt?: string | null;

  status: "active" | "paused" | "ended";
  /** Why it ended, shown to the traveller. */
  endedReason?: string;
  /** When to stop: the departure date, or a fixed horizon without one (see watchEndsAt). */
  endsAt: string;
};

export type NewWatch = {
  userId: string;
  email: string;
  slug: string;
  referencePrice: number;
  currency: string;
  locale: string;
  trigger: WatchTrigger;
  everyHours: number;
  endsAt: string;
};

/** Re-run interval bounds and default, in hours. */
export const MIN_HOURS = 24;
export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 24 * 7;

/** When a watch on a trip ends, in ms: the start of its departure day (UTC), or six months out for a trip with no date. */
export function watchEndsAt(departDate: string | null, now: number): number {
  return departDate ? Date.parse(`${departDate}T00:00:00.000Z`) : now + 180 * 86_400_000;
}

/** The dispatcher runs hourly, and on Vercel's Hobby plan each run can start anywhere in its hour, so a due watch may wait up to two. */
const FIRST_RUN_SLACK_HOURS = 3;

/** Whether a trip can be tracked, shared by the route and the button. The watch must outlast one interval plus the first run's slack. */
export function trackable(departDate: string | null, now: number, everyHours = DEFAULT_HOURS): boolean {
  return watchEndsAt(departDate, now) > now + (everyHours + FIRST_RUN_SLACK_HOURS) * 3600_000;
}

/** Smaller moves are noise. */
export const MIN_MOVE_PERCENT = 3;

/**
 * Targets are rounded down to an integer, like fares. Rounding happens before the below-today's-price check, so a target a few
 * cents under today's price can't round to it and alert on the first run.
 */
export const wholeTarget = (price: number): number => Math.floor(price);

/** Validates a trigger. A target not below today's price falls back to a move trigger. */
export function coerceTrigger(raw: unknown, best: number): WatchTrigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.kind === "target") {
    const price = wholeTarget(Number(t.price));
    if (Number.isFinite(price) && price > 0 && price < best) return { kind: "target", price };
  }
  const percent = Number(t.percent);
  return {
    kind: "move",
    percent: Number.isFinite(percent) ? Math.min(90, Math.max(MIN_MOVE_PERCENT, Math.round(percent))) : 5,
  };
}

/**
 * Parses a typed amount in any locale's format: "1,300.50", "1.300,50", "1 300", "12.50". A final "." or "," followed by one or two
 * digits is the decimal point; other separators group thousands. Null when it isn't a number.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/[\s  '’]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const m = s.match(/^(.*\d)[.,](\d{1,2})$/);
  const n = Number(`${(m ? m[1] : s).replace(/[.,]/g, "")}${m ? `.${m[2]}` : ""}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * How long a tick may hold a watch: the cron route's 300 s limit, since an open-destination re-run can take three minutes and a
 * lapsed lock would let a second tick repeat the search and the email.
 */
export const WATCH_LOCK_MS = 5 * 60_000;

/**
 * Whether the new price crosses the watch's trigger. Pure, so it's easy to test. Compares against the last alerted price, or the
 * reference price before any alert. `incomplete`: the re-run left lookups out (`Verdict.incomplete`).
 */
export function shouldNotify(
  watch: Pick<PriceWatch, "trigger" | "referencePrice" | "lastNotifiedPrice">,
  price: number,
  incomplete = false
): { notify: boolean; reason: string } {
  const previous = watch.lastNotifiedPrice ?? watch.referencePrice;
  // A zero reference would divide by zero below and the watch would go silent, so bail out explicitly.
  if (!Number.isFinite(previous) || previous <= 0)
    return { notify: false, reason: "no usable price to compare against" };

  if (watch.trigger.kind === "target") {
    if (price > watch.trigger.price) return { notify: false, reason: "still above the target" };
    // At or below the target. After the first alert, only alert again on a further drop of MIN_MOVE_PERCENT.
    if (watch.lastNotifiedPrice == null) return { notify: true, reason: "reached the target price" };
    const drop = ((previous - price) / previous) * 100;
    return drop >= MIN_MOVE_PERCENT
      ? { notify: true, reason: "fell further below the target" }
      : { notify: false, reason: "already told them about a price this low" };
  }

  // A re-run that left lookups out may have missed the cheapest fare, so a rise isn't reported. A drop is a real fare.
  if (incomplete && price > previous) return { notify: false, reason: "rose, but the re-run left lookups out" };
  const movePct = Math.abs((price - previous) / previous) * 100;
  if (movePct < watch.trigger.percent) return { notify: false, reason: "has not moved enough" };
  return { notify: true, reason: price < previous ? "dropped" : "rose" };
}
