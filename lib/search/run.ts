import { randomUUID } from "node:crypto";
import { reportError } from "@/lib/errors";
import { recordMetric, searchEvent, simpleEvent, tripShape } from "@/lib/metrics";
import { newSlug } from "@/lib/slug";
import { FOLLOWUP_FAILED, store, withLiveness, type Store } from "@/lib/store";
import { seatedTravellers, type FlightPlan, type FollowUp, type PlanView, type SearchEvent, type SearchPhase, type SearchRecord, type SearchRequest } from "@/lib/types";
import { airportsOfPlace } from "./asking";
import { noteRouteSwaps, plansFromPicks } from "./assemble";
import { fallbackBackend, liveBackend } from "@/lib/flights/provider";
import { demoBackend, demoPlannerOn } from "./demo";
import { rowsForModel, tripFacts, type CompactRow } from "./core";
import { codeLine, runSearch, SearchFailure, toPlanView, type EngineDeps, type LogKind } from "./engine";
import { liveJev } from "./jev";
import { resolveModel } from "./models";
import { answerAmounts, answerQuestion, mentionsMoney, moneyAllowed, plainAnswer, planAmounts, undash } from "./voice";
import { planTrip, requestFromPlan, TravellerError } from "./plan";
import { countLine, NO_TALLY, phaseSeen, type Tally } from "./tally";
import { liveExploreAgent } from "./explore-agent";
import { gridAround, runFollowUpQueries, runFollowUpViews } from "./followup";

/**
 * Search lifecycle: `createSearch` writes the record, `executeSearch` runs the engine and stores the outcome even if the client
 * has left, and follow-up questions are answered from the stored record.
 */

/** Follow-ups add rows to the session; keep it a size a model can read. */
const MAX_SESSION_ROWS = 400;

/** The planner's model, chosen on accuracy over speed. Override with FLIGHTS_PLANNER_MODEL. */
const DEFAULT_PLANNER_KEY = "luna-pro";
/** The open-destination agent's model. Override with FLIGHTS_EXPLORE_MODEL. */
const DEFAULT_EXPLORE_KEY = "glm-5.3-flash";

/**
 * The engine's dependencies from the environment. Without a live backend (or with FLIGHTS_BACKEND=demo) the demo market answers,
 * and its planner stands in when there is no model key. `today` is the traveller's date (travellersDay), else the server's.
 */
export function liveDeps(opts: { today?: string } = {}): EngineDeps {
  const key = process.env.FLIGHTS_VOICE_MODEL || process.env.FLIGHTS_MODEL || undefined;
  const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
  const live = process.env.FLIGHTS_BACKEND === "demo" ? null : liveBackend();
  const demo = !live;
  const plannerModel = hasKey ? resolveModel(process.env.FLIGHTS_PLANNER_MODEL || DEFAULT_PLANNER_KEY) : null;
  const exploreModel = hasKey ? resolveModel(process.env.FLIGHTS_EXPLORE_MODEL || DEFAULT_EXPLORE_KEY) : null;
  // DEMO_LATENCY_MS slows the demo market, for watching a search progress.
  const backend = live ?? demoBackend({ latency: Number(process.env.DEMO_LATENCY_MS) || 120 });
  // Only a live provider has a fallback, not the demo market.
  const fallback = live ? fallbackBackend({ airportsOf: airportsOfPlace }) : null;
  // Cache place lookups, since the planner may run twice per search.
  const looked = new Map<string, ReturnType<NonNullable<typeof backend.places>>>();
  const places = (text: string) => looked.get(text) ?? looked.set(text, backend.places ? backend.places(text) : Promise.resolve([])).get(text)!;
  return {
    backend,
    fallback,
    planner: plannerModel ? (req, o) => planTrip(req, plannerModel, { ...o, today: opts.today, places }) : demo ? demoPlannerOn(opts.today) : null,
    explorer: exploreModel ? liveExploreAgent(exploreModel) : null,
    jev: hasKey ? liveJev : null,
    voice: hasKey ? resolveModel(key) : null,
  };
}

