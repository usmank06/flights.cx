import { currentUser } from "@/lib/auth";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Searches the signed-in traveller owns on any browser. The client merges them into its localStorage list. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ searches: [] }, { headers: { "cache-control": "no-store" } });

  // The store applies liveness in this one query, so stale leases read correctly without fetching each record.
  const s = await store();
  const searches = await s.forUser(user.id, 100);
  return Response.json({ searches }, { headers: { "cache-control": "no-store" } });
}
