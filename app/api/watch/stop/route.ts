import type { NextRequest } from "next/server";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUserId } from "@/lib/auth";
import { watchStore } from "@/lib/watch/store";
import { stopTokenValid } from "@/lib/watch/stop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stops one watch via its email's signed link (lib/watch/stop.ts). Called by /account/stop and by mail clients' one-click unsubscribe,
 * which posts `List-Unsubscribe=One-Click` as a form (RFC 8058). So there is no JSON-only guard; the signed token is the permission.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit("watch", await currentUserId());
  if (!limited.ok) return tooMany(limited);
  const id = req.nextUrl.searchParams.get("w") ?? "";
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!stopTokenValid(id, token)) return Response.json({ error: "That link doesn’t work." }, { status: 403 });
  const ws = await watchStore();
  const watch = await ws.get(id);
  if (watch) await ws.remove(id);
  return Response.json({ ok: true, stopped: Boolean(watch) }, { headers: { "cache-control": "no-store" } });
}