export async function createSearch(request: SearchRequest, opts: { rerunOf?: string; userId?: string | null; ownerKeyHash?: string } = {}): Promise<SearchRecord> {
  const slug = newSlug();
  const now = new Date().toISOString();
  const record: SearchRecord = {
    slug,
    createdAt: now,
    capturedAt: null,
    status: "running",
    phase: "starting",
    request,
    mode: "live",
    userId: opts.userId ?? null,
    events: [],
    plans: null,
    analysis: null,
    verdict: null,
    view: null,
    plan: null,
    stats: null,
    error: null,
    followUps: [],
    session: null,
    unencoded: [],
    ...(opts.rerunOf ? { rerunOf: opts.rerunOf } : {}),
    ...(opts.ownerKeyHash ? { ownerKeyHash: opts.ownerKeyHash } : {}),
  };
  await (await store()).create(record);
  await recordMetric(searchEvent("search_started", slug, tripShape(request), null, { signedIn: Boolean(opts.userId), detail: { rerun: Boolean(opts.rerunOf) } }));
  return record;
}

export type Progress =
  | { type: "phase"; phase: SearchPhase }
  | { type: "log"; text: string; kind: LogKind };

/** Minimum interval between tally writes. Phase changes and the plan are written immediately. */
const TALLY_WRITE_MS = 2_000;

/**
 * Keeps the record's phase, tally and plan current while a search runs, so a page that joins late shows progress. Writes are
 * serialised and skip finished records; `end` flushes them so the final outcome is written last.
 */
function recordWhileRunning(s: Store, record: SearchRecord) {
  const created = Date.parse(record.createdAt);
  let phase = record.phase;
  let tally: Tally = NO_TALLY;
  let began: NonNullable<SearchRecord["tally"]>["began"] = {};
  let ran: Pick<SearchRecord, "request" | "plan"> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let over = false;
  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (over) return;
    last = Date.now();
    const now = { phase, tally: { ...tally, began }, ...ran };
    // A failed progress write must not fail the search.
    writes = writes.then(() => s.update(record.slug, (r) => (r.status === "running" ? { ...r, ...now } : r))).catch(() => undefined);
  };
  return {
    phase(p: SearchPhase) {
      phase = p;
      began = phaseSeen(began, p, Date.now() - created);
      write();
    },
    line(text: string) {
      const next = countLine(tally, text);
      if (next === tally) return;
      tally = next;
      if (!timer && !over) timer = setTimeout(write, Math.max(0, last + TALLY_WRITE_MS - Date.now()));
    },
    plan(request: SearchRequest, plan: PlanView) {
      ran = { request, plan };
      write();
    },
    async end() {
      // Flush a pending tally write so the final count matches the stream.
      if (timer) write();
      over = true;
      await writes;
    },
  };
}

