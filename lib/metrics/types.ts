import type { CabinClass, SearchRequest } from "@/lib/types";
import { isOpenDestination, resolveAirport } from "@/lib/search/intake";
import { AIRPORTS, distanceKm } from "@/lib/airports";
import { toUsd } from "./usd";

/**
 * Metric events and daily rollups. A saving is always stored with its baseline (`economics` is one object), and no event carries a
 * user id.
 */

export type MetricEventType =
  | "search_started"
  | "search_completed"
  | "search_failed"
  /** Refused by reCAPTCHA before starting. Kept apart from failures so bot traffic doesn't skew the failure rate. Has no shape. */
  | "search_rejected"
  | "book_click"
  | "followup_asked"
  | "watch_created"
  | "watch_email_sent"
  | "sign_in";

/** Trip attributes that savings are grouped by. */
export type TripShape = {
  /** From the resolved airports; "unknown" without airport codes. */
  haul: "domestic" | "short" | "medium" | "long" | "unknown";
  flexible: boolean;
  openDestination: boolean;
  oneWay: boolean;
  cabin: CabinClass;
  /** Seated travellers (lap infants excluded). */
  travellers: number;
  currency: string;
};

/** Party totals in `currency`, as shown to the traveller. */
export type Economics = {
  baseline: number;
  best: number;
  /** baseline − best. Negative when the search didn't beat the baseline. */
  saved: number;
  currency: string;
};

export type SearchOutcome = {
  durationMs: number;
  /** Queries sent, including the baseline and sweep. */
  queries: number;
  rounds: number;
  /** Itineraries after dedupe: the flights the search looked at. */
  itineraries?: number;
  /** Null without a baseline, as with an open destination. */
  economics: Economics | null;
  /** Cheapest plan shown. Set even when `economics` is null. */
  best: number | null;
  modelCostUsd: number | null;
  tokensIn: number;
  tokensOut: number;
  /** True when the concluder failed and code picked by price instead. */
  priceRankedFallback: boolean;
  /** Request fields the transport could not encode, e.g. ["bags"]. */
  unencoded: string[];
};

export type MetricEvent = {
  type: MetricEventType;
  at: string;
  /** The search this is about, if any. */
  slug: string | null;
  shape: TripShape | null;
  outcome: SearchOutcome | null;
  /** Whether the traveller was signed in (not who). */
  signedIn: boolean;
  /** Small free-form extras: a failure kind, a watch threshold, a booking precision. */
  detail: Record<string, string | number | boolean | null>;
};

/** A request's trip shape. Haul is banded by great-circle distance. */
export function tripShape(req: SearchRequest): TripShape {
  const from = resolveAirport(req.from);
  const to = isOpenDestination(req.to) ? undefined : resolveAirport(req.to);
  let haul: TripShape["haul"] = "unknown";
  if (from && to && AIRPORTS[from] && AIRPORTS[to]) {
    const a = AIRPORTS[from];
    const b = AIRPORTS[to];
    const km = distanceKm(a, b);
    haul =
      a.country === b.country ? "domestic" : km < 1500 ? "short" : km < 4000 ? "medium" : "long";
  }
  return {
    haul,
    flexible: req.datesFlexible,
    openDestination: isOpenDestination(req.to),
    oneWay: !req.returnDate,
    cabin: req.cabin,
    travellers: Math.max(1, req.passengers.adults + req.passengers.children + req.passengers.infantsInSeat),
    currency: req.currency,
  };
}

/**
 * One row per (day, haul, flexible, openDestination). Holds sums and counts so rows combine across days; means are computed at
 * read time.
 */
