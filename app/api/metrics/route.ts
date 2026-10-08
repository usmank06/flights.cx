import type { NextRequest } from "next/server";
import { sameSecret } from "@/lib/abuse/secret";
import { isDay } from "@/lib/format";
import { metrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Metrics for a stats page, read only from the daily rollups so the cost stays flat as usage grows. Rollups hold sums and
 * counts because means can't be re-aggregated across days. Sums assume a single currency.
 */
export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN ?? process.env.CRON_SECRET;
  if (token) {
    if (!sameSecret(req.headers.get("authorization"), `Bearer ${token}`))
      return Response.json({ error: "unauthorized" }, { status: 401 });
  } else if (process.env.NODE_ENV === "production") {
    // Cost and failure data stay private in production, so refuse without a token.
    return Response.json(
      { error: "METRICS_TOKEN is not set — refusing to serve metrics unauthenticated" },
      { status: 503 }
    );
  }

  // Strict YYYY-MM-DD check. Invalid dates make toISOString() throw, and impossible ones (Feb 30) fail Postgres's `$1::date` cast.
  const askedTo = req.nextUrl.searchParams.get("to");
  const askedFrom = req.nextUrl.searchParams.get("from");
  if ((askedTo && !isDay(askedTo)) || (askedFrom && !isDay(askedFrom)))
    return Response.json({ error: "from and to must be YYYY-MM-DD" }, { status: 400 });

  const to = askedTo ?? new Date().toISOString().slice(0, 10);
  const from = askedFrom ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

  const m = await metrics();
  const rows = await m.rollups(from, to);

  // Totals overall and per haul, computed here so clients don't have to.
  const zero = {
    searches: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
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
    bookClicks: 0,
    followUps: 0,
    watchesCreated: 0,
    watchEmailsSent: 0,
    signIns: 0,
  };
  type Totals = typeof zero;
  const add = (a: Totals, r: (typeof rows)[number]): Totals => {
    const out = { ...a };
    for (const k of Object.keys(zero) as (keyof Totals)[]) out[k] += r[k] ?? 0;
    return out;
  };

  const total = rows.reduce(add, { ...zero });
  const byHaul: Record<string, Totals> = {};
  for (const r of rows) byHaul[r.haul] = add(byHaul[r.haul] ?? { ...zero }, r);

  return Response.json(
    {
      from,
      to,
      store: m.kind,
      total,
      byHaul,
      /** One row per (day, haul, flexible, openDestination). */
      rollups: rows,
      /** Common ratios, computed once so every client derives them the same way. */
      derived: {
        meanSavedPerComparedSearch: total.compared ? total.sumSaved / total.compared : null,
        meanBaseline: total.compared ? total.sumBaseline / total.compared : null,
        /** Share of compared searches where we didn't beat the traveller's own fare. */
        notBeatenRate: total.compared ? total.notBeaten / total.compared : null,
        meanModelCostUsd: total.completed ? total.sumModelCostUsd / total.completed : null,
        meanDurationMs: total.completed ? total.sumDurationMs / total.completed : null,
        meanFailedDurationMs: total.failed ? total.sumFailedDurationMs / total.failed : null,
        concluderFallbackRate: total.completed ? total.priceRankedFallbacks / total.completed : null,
        bookClicksPerCompletedSearch: total.completed ? total.bookClicks / total.completed : null,
      },
    },
    { headers: { "cache-control": "no-store" } }
  );
}
