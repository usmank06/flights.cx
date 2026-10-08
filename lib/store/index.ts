import { databaseUrl } from "@/lib/db";
import { seatedTravellers, type FollowUp, type SearchRecord, type SearchRequest, type SearchSummary } from "@/lib/types";

/** Search record storage: Postgres when DATABASE_URL is set, JSON files under .data/ otherwise. */
export interface Store {
  readonly kind: "postgres" | "file";
  create(record: SearchRecord): Promise<void>;
  get(slug: string): Promise<SearchRecord | null>;
  /** Whether a live record exists. proxy.ts checks this before rendering a search page, so a missing one gets a proper 404. */
  has(slug: string): Promise<boolean>;
  /** The record with private fields removed (`publicRecord`). */
  getPublic(slug: string): Promise<SearchRecord | null>;
  /** One follow-up, for polling its answer. */
  followUp(slug: string, id: string): Promise<FollowUp | null>;
  /** Read-modify-write under a per-slug lock (in-process for files, a row lock in Postgres), since follow-ups may write at once. */
  update(slug: string, mutate: (record: SearchRecord) => SearchRecord): Promise<SearchRecord | null>;
  /** Summaries for the slugs a traveller holds in localStorage, newest first. */
  summaries(slugs: string[]): Promise<SearchSummary[]>;
  /** Summaries of the searches a signed-in traveller owns, newest first. */
  forUser(userId: string, limit: number): Promise<SearchSummary[]>;
}

/** Set by proxy.ts when a requested search doesn't exist, so the page renders its 404. */
export const MISSING_SEARCH_HEADER = "x-flights-search-missing";

/** A record still "running" after this long was cut off by the route's time limit. */
export const STALE_MS = 3 * 60_000;

/**
 * The record as anyone with its link may read it, since the slug is the only permission. Strips `session`, `events`, `stats`,
 * `userId`, `rerunOf`, `ownerKeyHash`, and the traveller's own words with the picks written from them. `set` stays, since it only
 * names the fields a control set.
 */
export function publicRecord(record: SearchRecord): SearchRecord {
  const request: SearchRequest = { ...record.request, notes: "", flexibilityNote: "" };
  delete request.brief;
  delete request.turns;
  const plan = record.plan ? { ...record.plan, picks: [] } : record.plan;
  const out: SearchRecord = { ...record, request, plan, events: [], stats: null, session: null, userId: null };
  delete out.rerunOf;
  delete out.ownerKeyHash;
  return out;
}

/** Deleted by its owner. Reads other than `update` treat it as gone; the row is kept for metrics. */
export const isDeleted = (r: SearchRecord | null | undefined): boolean => Boolean(r?.deletedAt);

/** Beyond the ask route's 180 s limit, so a follow-up still pending this long was cut off. */
export const FOLLOWUP_STALE_MS = 4 * 60_000;

/** Answer shown when a follow-up fails or is cut off. */
export const FOLLOWUP_FAILED = "I couldn't get an answer that time. Ask again and I'll try once more.";

/** Marks a follow-up still pending past FOLLOWUP_STALE_MS as failed. */
export function followUpLiveness(f: FollowUp): FollowUp {
  if (f.status !== "queued" && f.status !== "working") return f;
  if (!(Date.now() - Date.parse(f.askedAt) > FOLLOWUP_STALE_MS)) return f;
  return { ...f, status: "failed", progress: undefined, answer: FOLLOWUP_FAILED };
}

/** Shows a stale "running" record as an error, and stale follow-ups as failed. */
export function withLiveness(record: SearchRecord): SearchRecord {
  const r = { ...record, followUps: record.followUps.map(followUpLiveness) };
  if (r.status !== "running") return r;
  const age = Date.now() - Date.parse(r.createdAt);
  if (!(age > STALE_MS)) return r;
  return {
    ...r,
    status: "error",
    phase: "error",
    error: "This search stopped before it finished. Search again to try it fresh.",
  };
}

/** A record as a list row, with liveness applied. */
export function summarise(raw: SearchRecord): SearchSummary {
  const r = withLiveness(raw);
  const prices = (r.plans ?? []).map((p) => p.price);
  return {
    slug: r.slug,
    createdAt: r.createdAt,
    capturedAt: r.capturedAt,
    status: r.status,
    from: r.request.from,
    to: r.request.to,
    departDate: r.request.departDate,
    returnDate: r.request.returnDate,
    bestPrice: prices.length ? Math.min(...prices) : null,
    planCount: prices.length,
    saved: r.verdict?.saved ?? null,
    currency: r.request.currency,
    locale: r.request.locale,
    travellers: seatedTravellers(r.request.passengers),
    cabin: r.request.cabin,
  };
}

let cached: Store | null = null;

export async function store(): Promise<Store> {
  if (cached) return cached;
  // FLIGHTS_STORE=file wins over DATABASE_URL (`databaseUrl`, lib/db.ts).
  const url = databaseUrl();
  if (url) {
    const { postgresStore } = await import("./postgres");
    cached = await postgresStore(url);
  } else {
    const { fileStore } = await import("./file");
    cached = fileStore();
  }
  return cached;
}
