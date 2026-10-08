import { databaseUrl } from "@/lib/db";
import {
  dayOf,
  EMPTY_ROLLUP,
  foldEvent,
  rollupKey,
  type DailyRollup,
  type MetricEvent,
  type MetricEventType,
  type SearchOutcome,
  type TripShape,
} from "./types";

export * from "./types";

/** All-time totals shown on How it works. */
export type AllTime = { searches: number; flights: number; savedUsd: number };

/** Metrics storage, kept apart from search records: Postgres when DATABASE_URL is set, JSON lines under .data/ otherwise. */
export interface MetricsStore {
  readonly kind: "postgres" | "file";
  /** Appends one event and folds it into the day's rollup. */
  record(event: MetricEvent): Promise<void>;
  /** The rollups covering [fromDay, toDay], inclusive, both YYYY-MM-DD. */
  rollups(fromDay: string, toDay: string): Promise<DailyRollup[]>;
  /** Raw events, newest first. */
  recent(limit: number, type?: MetricEventType): Promise<MetricEvent[]>;
  /** Every rollup summed into the public totals. */
  allTime(): Promise<AllTime>;
}

/** Records an event. Never throws: a failed write is logged and dropped so it can't break a search. */
export async function recordMetric(event: MetricEvent): Promise<void> {
  try {
    const s = await metrics();
    await s.record(event);
  } catch (e) {
    console.warn(`[metrics] dropped ${event.type}: ${(e as Error).message}`);
  }
}

/** Builds an event with no search outcome. */
export function simpleEvent(
  type: MetricEventType,
  opts: {
    slug?: string | null;
    shape?: TripShape | null;
    signedIn?: boolean;
    detail?: Record<string, string | number | boolean | null>;
    at?: string;
  } = {}
): MetricEvent {
  return {
    type,
    at: opts.at ?? new Date().toISOString(),
    slug: opts.slug ?? null,
    shape: opts.shape ?? null,
    outcome: null,
    signedIn: opts.signedIn ?? false,
    detail: opts.detail ?? {},
  };
}

export function searchEvent(
  type: "search_started" | "search_completed" | "search_failed",
  slug: string,
  shape: TripShape,
  outcome: SearchOutcome | null,
  opts: { signedIn?: boolean; detail?: Record<string, string | number | boolean | null> } = {}
): MetricEvent {
  return {
    type,
    at: new Date().toISOString(),
    slug,
    shape,
    outcome,
    signedIn: opts.signedIn ?? false,
    detail: opts.detail ?? {},
  };
}

/** Folds events into daily rollups. */
export function rollUp(events: MetricEvent[]): DailyRollup[] {
  const byKey = new Map<string, DailyRollup>();
  for (const e of events) {
    const k = rollupKey(e);
    const day = dayOf(e.at);
    const key = `${day}|${k.haul}|${k.flexible}|${k.openDestination}`;
    const current = byKey.get(key) ?? EMPTY_ROLLUP(day, k.haul, k.flexible, k.openDestination);
    byKey.set(key, foldEvent(current, e));
  }
  return [...byKey.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.haul.localeCompare(b.haul)
  );
}

/**
 * 75th-percentile duration of the last 20 completed searches of this kind, so the progress estimate is rarely too short. Null with
 * fewer than five samples, or when the store fails.
 */
export async function typicalDurationMs(openDestination: boolean): Promise<number | null> {
  try {
    const events = await (await metrics()).recent(80, "search_completed");
    const took = events
      .filter((e) => (e.shape?.openDestination ?? false) === openDestination && e.outcome && e.outcome.durationMs > 0)
      .map((e) => e.outcome!.durationMs)
      .slice(0, 20);
    if (took.length < 5) return null;
    took.sort((a, b) => a - b);
    return took[Math.min(took.length - 1, Math.floor(took.length * 0.75))];
  } catch {
    return null;
  }
}

let cached: MetricsStore | null = null;

export async function metrics(): Promise<MetricsStore> {
  if (cached) return cached;
  const url = databaseUrl();
  if (url) {
    const { postgresMetrics } = await import("./postgres");
    cached = await postgresMetrics(url);
  } else {
    const { fileMetrics } = await import("./file");
    cached = fileMetrics();
  }
  return cached;
}