/** Runs a created search and resolves with the finished record, which is also stored. */
export async function executeSearch(
  record: SearchRecord,
  onProgress?: (p: Progress) => void,
  deps: EngineDeps = liveDeps(),
  opts: { deadlineMs?: number } = {}
): Promise<SearchRecord> {
  const s = await store();
  const events: SearchEvent[] = [];
  let seq = 0;
  const at = () => new Date().toISOString();
  const live = recordWhileRunning(s, record);
  const hooks = {
    log: (text: string, kind: LogKind = "info") => {
      events.push({ seq: ++seq, at: at(), type: "log", text, kind, verbose: kind === "info" });
      onProgress?.({ type: "log", text, kind });
      live.line(text);
    },
    phase: (phase: SearchPhase) => {
      events.push({ seq: ++seq, at: at(), type: "phase", phase });
      onProgress?.({ type: "phase", phase });
      live.phase(phase);
    },
  };
  // Store the plan as soon as it arrives, so a page opened mid-search shows the trip.
  const planner: EngineDeps["planner"] = deps.planner && (async (req, o) => {
    const outcome = await deps.planner!(req, o);
    if (outcome.plan) live.plan(requestFromPlan(req, outcome.plan), toPlanView(outcome.plan));
    return outcome;
  });
  const startedAt = Date.now();
  const shape = tripShape(record.request);
  try {
    const out = await runSearch(record.request, { ...deps, planner }, hooks, opts);
    await live.end();
    const finished = await s.update(record.slug, (r) => ({
      ...r,
      // The request as the plan read it, so the record describes what was searched.
      request: out.request,
      status: "done",
      phase: "done",
      mode: deps.backend.live ? "live" : "demo",
      capturedAt: at(),
      events,
      plans: out.plans,
      analysis: out.analysis,
      verdict: out.verdict,
      view: out.view,
      plan: out.plan,
      stats: out.stats,
      session: out.session,
      unencoded: out.unencoded,
      error: null,
    }));
    const v = out.verdict;
    await recordMetric(
      searchEvent(
        "search_completed",
        record.slug,
        // The planned request: a worded request has no route until the plan sets one.
        tripShape(out.request),
        {
          durationMs: out.stats.durationMs,
          queries: out.stats.queries,
          rounds: 1,
          itineraries: out.stats.itineraries,
          economics: v.baseline != null ? { baseline: v.baseline, best: v.best, saved: v.baseline - v.best, currency: record.request.currency } : null,
          best: v.best,
          modelCostUsd: out.stats.costUsd,
          tokensIn: out.stats.tokensIn,
          tokensOut: out.stats.tokensOut,
          priceRankedFallback: out.stats.jev !== "used",
          unencoded: out.unencoded.map((u) => u.field),
        },
        { signedIn: Boolean(record.userId), detail: { jev: out.stats.jev, voice: out.stats.voice, missed: out.stats.missed ?? 0 } }
      )
    );
    return finished ?? { ...record, ...out, status: "done", phase: "done", events };
  } catch (e) {
    const raw = (e as Error).message || "Search failed";
    // `error` is public. TravellerError messages are shown as is; others are logged and replaced with a generic message.
    const message = e instanceof TravellerError ? raw : "Something went wrong on our side, so this search stopped. Search again to try it fresh.";
    await live.end();
    events.push({ seq: ++seq, at: at(), type: "error", message: raw });
    onProgress?.({ type: "log", text: message, kind: "error" });
    // Keep the planned trip if the search got that far, so the page shows what was searched and Edit starts from it.
    const ran = e instanceof SearchFailure ? { request: e.ran.request, plan: e.ran.plan } : {};
    const failed = await s.update(record.slug, (r) => ({ ...r, ...ran, status: "error", phase: "error", mode: deps.backend.live ? "live" : "demo", error: message, events }));
    // Report it unless the request itself caused it.
    if (!(e instanceof TravellerError && e.theirs)) await reportError("search", e, { where: e instanceof TravellerError ? "ended for the traveller" : "threw", slug: record.slug });
    await recordMetric(
      searchEvent(
        "search_failed",
        record.slug,
        shape,
        { durationMs: Date.now() - startedAt, queries: 0, rounds: 0, economics: null, best: null, modelCostUsd: null, tokensIn: 0, tokensOut: 0, priceRankedFallback: false, unencoded: [] },
        { signedIn: Boolean(record.userId), detail: { message: raw.slice(0, 200) } }
      )
    );
    return failed ?? { ...record, status: "error", phase: "error", error: message, events };
  }
}

/* -------------------------------- Follow-ups ------------------------------- */

/** Cap on questions per search, so a shared link can't be filled indefinitely. */
const MAX_FOLLOW_UPS = 40;

/** Queues a question; the route answers it with `answerFollowUp` inside `after()`. Returns "full" at the cap. */
export async function askFollowUp(slug: string, question: string): Promise<FollowUp | "full" | null> {
  const s = await store();
  const id = randomUUID().slice(0, 8);
  const followUp: FollowUp = { id, question, askedAt: new Date().toISOString(), status: "queued" };
  // Counted inside the update, under the record's lock, so concurrent questions can't both pass the cap.
  // Deleted searches take no questions.
  const record = await s.update(slug, (r) => (r.deletedAt || r.followUps.length >= MAX_FOLLOW_UPS ? r : { ...r, followUps: [...r.followUps, followUp] }));
  if (!record || record.deletedAt) return null;
  if (!record.followUps.some((f) => f.id === id)) return "full";
  await recordMetric(simpleEvent("followup_asked", { slug, shape: tripShape(record.request), signedIn: Boolean(record.userId) }));
  return followUp;
}

