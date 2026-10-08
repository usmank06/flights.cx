import { z } from "zod";
import { callModelStructured, type ModelUsage } from "./core";
import type { ModelOption } from "./models";
import { hedged } from "./plan";
import { FINAL_SYSTEM, ROUND_SYSTEM } from "./prompts";
import { undash } from "./voice";

/**
 * Explore agent for open destinations, the one place a model decides what the page shows. Over up to three rounds it picks known
 * places to price and names new ones to look up, then chooses up to six to show. It sees prices only as tier words. A failed
 * round stops the rounds. If the final call fails, code shows the cheapest matching places.
 */

export type KnownPlace = {
  code: string;
  name: string;
  country: string | null;
  /** Rank of the place's cheapest fare among the known ones, in words (see `tierWord`). Null when unpriced. */
  tier: string | null;
  nonstop: boolean | null;
  /** The provider listed it, or the model asked for it. */
  source: "listed" | "asked";
};

export type ExploreRound = { price: string[]; look: { name: string; why: string }[]; enough: boolean; usage: ModelUsage | null; ms: number; failure?: string };
export type ExploreFinal = { show: { code: string; why: string }[]; usage: ModelUsage | null; ms: number; failure?: string };

export type ExploreAgent = {
  round(opts: { hint: string; month: string; origin: string; round: number; known: KnownPlace[]; maxLook: number; signal?: AbortSignal; timeoutMs?: number }): Promise<ExploreRound>;
  final(opts: { hint: string; month: string; origin: string; known: KnownPlace[]; signal?: AbortSignal; timeoutMs?: number }): Promise<ExploreFinal>;
};

const RoundSchema = z.object({
  price: z.array(z.string()).describe("Codes of LISTED places worth pricing properly now because they fit the brief; up to eight; empty if none"),
  look: z.array(z.object({ name: z.string().describe("A city, in Title Case"), why: z.string().describe("Under six words on why it fits") })).describe("Places NOT on the list that would fit better and are plausible to fly to from the origin; empty when the list already covers it"),
  enough: z.boolean().describe("True when the listed and priced places already cover the brief well and no more looking is needed"),
});

const FinalSchema = z.object({
  show: z.array(z.object({ code: z.string().describe("A code from the list, exactly as listed"), why: z.string().describe("Under six words on why it fits, shown on the card") })).describe("Up to six places to show, best fit first; only places with a price tier"),
});

const PLACES_PER_ROUND = 40;

/** The place list as the model reads it, with no fares. */
function listing(known: KnownPlace[]): string {
  return known
    .slice(0, PLACES_PER_ROUND)
    .map((p) => `${p.code} — ${p.name}${p.country ? `, ${p.country}` : ""}: ${p.tier ?? "not priced yet"}${p.nonstop == null ? "" : p.nonstop ? ", nonstop available" : ", no nonstop"}${p.source === "asked" ? " (you asked for this one)" : ""}`)
    .join("\n");
}

/** Strips digits and currency signs, then trims to `max` at a word boundary and drops dangling words ("at nearly"). */
const noDigits = (s: string, max = 60) => {
  let t = s.replace(/[$€£¥]|\d+/g, "").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max + 1).replace(/\s+\S*$/, "");
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/[\s,;:–—-]+$/, "").replace(/\s+(and|or|but|at|with|for|to|the|a|an|of|in|on|from|nearly|just|almost|so|than|by)$/i, "");
  }
  return t;
};

/** Live explore agent using the given model for both calls. */
export function liveExploreAgent(model: ModelOption): ExploreAgent {
  return {
    async round(opts) {
      const t0 = Date.now();
      const user = `From ${opts.origin}, travelling in ${opts.month}. They asked for: "${opts.hint}". This is round ${opts.round} of at most three.\n\nKnown places:\n${listing(opts.known)}\n\nName at most ${opts.maxLook} places not on the list.`;
      const r = await hedged((budget) => callModelStructured(model, RoundSchema, "explore_round", ROUND_SYSTEM, user, { effort: "low", timeoutMs: budget, maxTokens: 600, signal: opts.signal }), opts.timeoutMs ?? 16_000);
      if (!r.parsed) return { price: [], look: [], enough: true, usage: r.usage, ms: Date.now() - t0, failure: r.failure ?? "no answer" };
      const listed = new Set(opts.known.map((p) => p.code));
      const price = [...new Set(r.parsed.price.map((c) => c.trim().toUpperCase()))].filter((c) => listed.has(c)).slice(0, 8);
      const known = new Set(opts.known.map((p) => p.name.toLowerCase()));
      const look = r.parsed.look
        .map((l) => ({ name: noDigits(l.name, 40), why: undash(noDigits(l.why)) }))
        .filter((l) => l.name && !known.has(l.name.toLowerCase()))
        .slice(0, opts.maxLook);
      return { price, look, enough: r.parsed.enough, usage: r.usage, ms: Date.now() - t0 };
    },
    async final(opts) {
      const t0 = Date.now();
      const priced = opts.known.filter((p) => p.tier);
      const user = `From ${opts.origin}, travelling in ${opts.month}. They asked for: "${opts.hint}".\n\nPriced places:\n${listing(priced)}`;
      const r = await hedged((budget) => callModelStructured(model, FinalSchema, "explore_final", FINAL_SYSTEM, user, { effort: "low", timeoutMs: budget, maxTokens: 500, signal: opts.signal }), opts.timeoutMs ?? 16_000);
      if (!r.parsed) return { show: [], usage: r.usage, ms: Date.now() - t0, failure: r.failure ?? "no answer" };
      const allowed = new Set(priced.map((p) => p.code));
      const seen = new Set<string>();
      const show = r.parsed.show
        .map((s) => ({ code: s.code.trim().toUpperCase(), why: undash(noDigits(s.why)) }))
        .filter((s) => allowed.has(s.code) && !seen.has(s.code) && seen.add(s.code))
        .slice(0, 6);
      return { show, usage: r.usage, ms: Date.now() - t0 };
    },
  };
}

/** A fare's rank among the known fares, in words. This is the only form of price the model sees. */
export function tierWord(price: number, sorted: number[]): string {
  if (!sorted.length) return "not priced yet";
  const min = sorted[0];
  if (price <= min) return "the cheapest of all";
  if (price <= min * 1.1) return "within a little of the cheapest";
  const pos = sorted.findIndex((p) => p >= price) / Math.max(1, sorted.length - 1);
  if (pos < 0.34) return "among the cheaper ones";
  if (pos < 0.67) return "in the middle";
  return "among the pricier ones";
}
