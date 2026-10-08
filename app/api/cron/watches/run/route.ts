import { after, type NextRequest } from "next/server";
import { reportError } from "@/lib/errors";
import { cronRefusal } from "@/lib/watch/cron";
import { claimWatch, runClaimedWatch } from "@/lib/watch/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** An open-destination search takes up to 3 minutes, plus the compare, email and writes. */
export const maxDuration = 300;

/**
 * Re-runs one watch for the dispatcher (../route.ts). Claims the watch before answering, so a duplicate call is skipped as "held".
 * The search, compare and email run after the response, within this call's 300 s.
 */
export async function POST(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id.slice(0, 64) : "";
  if (!id) return Response.json({ error: "Which watch?" }, { status: 400 });

  const outcome = await claimWatch(id);
  if ("skipped" in outcome) return Response.json({ skipped: outcome.skipped }, { headers: { "cache-control": "no-store" } });
  after(async () => {
    const run = await runClaimedWatch(outcome.claimed);
    if (run.outcome === "error" || run.outcome === "not-sent")
      await reportError(run.outcome === "not-sent" ? "email" : "watch", run.error ?? run.outcome, { where: `watch run: ${run.outcome}`, detail: { watch: run.id } });
  });
  return Response.json({ started: id }, { status: 202, headers: { "cache-control": "no-store" } });
}
