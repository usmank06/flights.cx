import type { NextRequest } from "next/server";
import { notJson } from "@/lib/abuse/json-only";
import { currentUser } from "@/lib/auth";
import { watchStore } from "@/lib/watch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pause or resume a watch. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = notJson(req.headers);
  if (refused) return refused;
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to change this." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const ws = await watchStore();
  const existing = await ws.get(id);
  // Same 404 for "not yours" as for "not there", or anyone could enumerate other people's watch ids.
  if (!existing || existing.userId !== user.id) return Response.json({ error: "You’re no longer tracking this price." }, { status: 404 });

  const status = body?.status === "paused" ? "paused" : body?.status === "active" ? "active" : null;
  const watch = await ws.update(id, (w) => ({
    ...w,
    ...(status ? { status, endedReason: undefined } : {}),
    // Resuming must not fire at once just because the due time passed while paused.
    ...(status === "active" && w.nextRunAt < new Date().toISOString()
      ? { nextRunAt: new Date(Date.now() + w.everyHours * 3600_000).toISOString() }
      : {}),
  }));
  return Response.json({ watch });
}

/** Stop watching. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to change this." }, { status: 401 });
  const ws = await watchStore();
  const existing = await ws.get(id);
  if (!existing || existing.userId !== user.id) return Response.json({ error: "You’re no longer tracking this price." }, { status: 404 });
  await ws.remove(id);
  return Response.json({ ok: true });
}
