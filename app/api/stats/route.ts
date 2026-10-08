import { metrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The three totals How it works shows: searches run, flights checked, dollars saved. Public, unlike /api/metrics, since it exposes
 * nothing else. Vercel's CDN caches it for a minute, so the database is queried at most about once a minute.
 */
export async function GET() {
  try {
    const totals = await (await metrics()).allTime();
    return Response.json(totals, { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=60" } });
  } catch (e) {
    console.warn(`[stats] ${(e as Error).message}`);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
