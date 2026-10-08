import type { NextRequest } from "next/server";
import { reportError, sendErrorDigest } from "@/lib/errors";
import { cronRefusal, dispatchStatus, runTarget } from "@/lib/watch/cron";
import { dueWatchIds } from "@/lib/watch/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Starts up to DISPATCH_LIMIT (100) run calls in sequence, each returning once its watch is claimed. */
export const maxDuration = 300;

/** Delay between starts, so many due watches don't all launch searches in the same second. */
const STAGGER_MS = 400;

/**
 * Hourly dispatcher, fired by the crons in vercel.json (GET with `Authorization: Bearer $CRON_SECRET`). Starts one
 * /api/cron/watches/run call per due watch, so each re-run gets its own 300 s and they run in parallel. Safe to fire twice or
 * late, since each run claims its watch first. Sends the hourly error digest (lib/errors.ts) first so a long dispatch can't delay it.
 */
export async function GET(req: NextRequest) {
  const refused = cronRefusal(req);
  if (refused) return refused;

  const digest = await sendErrorDigest().catch((e: Error) => ({ sent: 0, reason: `failed: ${e.message}` }));
  if (digest.reason && digest.reason !== "ALERT_EMAIL is not set" && digest.reason !== "no database") console.warn(`[errors] no digest this hour: ${digest.reason}`);

  const ids = await dueWatchIds();
  const run = runTarget(req);
  const auth = req.headers.get("authorization");
  const started: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  const errors: string[] = [];
  for (const [i, id] of ids.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_MS));
    try {
      const res = await fetch(run.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...run.headers, ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ id }),
        cache: "no-store",
        // The run call returns once the watch is claimed. The search continues after the response.
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => null)) as { skipped?: string; error?: string } | null;
      if (res.status === 202) started.push(id);
      else if (res.ok) skipped.push({ id, why: data?.skipped ?? "skipped" });
      else errors.push(`${id}: ${res.status} ${data?.error ?? ""}`.trim());
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  if (errors.length) await reportError("watch", `${errors.length} of ${ids.length} watches not started — ${errors.slice(0, 3).join("; ")}`, { where: "dispatch" });
  return Response.json(
    { due: ids.length, started: started.length, skipped, errors, digest },
    { status: dispatchStatus({ due: ids.length, started: started.length, errors: errors.length }), headers: { "cache-control": "no-store" } }
  );
}
