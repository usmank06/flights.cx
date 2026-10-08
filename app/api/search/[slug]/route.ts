import type { NextRequest } from "next/server";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { currentUser } from "@/lib/auth";
import { isSlug } from "@/lib/slug";
import { keyOpens, OWNER_KEY_HEADER } from "@/lib/search/owner";
import { store, withLiveness } from "@/lib/store";
import { watchStore } from "@/lib/watch/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One search for the browser, without `session` (the engine's rows are most of the record and the page doesn't use them). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const record = await (await store()).getPublic(slug);
  if (!record) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });
  return Response.json(withLiveness(record), { headers: { "cache-control": "no-store" } });
}

/**
 * Deletes a search. Allowed for the owning account, or for the browser that started it while no account owns it (lib/search/owner.ts).
 * Soft delete: the row stays for metrics, but its link answers 404 and lists hide it. Share-link holders can't delete.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const user = await currentUser();
  const limited = await rateLimit("remove", user?.id ?? null);
  if (!limited.ok) return tooMany(limited);
  const { slug } = await params;
  const s = await store();
  const record = isSlug(slug) ? await s.get(slug) : null;
  if (!record) return Response.json({ error: "That search isn’t here any more." }, { status: 404 });
  const mine = record.userId ? user?.id === record.userId : keyOpens(req.headers.get(OWNER_KEY_HEADER), record.ownerKeyHash);
  if (!mine) return Response.json({ error: "Only the person who made this search can delete it." }, { status: 403 });
  await s.update(slug, (r) => ({ ...r, deletedAt: r.deletedAt ?? new Date().toISOString() }));
  // Its price watches go with it, so Your trips doesn't keep an alert for a search that's gone.
  if (user) {
    const ws = await watchStore();
    await Promise.all((await ws.forUser(user.id)).filter((w) => w.slug === slug).map((w) => ws.remove(w.id)));
  }
  return Response.json({ ok: true });
}
