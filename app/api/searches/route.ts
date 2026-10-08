import type { NextRequest } from "next/server";
import { jsonUpTo, notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fits 200 slugs with room to spare. */
const MAX_BODY_BYTES = 16_384;

/** Summaries for this browser's localStorage slugs, so history works without an account. Knowing a slug is the only permission. */
export async function POST(req: NextRequest) {
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  const limited = await rateLimit("searches", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  const read = await jsonUpTo(req, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  const body = read.body as { slugs?: unknown } | null;
  const slugs: string[] = Array.isArray(body?.slugs)
    ? body.slugs.filter((s: unknown): s is string => typeof s === "string" && s.length < 40).slice(0, 200)
    : [];
  if (!slugs.length) return Response.json({ searches: [] });

  // One query for all slugs. The store applies liveness itself.
  const s = await store();
  const searches = await s.summaries(slugs);
  return Response.json({ searches }, { headers: { "cache-control": "no-store" } });
}
