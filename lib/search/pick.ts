import type { PlanScores, PlanSlot, SearchRequest } from "@/lib/types";
import { briefWords, candidateWords, stayNights, type CandidateWords } from "./candidates";
import type { IndexedItin } from "./core";
import type { ChoiceAnswer, JevClient, JevQuestion, NoulAnswer, ScoreAnswer } from "./jev";
import { CLASSIC_PICKS, type PickRank, type PickSpec, type TripPlan } from "./plan";

/**
 * Plan picking. Code builds a ranked shortlist per pick, Jev judges every candidate in words in one request, and code assembles the
 * result. Jev returns only ids and probabilities. An unsure pick falls back to a ranking from Jev's scores. If the call fails,
 * code makes every pick.
 */

export type Pairing = { out: IndexedItin; ret: IndexedItin | null };

export type SlotPick = { slot: PlanSlot; spec: PickSpec; pair: Pairing; label: string; scores: PlanScores | null; pickedBy: "jev" | "code" };

export type PickOutcome = {
  picks: SlotPick[];
  source: "jev" | "code";
  usage: { in: number; out: number; costUsd: number | null } | null;
  ms: number;
  failure?: string;
};

/** Jev's label choices for the three classic picks. A pick the planner named keeps the planner's label. */
export const SLOT_LABELS: Record<string, Record<string, string>> = {
  cheapest: {
    Cheapest: "the lowest total price, whatever it costs in hours or stops",
    "Cheapest nonstop": "the lowest price that is also nonstop",
    "Cheapest, but rough": "the lowest price and it shows: long layovers, odd hours or an overnight",
  },
  value: {
    "Best value": "a good price for an acceptable amount of hassle",
    "Nearly as cheap": "within a little of the cheapest and much easier",
    "Worth the extra": "costs noticeably more and buys something the traveller will feel",
  },
  hours: {
    "Best hours": "the most civilised departure and arrival",
    "Easiest trip": "the fewest stops and the shortest day",
    Nonstop: "it is nonstop and that is the point",
  },
};

export const DEFAULT_LABEL: Record<string, string> = { cheapest: "Cheapest", value: "Best value", hours: "Best hours" };
export const defaultLabel = (spec: PickSpec): string => DEFAULT_LABEL[spec.key] ?? spec.label;

const total = (p: Pairing) => (p.out.itin.price ?? Infinity) + (p.ret?.itin.price ?? 0);
const travelMinutes = (p: Pairing) => p.out.itin.totalDurationMinutes + (p.ret?.itin.totalDurationMinutes ?? 0);
const nights = (p: Pairing) => stayNights(p.out, p.ret) ?? 0;

/** How civilised the flight times are, 0 (worst) to 1 (best). Used for shortlists and fallbacks. */
export function hoursScore(p: Pairing): number {
  const legs = [p.out.itin, ...(p.ret ? [p.ret.itin] : [])];
  let s = 0;
  for (const it of legs) {
    const dep = Number(it.departure.slice(11, 13));
    const arr = Number(it.arrival.slice(11, 13));
    let v = 1;
    // Pre-dawn departures and arrivals cost the most. A late-evening departure (red-eye) costs less.
    if (dep < 6) v -= 0.4;
    else if (dep >= 22) v -= 0.2;
    else if (dep < 8) v -= 0.15;
    if (arr < 6) v -= 0.4;
    else if (arr >= 23) v -= 0.3;
    v -= Math.min(0.3, it.stops * 0.15);
    for (const l of it.layovers) if (l.minutes >= 240) v -= 0.15;
    if (it.segments.some((x) => x.overnight)) v -= 0.1;
    s += Math.max(0, v);
  }
  return s / legs.length;
}

/** Hassle score, 0 (none) to 1 (worst). */
export function hassleScore(p: Pairing): number {
  const legs = [p.out.itin, ...(p.ret ? [p.ret.itin] : [])];
  let s = 0;
  for (const it of legs) {
    let v = Math.min(0.5, it.stops * 0.25);
    for (const l of it.layovers) v += l.minutes >= 300 ? 0.25 : l.minutes >= 180 ? 0.1 : l.minutes < 60 ? 0.1 : 0;
    if (it.segments.some((x) => x.overnight)) v += 0.1;
    if (it.segments.some((x) => x.oftenDelayed)) v += 0.05;
    s += Math.min(1, v);
  }
  if (p.ret) s = Math.min(1, s / legs.length + 0.2); // separate tickets add hassle
  else s = s / legs.length;
  return s;
}