export type DailyRollup = {
  day: string; // YYYY-MM-DD, UTC
  haul: TripShape["haul"];
  flexible: boolean;
  openDestination: boolean;
  searches: number;
  completed: number;
  failed: number;
  /** Searches with both a baseline and a best price. Savings come only from these. */
  compared: number;
  /** Sums over `compared` searches, so a mean is sumSaved / compared. */
  sumBaseline: number;
  sumBest: number;
  sumSaved: number;
  /** Compared searches that didn't beat the baseline. */
  notBeaten: number;
  /** Positive savings over `compared`, in US dollars (lib/metrics/usd.ts). Shown on How it works. */
  sumSavedUsd: number;
  /** Over `completed`: the flights the searches looked at. */
  sumItineraries: number;
  /** Over `completed` only. Failures go in `sumFailedDurationMs` so they don't skew the mean. */
  sumDurationMs: number;
  /** Over `failed` only. */
  sumFailedDurationMs: number;
  sumQueries: number;
  sumRounds: number;
  sumModelCostUsd: number;
  priceRankedFallbacks: number;
  /** Searches refused by reCAPTCHA. A rise may mean real travellers are being blocked. */
  rejected: number;
  bookClicks: number;
  followUps: number;
  watchesCreated: number;
  watchEmailsSent: number;
  signIns: number;
};

export const EMPTY_ROLLUP = (
  day: string,
  haul: TripShape["haul"],
  flexible: boolean,
  openDestination: boolean
): DailyRollup => ({
  day,
  haul,
  flexible,
  openDestination,
  searches: 0,
  completed: 0,
  failed: 0,
  compared: 0,
  sumBaseline: 0,
  sumBest: 0,
  sumSaved: 0,
  notBeaten: 0,
  sumSavedUsd: 0,
  sumItineraries: 0,
  sumDurationMs: 0,
  sumFailedDurationMs: 0,
  sumQueries: 0,
  sumRounds: 0,
  sumModelCostUsd: 0,
  priceRankedFallbacks: 0,
  rejected: 0,
  bookClicks: 0,
  followUps: 0,
  watchesCreated: 0,
  watchEmailsSent: 0,
  signIns: 0,
});

/**
 * Folds one event into a rollup. Pure, so both adapters share the arithmetic. Price sums other than sumSavedUsd aren't converted, so
 * a mean only makes sense within one currency.
 */
export function foldEvent(r: DailyRollup, e: MetricEvent): DailyRollup {
  const next = { ...r };
  switch (e.type) {
    case "search_started":
      next.searches++;
      break;
    case "search_completed": {
      next.completed++;
      const o = e.outcome;
      if (o) {
        next.sumDurationMs += o.durationMs;
        next.sumQueries += o.queries;
        next.sumRounds += o.rounds;
        next.sumItineraries += o.itineraries ?? 0;
        next.sumModelCostUsd += o.modelCostUsd ?? 0;
        if (o.priceRankedFallback) next.priceRankedFallbacks++;
        if (o.economics) {
          next.compared++;
          next.sumBaseline += o.economics.baseline;
          next.sumBest += o.economics.best;
          next.sumSaved += o.economics.saved;
          if (o.economics.saved <= 0) next.notBeaten++;
          else next.sumSavedUsd += toUsd(o.economics.saved, o.economics.currency);
        }
      }
      break;
    }
    case "search_rejected":
      next.rejected++;
      break;
    case "search_failed":
      next.failed++;
      if (e.outcome) {
        next.sumFailedDurationMs += e.outcome.durationMs;
        next.sumModelCostUsd += e.outcome.modelCostUsd ?? 0;
      }
      break;
    case "book_click":
      next.bookClicks++;
      break;
    case "followup_asked":
      next.followUps++;
      break;
    case "watch_created":
      next.watchesCreated++;
      break;
    case "watch_email_sent":
      next.watchEmailsSent++;
      break;
    case "sign_in":
      next.signIns++;
      break;
  }
  return next;
}

/** The rollup key an event belongs to. Events with no shape land in the "unknown" bucket. */
export const rollupKey = (e: MetricEvent): { haul: TripShape["haul"]; flexible: boolean; openDestination: boolean } => ({
  haul: e.shape?.haul ?? "unknown",
  flexible: e.shape?.flexible ?? false,
  openDestination: e.shape?.openDestination ?? false,
});

export const dayOf = (iso: string): string => iso.slice(0, 10);