/** Time limit for a follow-up's searches. With the mid-search wait and two 45 s model passes, it fits the ask route's 180 s. */
const FOLLOWUP_SEARCH_MS = 60_000;
/** How long a question asked mid-search waits for the search to finish. */
const FOLLOWUP_WAIT_MS = 20_000;

/** How a follow-up was asked: the traveller's date, and "grid" when asked from the date grid. */
export type AskedFrom = { today?: string; source?: "grid" };

export async function answerFollowUp(slug: string, id: string, deps: EngineDeps = liveDeps(), asked: AskedFrom = {}): Promise<void> {
  const s = await store();
  // Always end the question answered or failed; one left "working" would be polled forever.
  try {
    await answerOnce(s, slug, id, deps, asked);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    await reportError("follow-up", e, { where: "answerFollowUp", slug });
    const at = new Date().toISOString();
    await s
      .update(slug, (r) => ({
        ...r,
        events: [...r.events, { seq: (r.events[r.events.length - 1]?.seq ?? 0) + 1, at, type: "error", message: `follow-up ${id}: ${message}` } as SearchEvent],
        followUps: r.followUps.map((f) =>
          f.id === id && (f.status === "queued" || f.status === "working") ? { ...f, status: "failed" as const, progress: undefined, answer: FOLLOWUP_FAILED, answeredAt: at } : f
        ),
      }))
      // The store itself may be what failed; the read-time expiry (`followUpLiveness`) still ends it.
      .catch(() => undefined);
  }
}

/** Follow-up cards get the card-line money rule (voice.ts): a summary that mentions money is replaced with code's own line. */
export function cardLines(plans: FlightPlan[], req: SearchRequest): FlightPlan[] {
  const amounts = planAmounts(plans);
  return plans.map((p) => (p.summary && mentionsMoney(p.summary, amounts) ? { ...p, summary: codeLine(p, plans, req) } : p.summary ? { ...p, summary: undash(p.summary) } : p));
}

