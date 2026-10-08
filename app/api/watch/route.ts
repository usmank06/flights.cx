import type { NextRequest } from "next/server";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUser } from "@/lib/auth";
import { store } from "@/lib/store";
import { recordMetric, simpleEvent, tripShape } from "@/lib/metrics";
import { watchForTrip } from "@/lib/watch/match";
import { watchStore } from "@/lib/watch/store";
import { notJson } from "@/lib/abuse/json-only";
import { coerceTrigger, DEFAULT_HOURS, MAX_HOURS, MIN_HOURS, trackable, watchEndsAt } from "@/lib/watch/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Watches one account may hold at once, paused ones included. */
const MAX_WATCHES = 10;

/** The traveller's watches. With `?slug=`, the watch on that search's trip, which may belong to another search of the same trip. */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  const headers = { "cache-control": "no-store" };
  const slug = req.nextUrl.searchParams.get("slug");
  if (slug != null) {
    const record = user && slug ? await (await store()).get(slug) : null;
    return Response.json({ watch: user && record ? await watchForTrip(user.id, record) : null }, { headers });
  }
  if (!user) return Response.json({ watches: [] }, { headers });
  const ws = await watchStore();
  return Response.json({ watches: await ws.forUser(user.id) }, { headers });
}

/** Starts watching a search. Requires sign-in because a watch sends email; it is the only feature that does. */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const limited = await rateLimit("watch", user?.id ?? null);
  if (!limited.ok) return tooMany(limited);
  // JSON only: a cross-site form can't send JSON without a CORS preflight, which this app doesn't answer.
  const refused = notJson(req.headers);
  if (refused) return refused;
  if (!user)
    return Response.json(
      { error: "You’ve been signed out. Sign in again to track this price." },
      { status: 401 }
    );

  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const s = await store();
  const record = slug ? await s.get(slug) : null;
  if (!record) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });

  const best = record.plans?.length ? Math.min(...record.plans.map((p) => p.price)) : null;
  if (best == null)
    return Response.json(
      { error: "There’s no price to track yet. Wait for the search to finish." },
      { status: 400 }
    );

  const ws = await watchStore();
  // One watch per trip per person, across all of its searches. A paused one counts, so the page offers Resume instead of a duplicate.
  const held = await watchForTrip(user.id, record);
  if (held) return Response.json({ watch: held, already: true }, { status: 200 });
  // Each watch runs a paid search on every check until the trip, so cap them. Paused ones count, so resuming always fits.
  const holding = (await ws.forUser(user.id)).filter((w) => w.status !== "ended").length;
  if (holding >= MAX_WATCHES)
    return Response.json(
      { error: `You’re already tracking ${MAX_WATCHES} prices, which is the most at once. Stop one in Your trips to track this one.` },
      { status: 409 }
    );

  const trigger = coerceTrigger(body?.trigger, best);
  const everyHours = clamp(Number(body?.everyHours) || DEFAULT_HOURS, MIN_HOURS, MAX_HOURS);
  const now = Date.now();
  const ends = new Date(watchEndsAt(record.request.departDate, now)).toISOString();
  if (!trackable(record.request.departDate, now, everyHours))
    return Response.json(
      {
        error:
          Date.parse(ends) <= now
            ? "This trip has already departed, so there’s no price to track."
            : "This trip departs before the next daily check, so there’s nothing to track.",
      },
      { status: 400 }
    );

  const watch = await ws.create({
    userId: user.id,
    email: user.email,
    slug,
    referencePrice: best,
    currency: record.request.currency,
    locale: record.request.locale,
    trigger,
    everyHours,
    endsAt: ends,
  });

  await recordMetric(
    simpleEvent("watch_created", {
      slug,
      shape: tripShape(record.request),
      signedIn: true,
      detail: { trigger: trigger.kind, everyHours },
    })
  );

  return Response.json({ watch }, { status: 201 });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
