import type { NextRequest } from "next/server";
import { reportError } from "@/lib/errors";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { callerIp, GRID_ACTION, REFUSED_SAID, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { Unanswered } from "@/lib/search/asking";
import { shiftDay } from "@/lib/search/core";
import { buildGrid, cleanWindow, gridRoute, heldFares, mergeGrids, withHeld } from "@/lib/search/grid";
import { TODAY_HEADER, travellersDay } from "@/lib/search/intake";
import { liveDeps } from "@/lib/search/run";
import { store } from "@/lib/store";
import type { GridView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A grid per destination plus the graphs, fetched within a 50 s budget. */
export const maxDuration = 60;

/**
 * Builds, widens or trims the search's date grid to the `{ out, ret }` windows the traveller asks for. Only unpriced days are
 * fetched, and fares from the search's cards show on their days. The result replaces the record's grid, so reloads, share links
 * and follow-ups all see it. Needs a finished search with a route (open-destination searches list places instead).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const refused = notJson(req.headers);
  if (refused) return refused;
  const { slug } = await params;
  const limited = await rateLimit("grid", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  // Anyone with a share link can spend money here, so check reCAPTCHA first.
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), GRID_ACTION, callerIp(req.headers));
  if (!verdict.allow) return Response.json({ error: REFUSED_SAID }, { status: 403 });
  const s = await store();
  const record = await s.get(slug);
  if (!record) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });
  if (record.status !== "done") return Response.json({ error: "The search is still running." }, { status: 409 });

  const existing = record.view?.grid ?? null;
  const route = gridRoute(existing, record.plan);
  if (!route) return Response.json({ error: "This search has places rather than a route, so there is no date grid to build." }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { out?: unknown; ret?: unknown } | null;
  const today = travellersDay(req.headers.get(TODAY_HEADER));
  const oneWay = existing ? existing.returnDates.length === 0 : record.plan ? record.plan.dates.ret == null : !record.request.returnDate;
  const out = cleanWindow(body?.out, today);
  const ret = oneWay ? null : cleanWindow(body?.ret, today);
  if (!out || (!oneWay && (!ret || ret[1] <= out[0]))) return Response.json({ error: "Those dates don’t make a trip." }, { status: 400 });

  // Nothing new to price when every pair in the new windows is already on the grid.
  const has = new Set((existing?.cells ?? []).map((c) => `${c.outDate}~${c.returnDate}`));
  const days = (w: [string, string]) => {
    const xs: string[] = [];
    for (let d = w[0]; d <= w[1]; d = shiftDay(d, 1)) xs.push(d);
    return xs;
  };
  const wanted = ret ? days(out).flatMap((o) => days(ret).filter((r) => r > o).map((r) => `${o}~${r}`)) : days(out).map((o) => `${o}~${o}`);
  const covered = existing != null && wanted.every((k) => has.has(k));

  const requested = existing?.requested ?? (record.plan ? { out: record.plan.dates.anchor.out, ret: record.plan.dates.anchor.ret ?? record.plan.dates.anchor.out } : undefined);
  let grid: GridView | null;
  try {
    grid = covered
      ? mergeGrids(null, existing, out, ret)
      : await buildGrid({ backend: liveDeps().backend, req: record.request, ask: { ...route, out, ret, requested }, existing, signal: AbortSignal.timeout(50_000) });
  } catch (e) {
    // Don't show a partial grid. The missing days could be the cheapest.
    if (e instanceof Unanswered) return Response.json({ error: "We couldn’t price all of those dates. Try again in a moment." }, { status: 502 });
    await reportError("server", e, { where: "/api/search/[slug]/grid", slug });
    return Response.json({ error: "Couldn’t price those dates just now. Try again in a moment." }, { status: 502 });
  }
  if (!grid) return Response.json({ error: "We couldn’t find any flights on those dates." }, { status: 502 });
  const kept: GridView = { ...withHeld(grid, heldFares(record.plans)), requested: requested ?? grid.requested };
  await s.update(slug, (r) => ({ ...r, view: { ...(r.view ?? { kind: "closed" as const }), grid: kept } }));
  return Response.json({ grid: kept }, { headers: { "cache-control": "no-store" } });
}