async function answerOnce(s: Store, slug: string, id: string, deps: EngineDeps, asked: AskedFrom): Promise<void> {
  let current = await s.get(slug);
  if (!current) return;

  // withLiveness treats a search cut off mid-run as ended, as the page does.
  current = withLiveness(current);
  const waitUntil = Date.now() + FOLLOWUP_WAIT_MS;
  while (current.status === "running" && Date.now() < waitUntil) {
    await new Promise((r) => setTimeout(r, 1500));
    current = withLiveness((await s.get(slug)) ?? current);
  }
  if (!current.session || !deps.voice) {
    const answer =
      current.status === "running"
        ? "I'm still searching. Ask me again once the results are in."
        : current.session
          ? "I can’t answer questions right now."
          : "The search didn't finish, so I don't have anything to answer from yet.";
    const answeredAt = new Date().toISOString();
    await s.update(slug, (r) => ({
      ...r,
      followUps: r.followUps.map((f) => (f.id === id ? { ...f, status: "failed", progress: undefined, answer, answeredAt } : f)),
    }));
    return;
  }
  await s.update(slug, (r) => ({ ...r, followUps: r.followUps.map((f) => (f.id === id ? { ...f, status: "working" } : f)) }));
  const followUp = current.followUps.find((f) => f.id === id);
  if (!followUp) return;

  let rows = current.session.rows as CompactRow[];
  const base = {
    req: current.request,
    today: asked.today ?? new Date().toISOString().slice(0, 10),
    question: followUp.question,
    plansShown: (current.plans ?? []).map((p) => ({ label: p.label, price: p.price, summary: p.summary })),
    facts: tripFacts(current.request, current.unencoded),
    handoff: `The search did this: ${current.session.roundNotes.join("; ")}.`,
    history: current.followUps
      .filter((f) => f.id !== id && f.status === "answered" && f.answer)
      .map((f) => ({ question: f.question, answer: f.answer! }))
      // The last few give enough context and keep the prompt bounded.
      .slice(-6),
    timeoutMs: 45_000,
  };
  const setProgress = (progress: string) => s.update(slug, (r) => ({ ...r, followUps: r.followUps.map((f) => (f.id === id ? { ...f, progress } : f)) }));

  // Pass one: answer from what is held, or ask for queries.
  let { result, failure } = await answerQuestion(deps.voice, { ...base, rows: rowsForModel(rows), canSearch: true, fromGrid: asked.source === "grid" });

  // From the date grid's box, an answer about other days rebuilds the grid around them.
  if (asked.source === "grid" && result && !result.search?.grid) {
    const around = gridAround(result, rows, current.view?.grid, current.plan);
    if (around) result = { ...result, search: { note: result.search?.note?.trim() || "Pricing the days around those dates…", queries: result.search?.queries ?? [], explore: result.search?.explore ?? null, grid: around } };
  }

  // Pass two: run the requested queries and views, add the rows to the session, and ask again.
  let views: Awaited<ReturnType<typeof runFollowUpViews>> | null = null;
  /** Calls that never answered. A follow-up with any is not answered from partial results. */
  let unanswered: string[] = [];
  if (result?.search && (result.search.queries.length || result.search.grid || result.search.explore)) {
    const note = undash(result.search.note ?? "") || "Checking that now…";
    await setProgress(note);
    const lines: string[] = [];
    const signal = AbortSignal.timeout(FOLLOWUP_SEARCH_MS);
    const [found, built] = await Promise.all([
      result.search.queries.length
        ? runFollowUpQueries({ backend: deps.backend, fallback: deps.fallback, req: current.request, queries: result.search.queries, existing: rows, signal, log: (l) => lines.push(l) })
        : Promise.resolve({ rows: [] as CompactRow[], asked: 0, calls: 0, firstId: 0, unanswered: [] as string[] }),
      result.search.grid || result.search.explore
        ? runFollowUpViews({
            backend: deps.backend,
            req: current.request,
            ask: result.search,
            signal,
            log: (l) => lines.push(l),
            separate: current.view?.grid?.separate ?? current.plan?.separateTickets ?? current.request.hassle >= 3,
            today: base.today,
            plans: current.plans ?? [],
            // "Your dates" on a rebuilt grid stay the search's anchor dates.
            requested: current.plan
              ? { out: current.plan.dates.anchor.out, ret: current.plan.dates.anchor.ret ?? current.plan.dates.anchor.out }
              : current.request.departDate
                ? { out: current.request.departDate, ret: current.request.returnDate ?? current.request.departDate }
                : undefined,
          })
        : Promise.resolve(null),
    ]);
    unanswered = [...found.unanswered, ...(built?.unanswered ?? [])];
    views = unanswered.length ? null : built;
    // Drop partial results, which a later question would read as complete.
    if (!unanswered.length) rows = [...rows, ...found.rows];
    const kept = rows.length > MAX_SESSION_ROWS ? [...rows].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)).slice(0, MAX_SESSION_ROWS) : rows;
    const at = new Date().toISOString();
    await s.update(slug, (r) => {
      let seq = (r.events[r.events.length - 1]?.seq ?? 0) + 1;
      const events: SearchEvent[] = [
        ...r.events,
        { seq: seq++, at, type: "log", text: `Follow-up "${followUp.question}" ▸ ${note}`, kind: "action", verbose: true },
        ...lines.map((text) => ({ seq: seq++, at, type: "log" as const, text: `  ${text}`, kind: "info" as const, verbose: true })),
      ];
      return { ...r, events, session: r.session ? { ...r.session, rows: kept } : r.session };
    });
    if (!unanswered.length) {
      await setProgress("Reading what came back…");
      ({ result, failure } = await answerQuestion(deps.voice, {
        ...base,
        rows: rowsForModel(rows),
        canSearch: false,
        ...(views?.summary.length ? { viewsBuilt: views.summary.join("\n") } : {}),
        searched:
          `"${note}" — ${found.asked ? `${found.asked} ${found.asked === 1 ? "query" : "queries"}, each round trip asked from every airport at each end (${found.calls} calls), every one answered; ` : ""}` +
          (found.rows.length ? `${found.rows.length} new itineraries (ids ${found.firstId} and up).` : found.asked ? `nothing new came back — either those routes and dates have no flights, or everything found was already held.` : "no shopping queries were run."),
      }));
    }
  }

  const answeredAt = new Date().toISOString();
  const req = current.request;
  // Build the cards first: their prices, and differences from the cards shown, count as amounts code worked out.
  const picked = result?.picks.length ? noteRouteSwaps(cardLines(plansFromPicks(result.picks, rows, `ask-${id}`, req), req), req) : [];
  const amounts = answerAmounts({
    rows,
    plans: [...(current.plans ?? []), ...picked],
    seats: seatedTravellers(req.passengers),
    extra: [current.verdict?.baseline, current.verdict?.saved, ...((views?.grid ?? current.view?.grid)?.cells ?? []).map((c) => c.price), ...(views?.destinations ?? []).map((d) => d.price)],
  });
  // An answer naming an amount code didn't work out is replaced with a plain one, as in the write-up (voice.ts).
  const said = result ? (moneyAllowed(result.answer, amounts) ? undash(result.answer) : plainAnswer({ cards: picked.length, grid: Boolean(views?.grid), places: Boolean(views?.destinations?.length) })) : null;
  await s.update(slug, (r) => {
    let seq = (r.events[r.events.length - 1]?.seq ?? 0) + 1;
    return {
      ...r,
      // One date grid per chat: a follow-up that built one replaces it.
      ...(result && views?.grid ? { view: { ...(r.view ?? { kind: "closed" as const }), grid: views.grid } } : {}),
      events: [
        ...r.events,
        { seq: seq++, at: answeredAt, type: "answer", askId: id } as SearchEvent,
        // Failure details go to the event log; the traveller gets a generic message below.
        ...(unanswered.length
          ? [{ seq: seq++, at: answeredAt, type: "error", message: `follow-up ${id}: ${unanswered.length} calls never answered (${unanswered.slice(0, 3).join("; ")})` } as SearchEvent]
          : !result && failure
            ? [{ seq: seq++, at: answeredAt, type: "error", message: `follow-up ${id}: ${failure}` } as SearchEvent]
            : result && !moneyAllowed(result.answer, amounts)
              ? [{ seq: seq++, at: answeredAt, type: "log", kind: "info", verbose: true, text: `Follow-up ${id}'s answer named an amount code did not work out, so ${said ? "a plain line stands" : "it was not shown"}: "${result.answer.slice(0, 140)}"` } as SearchEvent]
              : []),
      ],
      followUps: r.followUps.map((f) =>
        f.id === id
          ? unanswered.length
            ? {
                ...f,
                status: "failed" as const,
                progress: undefined,
                answer: "I couldn't get a full answer on that. Ask me again in a moment.",
                answeredAt,
              }
            : result && said
              ? {
                  ...f,
                  status: "answered" as const,
                  progress: undefined,
                  answer: said,
                  answeredAt,
                  ...(picked.length ? { plans: picked } : {}),
                  ...(views?.grid ? { gridUpdated: true } : {}),
                  ...(views?.destinations ? { destinations: views.destinations } : {}),
                  ...(views?.viewTitle ? { viewTitle: views.viewTitle } : {}),
                }
              : {
                  ...f,
                  status: "failed" as const,
                  progress: undefined,
                  answer: FOLLOWUP_FAILED,
                  answeredAt,
                }
          : f
      ),
    };
  });
}
