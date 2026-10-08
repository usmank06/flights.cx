import { store } from "@/lib/store";
import type { SearchRecord, SearchRequest } from "@/lib/types";
import { watchStore } from "./store";
import type { PriceWatch } from "./types";

/**
 * Finds the watch a search belongs to. Watches match by trip, since re-runs and repeat searches of one trip get new slugs and
 * shouldn't offer a duplicate watch.
 */

/** Max `rerunOf` links to follow back. A watch's re-runs are one step away; each "Search again" adds one. */
const CHAIN = 10;

/**
 * Identifies a trip by places, dates, travellers, cabin and bags. Null without a departure date, since the same request can then
 * mean different trips.
 */
export function tripKey(r: SearchRequest): string | null {
  if (!r.departDate) return null;
  const p = r.passengers;
  const place = (v: string) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return [place(r.from), place(r.to), r.departDate, r.returnDate ?? "", r.cabin, p.adults, p.children, p.infantsInSeat, p.infantsOnLap, r.bags?.carryOn ?? 0, r.bags?.checked ?? 0].join("|");
}

/** The traveller's watch on this search's trip, matched by slug, by `rerunOf` chain or by trip key. Null if none. */
export async function watchForTrip(userId: string, record: SearchRecord): Promise<PriceWatch | null> {
  const ws = await watchStore();
  const live = (await ws.forUser(userId)).filter((w) => w.status !== "ended");
  if (!live.length) return null;
  const bySlug = new Map(live.map((w) => [w.slug, w]));
  const s = await store();

  let r: SearchRecord | null = record;
  for (let i = 0; r && i < CHAIN; i++) {
    const hit = bySlug.get(r.slug);
    if (hit) return hit;
    r = r.rerunOf ? await s.get(r.rerunOf) : null;
  }

  const key = tripKey(record.request);
  if (!key) return null;
  const watched = await Promise.all(live.map(async (w) => ({ w, r: await s.get(w.slug) })));
  return watched.find(({ r }) => r && tripKey(r.request) === key)?.w ?? null;
}
