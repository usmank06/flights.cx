import { randomUUID } from "node:crypto";
import { sendMail } from "@/lib/email";
import { recordMetric, simpleEvent, tripShape } from "@/lib/metrics";
import { fixedRequest } from "@/lib/search/intake";
import { createSearch, executeSearch } from "@/lib/search/run";
import { store } from "@/lib/store";
import type { FlightPlan } from "@/lib/types";
import { priceAlert } from "./alert";
import { appUrl } from "./cron";
import { stopUrls } from "./stop";
import { watchStore, type WatchStore } from "./store";
import { shouldNotify, WATCH_LOCK_MS, type PriceWatch } from "./types";

/**
 * The watch scheduler. An hourly cron calls the dispatcher (vercel.json lists 24 daily jobs, as the Hobby plan runs each job at most
 * once a day), which starts one call per due watch so each re-run gets its own 300 s. Each call claims its watch before spending
 * anything, because cron can redeliver.
 */

/** Max watches per dispatch: well above an hour's load, but caps a runaway list. */
export const DISPATCH_LIMIT = 100;

/** IDs of watches due now, oldest first. */
export async function dueWatchIds(now = new Date()): Promise<string[]> {
  const ws = await watchStore();
  return (await ws.due(now.toISOString(), DISPATCH_LIMIT)).map((w) => w.id);
}

export type ClaimedWatch = { watch: PriceWatch; holder: string };
export type ClaimOutcome = { claimed: ClaimedWatch } | { skipped: "held" | "not-due" | "ended" | "not-found" };

/**
 * Claims a watch before anything is spent, skipping one that's held or not due. A watch whose trip has departed or whose
 * search is gone is ended instead.
 */
export async function claimWatch(id: string, now = new Date()): Promise<ClaimOutcome> {
  const ws = await watchStore();
  const s = await store();
  const nowIso = now.toISOString();
  const holder = `run#${randomUUID().slice(0, 8)}`;
  const watch = await ws.claim(id, holder, WATCH_LOCK_MS);
  // Distinguish a deleted watch from a held one in the logs.
  if (!watch) return { skipped: (await ws.get(id)) ? "held" : "not-found" };
  try {
    // Re-check under the claim, since the listing may be stale.
    if (watch.status !== "active" || watch.nextRunAt > nowIso) {
      await ws.release(watch.id, holder);
      return { skipped: "not-due" };
    }
    if (watch.endsAt <= nowIso) {
      await ws.release(watch.id, holder, (w) => ({ ...w, status: "ended", endedReason: "This trip has departed." }));
      return { skipped: "ended" };
    }
    if (!(await s.get(watch.slug))) {
      await ws.release(watch.id, holder, (w) => ({ ...w, status: "ended", endedReason: "This search is no longer available." }));
      return { skipped: "ended" };
    }
    return { claimed: { watch, holder } };
  } catch (e) {
    // Release on error, or the watch stays locked until the lock expires.
    await ws.release(watch.id, holder).catch(() => {});
    throw e;
  }
}

export type WatchRun = { id: string; outcome: "notified" | "unchanged" | "not-sent" | "search-failed" | "ended" | "error"; price?: number; error?: string };

/** Re-runs a claimed watch, emails if the price crossed its trigger, and always releases the watch. */
export async function runClaimedWatch({ watch, holder }: ClaimedWatch, now = new Date()): Promise<WatchRun> {
  const ws = await watchStore();
  const s = await store();
  const nowIso = now.toISOString();
  // Schedule from now so a late run doesn't trigger a backlog of runs.
  const next = new Date(now.getTime() + watch.everyHours * 3600_000).toISOString();
  try {
    const original = await s.get(watch.slug);
    if (!original) {
      await ws.release(watch.id, holder, (w) => ({ ...w, status: "ended", endedReason: "This search is no longer available." }));
      return { id: watch.id, outcome: "ended" };
    }
    // Fixed fields so relative dates ("next weekend") don't drift. Unowned, so re-runs stay out of Your trips.
    const created = await createSearch(fixedRequest(original.request), { rerunOf: watch.slug, userId: null });
    const rerun = await executeSearch(created);
    const best = rerun.plans?.length ? Math.min(...rerun.plans.map((p) => p.price)) : null;

    if (rerun.status === "error" || best == null) {
      // A failed re-run sends no email; try again next interval.
      await ws.release(watch.id, holder, (w) => ({ ...w, pendingSlug: null, lastRunAt: nowIso, nextRunAt: next }));
      return { id: watch.id, outcome: "search-failed" };
    }

    const verdict = shouldNotify(watch, best, rerun.verdict?.incomplete != null);
    let sent = false;
    if (verdict.notify) {
      sent = await mailPriceMove(watch, rerun.slug, best, rerun.plans?.find((p) => p.price === best) ?? null);
      if (sent) {
        // Record the send right away, so the next run knows what was sent even if something later fails.
        await noteSent(ws, watch.id, best, nowIso);
        await recordMetric(
          simpleEvent("watch_email_sent", {
            slug: rerun.slug,
            shape: tripShape(rerun.request),
            signedIn: true,
            detail: { reason: verdict.reason, price: best, previous: watch.lastNotifiedPrice ?? watch.referencePrice },
          })
        );
      }
    }
    await ws.release(watch.id, holder, (w) => ({ ...w, pendingSlug: null, lastRunAt: nowIso, nextRunAt: next, lastRunSlug: rerun.slug }));
    return { id: watch.id, outcome: sent ? "notified" : verdict.notify ? "not-sent" : "unchanged", price: best };
  } catch (e) {
    // Release the lock and push the next run a full interval out, so a watch that keeps failing doesn't search every hour.
    await ws.release(watch.id, holder, (w) => ({ ...w, pendingSlug: null, nextRunAt: next })).catch(() => {});
    return { id: watch.id, outcome: "error", error: (e as Error).message };
  }
}

/** Records a sent alert on the watch, with retries. Not gated on the lock, since the email has gone out regardless. */
async function noteSent(ws: WatchStore, id: string, price: number, at: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ws.update(id, (w) => ({ ...w, lastNotifiedPrice: price, lastNotifiedAt: at, notifications: w.notifications + 1 }));
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function mailPriceMove(watch: PriceWatch, rerunSlug: string, price: number, plan: FlightPlan | null): Promise<boolean> {
  const s = await store();
  const original = await s.get(watch.slug);
  const stop = stopUrls(watch.id);
  const mail = priceAlert({ watch, request: original?.request ?? null, price, plan, url: `${appUrl()}/s/${rerunSlug}`, stopUrl: stop.page });

  const sent = await sendMail({
    to: watch.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    // One-click unsubscribe from the mail client stops the watch (RFC 8058).
    headers: { "List-Unsubscribe": `<${stop.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  if (!sent.deliverable) console.warn(`[watch] ${watch.id}: alert not delivered (${sent.transport}${sent.error ? `: ${sent.error}` : ""})`);
  return sent.deliverable;
}

