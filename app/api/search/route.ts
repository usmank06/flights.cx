import { after, type NextRequest } from "next/server";
import { newOwnerKey, ownerKeyHash } from "@/lib/search/owner";
import { notJson } from "@/lib/abuse/json-only";
import { rateLimit, tooMany } from "@/lib/abuse/limit";
import { callerIp, REFUSED_SAID, SEARCH_ACTION, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { currentUserId } from "@/lib/auth";
import { recordMetric, simpleEvent } from "@/lib/metrics";
import { coerceSearchRequest, fixedRequest, TODAY_HEADER, travellersDay } from "@/lib/search/intake";
import { isSupportedCurrency } from "@/lib/currencies";
import { createSearch, executeSearch, liveDeps } from "@/lib/search/run";
import { publicRecord, store } from "@/lib/store";
import { reportError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open-destination searches run up to 3 minutes, and the record is written after the engine stops. Vercel Hobby allows 300 s. */
export const maxDuration = 200;

/**
 * Starts a search and streams NDJSON: the slug, progress frames, then the finished public record. The search finishes and
 * writes its record even if the reader disconnects; `after()` keeps the invocation alive until the write lands.
 */
export async function POST(req: NextRequest) {
  const wrongType = notJson(req.headers);
  if (wrongType) return wrongType;
  const userId = await currentUserId();
  const limited = await rateLimit("search", userId);
  if (!limited.ok) {
    await recordMetric(simpleEvent("search_rejected", { detail: { verdict: "rate-limited" } }));
    return tooMany(limited);
  }
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), SEARCH_ACTION, callerIp(req.headers));
  if (!verdict.allow) {
    await recordMetric(simpleEvent("search_rejected", { detail: { verdict: verdict.reason, score: verdict.score } }));
    // The message asks for a retry because reloading would lose the intake answers, which live only in the page.
    return Response.json({ error: REFUSED_SAID }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  // "Search again" reads the full request from the store. The page only has the public copy, which omits the traveller's words.
  const again = typeof body?.rerun === "string" && body.rerun.length < 40 ? await (await store()).get(body.rerun) : null;
  if (body?.rerun != null && !again) return Response.json({ error: "That search is gone, so it can’t be run again." }, { status: 404 });
  // Rerun in the currency selected in the page header.
  const recur = again && isSupportedCurrency(body?.currency) && body.currency.toUpperCase() !== again.request.currency ? body.currency.toUpperCase() : null;
  const today = travellersDay(req.headers.get(TODAY_HEADER));
  const parsed = coerceSearchRequest(again ? fixedRequest(recur ? { ...again.request, currency: recur } : again.request) : body, today);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const rerunOf = again ? again.slug : typeof body?.rerunOf === "string" && body.rerunOf.length < 40 ? body.rerunOf : undefined;
  // Lets this browser delete the search while no account owns it. Sent to the browser once; only the hash is stored.
  const ownerKey = newOwnerKey();
  const record = await createSearch(parsed.request, { userId, rerunOf, ownerKeyHash: ownerKeyHash(ownerKey) });

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const send = (frame: Record<string, unknown>) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
    } catch {
      closed = true; // the reader went away; the search carries on
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      send({ t: "slug", slug: record.slug, key: ownerKey });
    },
    cancel() {
      closed = true;
    },
  });

  const done = executeSearch(record, (p) => send(p.type === "phase" ? { t: "phase", phase: p.phase } : { t: "log", text: p.text, kind: p.kind }), liveDeps({ today })).then(
    (final) => {
      const pub = publicRecord(final);
      send(final.status === "error" ? { t: "error", message: final.error ?? "Search failed", record: pub } : { t: "done", record: pub });
      close();
    },
    // The engine and the error write both failed. End the stream so the page doesn't wait out maxDuration.
    (e) => {
      void reportError("search", e, { where: "ended without a record", slug: record.slug });
      send({ t: "error", message: "We couldn’t finish this search." });
      close();
    }
  );
  function close() {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  }
  after(() => done);

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
