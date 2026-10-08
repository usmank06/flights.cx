import type { NextRequest } from "next/server";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimitEveryone } from "@/lib/abuse/limit";
import { currentUser } from "@/lib/auth";
import { recordMetric, simpleEvent, tripShape } from "@/lib/metrics";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Records a Book click. Sent with navigator.sendBeacon, so it always answers 204 and must not throw. Requiring a JSON
 * body blocks cross-site form posts.
 */
export async function POST(req: NextRequest) {
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  // Over the limit, the click is dropped silently.
  const limited = await rateLimitEveryone("book");
  if (!limited.ok) return new Response(null, { status: 204 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const slug = typeof body?.slug === "string" ? body.slug.slice(0, 40) : "";
  const planId = typeof body?.planId === "string" ? body.planId.slice(0, 64) : null;
  // What the link opened: the booking page, the return-choice page, or a fallback ("itinerary", "route").
  // Fallbacks are counted separately because they send the traveller to a search page instead of a booking.
  const PRECISIONS = ["booking", "return", "itinerary", "route"];
  const precision = typeof body?.precision === "string" && PRECISIONS.includes(body.precision) ? body.precision : null;

  const record = slug ? await (await store()).get(slug).catch(() => null) : null;
  // Clicks without a search record aren't counted, since the row needs the trip shape.
  if (!record) return new Response(null, { status: 204 });

  const user = await currentUser().catch(() => null);
  await recordMetric(
    simpleEvent("book_click", {
      slug: record.slug,
      shape: tripShape(record.request),
      signedIn: user != null,
      detail: { planId, precision },
    })
  );

  return new Response(null, { status: 204 });
}