/**
 * Deterministic order for one rank, best first. Price breaks ties. Non-price ranks only consider fares up to a multiple of the
 * cheapest, so "best hours" can't pick a fare three times the price.
 */
export function rankOrder(rank: PickRank, list: Pairing[]): Pairing[] {
  const priced = list.filter((p) => Number.isFinite(total(p)));
  const floor = priced.length ? Math.min(...priced.map(total)) : 0;
  const gap = (p: Pairing) => (total(p) - floor) / Math.max(1, floor);
  const capped = (x: number) => priced.filter((p) => total(p) <= floor * x);
  const by = (pool: Pairing[], k: (p: Pairing) => number) => [...pool].sort((a, b) => k(a) - k(b) || total(a) - total(b));
  switch (rank) {
    case "price":
      // At one price, the better hours first.
      return [...priced].sort((a, b) => total(a) - total(b) || hoursScore(b) - hoursScore(a));
    case "hours": {
      const pool = capped(1.75);
      return by(pool.length ? pool : priced, (p) => -(hoursScore(p) - hassleScore(p) * 0.3 - gap(p) * 0.1));
    }
    case "quickest": {
      const pool = capped(1.75);
      return by(pool.length ? pool : priced, (p) => travelMinutes(p) + gap(p) * 60);
    }
    case "stay": {
      // Most nights first, with a looser price cap (2.2x the cheapest) so the longest stays aren't cut.
      const pool = capped(2.2);
      return by(pool.length ? pool : priced, (p) => -nights(p) + gap(p) * 1.5);
    }
    default:
      return by(priced, (p) => gap(p) + hassleScore(p) * 0.6 + (1 - hoursScore(p)) * 0.2);
  }
}

/** The candidates worth asking about for each pick. */
export function shortlists(pairs: Pairing[], specs: PickSpec[], n = 6): Map<string, Pairing[]> {
  const lists = new Map<string, Pairing[]>();
  for (const spec of specs) lists.set(spec.key, rankOrder(spec.rank, pairs).slice(0, n));
  return lists;
}

const key = (p: Pairing) => `c${p.out.id}${p.ret ? `+c${p.ret.id}` : ""}`;

/** Deterministic pick for one spec, used when Jev is unavailable or has scored none of the shortlist. */
export function codePick(spec: PickSpec, list: Pairing[], taken: Set<string>): Pairing | null {
  const free = list.filter((p) => !taken.has(key(p)));
  const pool = free.length ? free : list;
  if (!pool.length) return null;
  return rankOrder(spec.rank, pool)[0] ?? null;
}

const pct = (x: number) => Math.max(0, Math.min(100, Math.round(x * 100)));

