import type { NextRequest } from "next/server";
import { reportError } from "@/lib/errors";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { callerIp, MORE_ACTION, REFUSED_SAID, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { Unanswered } from "@/lib/search/asking";
import { flightsForCell } from "@/lib/search/cell";
import { isDay } from "@/lib/search/grid";
import { resolveAirport } from "@/lib/search/intake";
import { liveDeps } from "@/lib/search/run";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Calls are retried until answered (lib/search/cell.ts), within a 50 s budget. */
export const maxDuration = 60;

/**
 * Itineraries for one price-grid cell or one open-destination place. Built by code with no model, fetched the same way the
 * search prices a cell, and all-or-nothing. Limited to existing slugs and the airports that search has shown, because each
 * call costs money. Results join the search's session rows so later follow-ups can see them.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const refused = notJson(req.headers);
  if (refused) return refused;
  const { slug } = await params;
  const limited = await rateLimit("more", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  // Anyone with a share link can spend money here, so check reCAPTCHA first.
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), MORE_ACTION, callerIp(req.headers));
  if (!verdict.allow) return Response.json({ error: REFUSED_SAID }, { status: 403 });
  const s = await store();
  const record = await s.get(slug);
  if (!record) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { outDate?: string; returnDate?: string | null; destination?: string; to?: string; backFrom?: string; tickets?: "one" | "two" } | null;
  const noTrip = () => Response.json({ error: "Those dates don’t make a trip." }, { status: 400 });
  // Reject invalid dates rather than falling back to the plan's.
  if ((body?.outDate != null && !isDay(body.outDate)) || (body?.returnDate != null && !isDay(body.returnDate))) return noTrip();
  const isCode = (v: unknown): v is string => typeof v === "string" && /^[A-Z]{3}$/.test(v);
  const r = record.request;
  const plan = record.plan;
  // Allow only airports this search has shown: its plan, its grid (a cell's fare can use a nearby airport), and listed places.
  // A share link can then price only its own trip.
  const shown = new Set<string>();
  const add = (c: string | null | undefined) => {
    if (c) shown.add(c);
  };
  for (const p of [...(plan?.origins ?? []), ...(plan?.destinations ?? [])]) add(p.code);
  add(resolveAirport(r.from));
  add(resolveAirport(r.to));
  const grid = record.view?.grid;
  if (grid) {
    add(grid.route?.from);
    for (const c of grid.route?.to ?? []) add(c);
    for (const c of grid.airports ?? []) add(c);
    for (const c of grid.cells) {
      add(c.via?.out);
      add(c.via?.back);
    }
  }
  for (const d of record.view?.destinations ?? []) add(d.code);
  for (const f of record.followUps) for (const d of f.destinations ?? []) add(d.code);
  const known = (v: unknown): v is string => isCode(v) && shown.has(v);
  const asked = body as { from?: unknown; to?: unknown; backFrom?: unknown; destination?: unknown } | null;
  // Reject airports the search hasn't shown rather than falling back to the plan's.
  if ([asked?.from, asked?.to, asked?.backFrom, asked?.destination].some((v) => v != null && !known(v)))
    return Response.json({ error: "That search has no route to price." }, { status: 400 });
  const bodyFrom = asked?.from;
  const from = known(bodyFrom) ? bodyFrom : (plan?.origins[0]?.code ?? resolveAirport(r.from));
  if (!from) return Response.json({ error: "That search has no route to price." }, { status: 400 });

  let to: string | undefined;
  let outDate: string | null = null;
  let returnDate: string | null = null;
  if (known(body?.destination)) {
    // A place from a destination list (the search's own or a follow-up's).
    to = body.destination;
    outDate = isDay(body?.outDate) ? body.outDate : (plan?.dates.anchor.out ?? r.departDate);
    returnDate = isDay(body?.returnDate) ? body.returnDate : (plan?.dates.anchor.ret ?? r.returnDate);
  } else {
    // A grid cell: the cell's airport, else the plan's first destination, else the form's.
    to = known(body?.to) ? body.to : (plan?.destinations[0]?.code ?? resolveAirport(r.to));
    outDate = isDay(body?.outDate) ? body!.outDate! : null;
    returnDate = isDay(body?.returnDate) ? body!.returnDate! : null;
    if (!outDate) return noTrip();
    const wantsReturn = plan ? plan.dates.ret != null : Boolean(r.returnDate);
    if (wantsReturn && !returnDate) return noTrip();
  }
  if (!to || !outDate) return Response.json({ error: "That search has no route to price." }, { status: 400 });
  // Reject past dates and returns before departure. They can't be flown, and their rows would join the session's.
  const today = new Date().toISOString().slice(0, 10);
  if (outDate < today || (returnDate != null && returnDate <= outDate)) return noTrip();
  const backFrom = known(body?.backFrom) ? body.backFrom : to;
  const tickets = body?.tickets === "two" && returnDate ? "two" : "one";

  const deps = liveDeps();
  const names = Object.fromEntries([...(plan?.origins ?? []), ...(plan?.destinations ?? [])].map((p) => [p.code, p.name]));
  try {
    const { plans, rows } = await flightsForCell({
      backend: deps.backend,
      fallback: deps.fallback,
      req: r,
      ask: { from, to, backFrom, outDate, returnDate, tickets },
      names,
      signal: AbortSignal.timeout(50_000),
      tag: `more-${outDate}-${to}`,
    });
    await s.update(slug, (rec) => {
      if (!rec.session) return rec;
      const held = rec.session.rows as { id: number }[];
      const nextId = held.reduce((m, x) => Math.max(m, x.id), -1) + 1;
      const fresh = rows.map((row, i) => ({ ...row, id: nextId + i }));
      const kept = [...held, ...fresh].slice(-400);
      return { ...rec, session: { ...rec.session, rows: kept } };
    });
    return Response.json({ plans }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    await reportError("server", e, { where: "/api/search/[slug]/more", slug });
    // Partial results could miss the cheapest flight, so show none.
    if (e instanceof Unanswered) return Response.json({ error: "We couldn’t load all of those flights. Try again in a moment." }, { status: 502 });
    return Response.json({ error: "Couldn’t load the flights for those dates. Try again in a moment." }, { status: 502 });
  }
}