export async function pickPlans(opts: {
  pairs: Pairing[];
  req: SearchRequest;
  /** Picks and brief reading from the plan. Null uses the classic three picks and the form alone. */
  plan: TripPlan | null;
  wantedFrom: string | undefined;
  wantedTo: string | undefined;
  jev: JevClient | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Below this confidence a pick's choice is not trusted. */
  minConfidence?: number;
}): Promise<PickOutcome> {
  const { pairs, req, plan } = opts;
  const t0 = Date.now();
  const specs = plan?.picks.length ? plan.picks : CLASSIC_PICKS;
  const lists = shortlists(pairs, specs);
  const namePlaces = (plan?.destinations.length ?? 0) > 1;
  const fallback = (failure?: string): PickOutcome => {
    const taken = new Set<string>();
    const picks: SlotPick[] = [];
    for (const spec of specs) {
      const p = codePick(spec, lists.get(spec.key) ?? [], taken);
      if (!p || taken.has(key(p))) continue;
      taken.add(key(p));
      picks.push({ slot: spec.key, spec, pair: p, label: defaultLabel(spec), scores: null, pickedBy: "code" });
    }
    keepCheapestCheapest(picks);
    return { picks, source: "code", usage: null, ms: Date.now() - t0, ...(failure ? { failure } : {}) };
  };
  if (!opts.jev) return fallback();

  // Every shortlisted candidate once, described in words.
  const union = new Map<string, Pairing>();
  for (const list of lists.values()) for (const p of list) union.set(key(p), p);
  if (!union.size) return fallback("nothing to pick from");
  const sortedPrices = [...union.values()].map(total).sort((a, b) => a - b);
  const words = new Map<string, CandidateWords>();
  for (const [k, p] of union) words.set(k, { ...candidateWords(p.out, p.ret, req, sortedPrices, opts.wantedFrom, opts.wantedTo, namePlaces), id: k });

  const questions: Record<string, JevQuestion> = {};
  for (const [k, w] of words) {
    questions[`${k}_fit`] = {
      type: "noul",
      instructions: `Does candidate ${k} meet everything the traveller said they must have (their notes, their hassle tolerance, their dates if fixed)? Judge the candidate's own words: ${w.dates}; ${w.out.stops}; ${w.notes.join("; ") || "no notes"}.`,
      criteria: { true: "nothing about it breaks a stated must", false: "it breaks something the traveller said they must have" },
    };
    questions[`${k}_hassle`] = {
      type: "score",
      instructions: `How much hassle is candidate ${k} for this traveller?`,
      criteria: ["nonstop or one short stop at civilised hours", "one stop with a moderate layover, or an early or late departure", "a long layover, an overnight connection, or a very early departure", "several long layovers, separate tickets, or brutal hours"],
    };
    questions[`${k}_hours`] = {
      type: "score",
      instructions: `How civilised are candidate ${k}'s departure and arrival times for this traveller?`,
      criteria: ["brutal: small-hours departures or arrivals, or an overnight the traveller did not ask for", "awkward but liveable", "civilised: daytime or a sensible evening at both ends"],
    };
  }
  for (const spec of specs) {
    const criteria: Record<string, string> = {};
    for (const p of lists.get(spec.key) ?? []) {
      const w = words.get(key(p))!;
      criteria[key(p)] = `${w.fare}; price ${w.price}; ${w.dates}${w.stay ? `; ${w.stay}` : ""}; out ${w.out.day} ${w.out.departs}, ${w.out.stops}, ${w.out.duration}${w.back ? `; back ${w.back.day} ${w.back.departs}, ${w.back.stops}` : ""}${w.airports ? `; ${w.airports}` : ""}${w.notes.length ? `; ${w.notes.join(", ")}` : ""}`;
    }
    if (Object.keys(criteria).length > 1) questions[`slot_${spec.key}`] = { type: "choice", instructions: `${spec.want} Only reject a candidate that fits better for something the traveller said they will not accept.`, criteria };
    if (SLOT_LABELS[spec.key])
      questions[`label_${spec.key}`] = {
        type: "choice",
        instructions: `Which label best describes the candidate you chose for "${spec.label}"?`,
        criteria: SLOT_LABELS[spec.key],
      };
  }

  const state = { traveller: briefWords(req, plan), candidates: [...words.values()] };
  let result;
  try {
    result = await opts.jev(state, questions, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 5_000 });
  } catch (e) {
    return fallback(`Jev: ${(e as Error).message}`);
  }
  const a = result.answers;
  const noul = (k: string) => (a[k]?.type === "noul" ? (a[k] as NoulAnswer).noul : null);
  const score = (k: string, levels: number) => (a[k]?.type === "score" ? (a[k] as ScoreAnswer).score / (levels - 1) : null);
  const choice = (k: string) => (a[k]?.type === "choice" ? (a[k] as ChoiceAnswer) : null);
  const minConf = opts.minConfidence ?? 0.35;

  // Jev's scores per candidate. An unsure pick ranks by these before falling back to code.
  const judged = new Map<string, { fit: number; hassle: number; hours: number }>();
  for (const k of union.keys()) {
    const fit = noul(`${k}_fit`);
    const hassle = score(`${k}_hassle`, 4);
    const hours = score(`${k}_hours`, 3);
    if (fit != null && hassle != null && hours != null) judged.set(k, { fit, hassle, hours });
  }
  const bySpec = (spec: PickSpec, list: Pairing[], taken: Set<string>): Pairing | null => {
    const free = list.filter((p) => !taken.has(key(p)) && judged.has(key(p)));
    if (!free.length) return codePick(spec, list, taken);
    const floor = Math.min(...free.map(total));
    const most = Math.max(1, ...free.map(nights));
    const rank = (p: Pairing) => {
      const j = judged.get(key(p))!;
      const priceGap = (total(p) - floor) / Math.max(1, floor);
      switch (spec.rank) {
        case "price":
          return priceGap * 3 + (1 - j.fit) * 0.5;
        case "hours":
          return (1 - j.hours) + j.hassle * 0.5 + priceGap * 0.5 + (1 - j.fit) * 0.5;
        case "stay":
          return (1 - nights(p) / most) * 2 + priceGap + (1 - j.fit) * 0.5;
        case "quickest":
          return travelMinutes(p) / 600 + priceGap * 0.5 + (1 - j.fit) * 0.5;
        default:
          return priceGap + j.hassle * 0.7 + (1 - j.hours) * 0.3 + (1 - j.fit) * 0.5;
      }
    };
    return [...free].sort((a, b) => rank(a) - rank(b))[0];
  };

  const taken = new Set<string>();
  const picks: SlotPick[] = [];
  for (const spec of specs) {
    const list = lists.get(spec.key) ?? [];
    if (!list.length) continue;
    let chosen: Pairing | null = null;
    let confidence: number | null = null;
    const c = choice(`slot_${spec.key}`);
    if (c && c.confidence >= minConf) {
      // Most likely candidate not already taken, so the plans stay distinct.
      const ranked = Object.entries(c.probabilities).sort((x, y) => y[1] - x[1]);
      for (const [k, p] of ranked) {
        if (taken.has(k)) continue;
        const cand = union.get(k);
        if (cand && p >= minConf * 0.5) {
          chosen = cand;
          confidence = k === c.choice ? c.confidence : p;
          break;
        }
      }
    } else if (list.length === 1 && !taken.has(key(list[0]))) {
      chosen = list[0];
      confidence = 1;
    }
    const pickedBy: "jev" | "code" = chosen ? "jev" : "code";
    if (!chosen) chosen = bySpec(spec, list, taken);
    if (!chosen || taken.has(key(chosen))) continue;
    const k = key(chosen);
    taken.add(k);
    const j = judged.get(k);
    const lab = choice(`label_${spec.key}`);
    const label = pickedBy === "jev" && lab && lab.confidence >= minConf && SLOT_LABELS[spec.key] && lab.choice in SLOT_LABELS[spec.key] ? lab.choice : defaultLabel(spec);
    picks.push({
      slot: spec.key,
      spec,
      pair: chosen,
      label,
      pickedBy,
      scores: j ? { fit: pct(j.fit), hassle: pct(j.hassle), hours: pct(j.hours), confidence: pct(confidence ?? 0) } : null,
    });
  }
  if (!picks.length) return fallback("Jev answered but nothing could be chosen");
  keepCheapestCheapest(picks);
  return { picks, source: picks.some((p) => p.pickedBy === "jev") ? "jev" : "code", usage: result.usage, ms: Date.now() - t0 };
}

/**
 * Makes the price pick the cheapest plan shown, since another pick undercutting "Cheapest" reads as a wrong label. Otherwise the
 * two swap slots, take default labels and are marked as picked by code.
 */
export function keepCheapestCheapest(picks: SlotPick[]): void {
  const cost = (p: SlotPick) => (p.pair.out.itin.price ?? 0) + (p.pair.ret?.itin.price ?? 0);
  const pricePick = picks.find((p) => p.spec.rank === "price");
  const minPick = [...picks].sort((a, b) => cost(a) - cost(b))[0];
  if (!pricePick || !minPick || minPick === pricePick || cost(minPick) >= cost(pricePick)) return;
  const [a, b] = [pricePick.spec, minPick.spec];
  const order = picks.map((p) => p.slot);
  minPick.spec = a;
  minPick.slot = a.key;
  minPick.label = defaultLabel(a);
  minPick.pickedBy = "code";
  pricePick.spec = b;
  pricePick.slot = b.key;
  pricePick.label = defaultLabel(b);
  pricePick.pickedBy = "code";
  picks.sort((x, y) => order.indexOf(x.slot) - order.indexOf(y.slot));
}
