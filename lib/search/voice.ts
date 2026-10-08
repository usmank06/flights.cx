import { z } from "zod";
import { flightClock, money, shortDate } from "@/lib/format";
import type { FlightPlan, SearchRequest } from "@/lib/types";
import { callModelStructured, daysBetween, PlannedQuerySchema, shiftDay, type ModelRow, type ModelUsage } from "./core";
import type { ModelOption } from "./models";
import { asciiDigits } from "./intake";
import { ANSWER_SYSTEM, VOICE_SYSTEM } from "./prompts";

/**
 * Model calls that write prose: the results write-up and follow-up answers. Each gets facts with prices already formatted, and a
 * reply that uses a number it wasn't given is discarded in favour of code's own line.
 */

const VoiceSchema = z.object({
  analysis: z.string().describe("Exactly one sentence for the traveller, under 30 words, on the trade-off between the options."),
  lines: z
    .array(z.object({ id: z.string(), line: z.string().describe("One line under fourteen words on what is different about this option; no price, no saving, no names or labels.") }))
    .describe("One entry per option id given, in the same order."),
});

export type VoiceFacts = {
  req: SearchRequest;
  facts: string;
  plans: FlightPlan[];
  verdictLine: string;
  viewLine: string;
};

export type VoiceOutcome = {
  analysis: string | null;
  lines: Record<string, string>;
  usage: ModelUsage | null;
  failure?: string;
  ms: number;
};

/** A number in any locale's format: "1,357", "1.357", "1 357" (narrow space), "١٬٣٥٧", "12,34,567". */
const NUMBER = String.raw`\d+(?:[,.\u066b\u066c]\d+|[ \u00a0\u202f]\d{3}(?!\d))*`;

/** Every number in a string as bare digits, so "$1,880", "1880" and "1.880" compare equal. */
const numbersIn = (s: string): Set<string> => new Set(asciiDigits(s).match(new RegExp(NUMBER, "g"))?.map((n) => n.replace(/\D/g, "")) ?? []);

/** Currency signs, including the riyal and dirham in Arabic script, the full-width yen and 元. */
const MONEY_SIGN = String.raw`[$€£¥￥₹₩₺₽₪₫฿₱元﷼]|ر\.?\s?س\.?|د\.?\s?إ\.?`;
const MONEY_CODE = String.raw`\b(?:USD|EUR|GBP|INR|SAR|AED|JPY|CNY|RMB|KRW|CAD|AUD|NZD|CHF|MXN|BRL|SGD|HKD|SEK|NOK|DKK|PLN|ZAR|QAR|KWD|BHD|OMR|EGP|THB)\b`;
const MONEY_WORD = String.raw`\b(?:[Dd]ollars?|[Bb]ucks|[Ee]uros?|[Pp]ounds?|[Qq]uid|[Rr]upees?|[Rr]iyals?|[Rr]ials?|[Dd]irhams?|[Yy]en|[Yy]uan|[Rr]enminbi|[Ww]on)\b|ريال|درهم`;
const MARK = `(?:${MONEY_SIGN}|${MONEY_CODE}|${MONEY_WORD})`;
/** A currency sign, code or word on either side of a number ("$1,357", "1.357 €", "SAR 1,357", "900 euros"). */
const MONEY_TOKEN = new RegExp(`${MARK}\\s?(${NUMBER})(\\s?[kK]\\b)?|(${NUMBER})(\\s?[kK]\\b)?\\s?${MARK}`, "g");

/** Every amount of money in a text, as bare digits. "$1.4k" keeps a "k" suffix so it can't match a computed amount. */
export function moneyIn(s: string): string[] {
  return [...asciiDigits(s).matchAll(MONEY_TOKEN)].map((m) => (m[1] ?? m[3]).replace(/\D/g, "") + (m[2] ?? m[4] ? "k" : ""));
}

/** Replaces dashes between words with commas, a house style for model replies. Ranges ("9:05–17:20", "Mar 10–14") keep theirs. */
export const undash = (s: string): string =>
  s
    .replace(/^\s*[—–]\s*/, "")
    .replace(/\s+[—–]\s+|(?<=\p{L})\s*—\s*(?=\p{L})/gu, ", ")
    .replace(/,\s*([,.;:!?])/g, "$1")
    .trim();

/** The first sentence of a reply; the write-up is one sentence. */
export const firstSentence = (s: string): string => s.trim().split(/(?<=[.!?])\s+(?=[A-Z“"(])/)[0].trim();

/** Amounts a card line must not repeat, as bare digits: each price, its gap to the cheapest, and its per-traveller share. */
export function planAmounts(plans: FlightPlan[]): Set<string> {
  const cheapest = Math.min(...plans.map((p) => p.price));
  const amounts = new Set<string>();
  for (const p of plans) for (const n of [p.price, p.price - cheapest, p.perTraveller ?? 0]) if (n > 0) for (const d of numbersIn(`${n} ${money(n, p.currency)}`)) amounts.add(d);
  return amounts;
}

/** Whether a card line mentions money: a currency sign, a money token, or any of the plans' amounts. */
export function mentionsMoney(line: string, amounts: Set<string>): boolean {
  if (new RegExp(MONEY_SIGN).test(asciiDigits(line)) || moneyIn(line).length) return true;
  for (const n of numbersIn(line)) if (amounts.has(n)) return true;
  return false;
}

/** Replaces every amount of money with "(a price)". Keeps the traveller's figures out of what the picker reads. */
export const withoutMoney = (s: string): string => asciiDigits(s).replace(MONEY_TOKEN, "(a price)").replace(/\b\d[\d,.]*\s?k\b/gi, "(a price)");

/** Whether every amount of money in a text is one code worked out. */
export const moneyAllowed = (text: string, allowed: Set<string>): boolean => moneyIn(text).every((n) => allowed.has(n));

/* ------------------------------- Dates ------------------------------- */

/** Days each leg moved from the dates asked, read from the plan's legs. Falls back to `dateShift` when a leg is missing. */
export function shiftOf(plan: FlightPlan, asked: { out: string | null; ret: string | null }): { out: number; ret: number } {
  const out = plan.legs.find((l) => l.direction === "outbound")?.isoDate;
  const back = plan.legs.find((l) => l.direction === "return")?.isoDate;
  return {
    out: out && asked.out ? daysBetween(asked.out, out) : (plan.dateShift?.out ?? 0),
    ret: back && asked.ret ? daysBetween(asked.ret, back) : (plan.dateShift?.ret ?? 0),
  };
}

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];
const daysWords = (n: number) => (Math.abs(n) === 1 ? "a day" : `${SMALL[Math.abs(n)] ?? Math.abs(n)} days`);

/** A plan's date shift in words the writer may repeat: "leaves three days earlier, home two days later". */
export function shiftWords(shift: { out: number; ret: number }, roundTrip: boolean): string {
  if (!shift.out && (!roundTrip || !shift.ret)) return "on the dates asked";
  const leg = (n: number, verb: string) => (n ? `${verb} ${daysWords(n)} ${n < 0 ? "earlier" : "later"}` : `${verb} on the day asked`);
  return roundTrip ? `${leg(shift.out, "leaves")}, ${leg(shift.ret, "home")}` : leg(shift.out, "leaves");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DATE_MENTION = new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}|\b\d{4}-(\d{2})-(\d{2})\b`, "gi");
/** An ISO date's "MM-DD", the form `datesIn` reports. */
const monthDay = (iso: string) => iso.slice(5, 10);
function datesIn(s: string): { md: string; at: number }[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [...s.matchAll(DATE_MENTION)].map((m) => {
    const md = m[1] ? `${pad(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1)}-${pad(Number(m[2]))}` : m[4] ? `${pad(MONTHS.indexOf(m[4].slice(0, 3).toLowerCase()) + 1)}-${pad(Number(m[3]))}` : `${m[5]}-${m[6]}`;
    return { md, at: m.index ?? 0 };
  });
}

const COUNT = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|a couple of|a few|few|several)`;
const SHIFTED = new RegExp(String.raw`\b${COUNT}\s+(days?|weeks?|nights?)\s+(earlier|later|sooner|before|after)\b`, "i");
const DIRECTION = /\b(earlier|later|sooner)\b/i;
const OUT_WORD = /\b(depart\w*|leav\w*|outbound|out|set(?:s|ting)? off|go(?:es|ing)?|fl(?:y|ies|ying) out)\b/i;
const BACK_WORD = /\b(return\w*|back|home|inbound|homeward)\b/i;
const BOTH_WORD = /\b(dates|each way|both ways|both legs|either way)\b/i;
const KEEP_WORD = /\b(keeps?|keeping|kept|same|original|unchanged)\b/i;

type Claim = { leg: "out" | "ret" | "both" | "any"; dir: -1 | 0 | 1; days: number | null };

/**
 * Date-shift claims in a clause, by leg: "depart three days later", "keep the outbound date". Only clauses about days or dates
 * count, so "lands an hour earlier" claims nothing.
 */
function dayClaims(chunk: string): Claim[] {
  const daysOf = (count: string, unit: string): number | null => {
    const c = count.toLowerCase();
    const n = /^\d+$/.test(c) ? Number(c) : c === "a" || c === "an" ? 1 : SMALL.indexOf(c) > 0 ? SMALL.indexOf(c) : null;
    return n == null ? null : /^week/i.test(unit) ? n * 7 : n;
  };
  const aboutDays = SHIFTED.test(chunk) || /\bdates?\b/i.test(chunk) || datesIn(chunk).length > 0;
  if (!aboutDays) return [];
  const claims: Claim[] = [];
  for (const part of chunk.split(/\s+(?:and|or|but|then|while|plus)\s+/i)) {
    const out = OUT_WORD.test(part);
    const back = BACK_WORD.test(part);
    const leg: Claim["leg"] = out && back ? "both" : out ? "out" : back ? "ret" : BOTH_WORD.test(part) ? "both" : "any";
    const shifted = part.match(SHIFTED);
    const way = shifted?.[3] ?? part.match(DIRECTION)?.[1];
    if (way && !/\b(earlier|later|sooner)\s+(in|on|that|the same)\s+(the\s+)?(day|morning|afternoon|evening|night)\b/i.test(part)) {
      claims.push({ leg, dir: /^(earlier|sooner|before)$/i.test(way) ? -1 : 1, days: shifted ? daysOf(shifted[1], shifted[2]) : null });
    } else if (KEEP_WORD.test(part) && leg !== "any") claims.push({ leg, dir: 0, days: null });
    else if (/\byour\s+(own\s+|exact\s+)?dates\b/i.test(part)) claims.push({ leg: "both", dir: 0, days: null });
  }
  return claims;
}

const holds = (c: Claim, s: { out: number; ret: number }): boolean => {
  const one = (n: number) => (c.dir === 0 ? n === 0 : Math.sign(n) === c.dir && (c.days == null || Math.abs(n) === c.days));
  return c.leg === "out" ? one(s.out) : c.leg === "ret" ? one(s.ret) : c.leg === "both" ? one(s.out) && one(s.ret) : one(s.out) || one(s.ret);
};

/**
 * Whether a text's date claims are true. A clause's shift claims must all match one plan, each date named must be in the facts,
 * and a date called "your" or "kept" must be one they asked for.
 */
export function datesHold(text: string, opts: { shifts: { out: number; ret: number }[]; dates: Set<string>; asked: Set<string> }): boolean {
  for (const chunk of text.split(/[,;:()—–]|\.\s/)) {
    const claims = dayClaims(chunk);
    if (claims.length && !opts.shifts.some((s) => claims.every((c) => holds(c, s)))) return false;
    for (const d of datesIn(chunk)) {
      if (!opts.dates.has(d.md) && !opts.asked.has(d.md)) return false;
      if (/\b(your|keeps?|keeping|kept|same|original)\b(\s+\S+){0,2}\s*$/i.test(chunk.slice(0, d.at)) && !opts.asked.has(d.md)) return false;
    }
  }
  return true;
}

/**
 * A plan as one line of facts with formatted money. The difference from `cheapest` is computed here so the model doesn't do
 * arithmetic. Times use the traveller's clock, as the cards show them.
 */
export function planFacts(plan: FlightPlan, cheapest?: number, asked?: { out: string | null; ret: string | null }, locale = "en-US"): string {
  const legs = plan.legs
    .map((l) => `${l.direction === "return" ? "back" : "out"} ${l.date} ${flightClock(l.departTime, locale)}–${flightClock(l.arriveTime, locale)} ${l.from}→${l.to} ${l.airline} ${l.stops === 0 ? "nonstop" : `${l.stops} stop${l.stops > 1 ? "s" : ""}${l.stopNote ? ` (${l.stopNote})` : ""}`} ${l.duration}`)
    .join("; ");
  const money_ = money(plan.price, plan.currency);
  const against = cheapest == null ? "" : plan.price === cheapest ? " (the cheapest plan)" : ` (${money(plan.price - cheapest, plan.currency)} more than the cheapest plan)`;
  const shift = asked ? shiftOf(plan, asked) : (plan.dateShift ?? { out: 0, ret: 0 });
  return `${plan.id} "${plan.label}": ${money_}${against}${plan.travellers && plan.travellers > 1 ? ` total for ${plan.travellers}` : ""}; ${plan.roundTripFare ? `one round-trip ticket, back ${plan.returnDate ?? "?"}` : plan.booking?.returnUrl ? "two separate tickets" : "one ticket"}; ${legs}; dates: ${shiftWords(shift, Boolean(asked?.ret ?? plan.legs.some((l) => l.direction === "return")))}${plan.scores ? `; hassle ${plan.scores.hassle}/100, hours ${plan.scores.hours}/100` : ""}`;
}

/** The write-up's user prompt: trip facts, formatted prices and date shifts in code's words. */
export function voicePrompt(v: VoiceFacts): string {
  const asked = { out: v.req.departDate, ret: v.req.returnDate };
  const cheapest = Math.min(...v.plans.map((q) => q.price));
  const own = asked.out ? `Their own dates: out ${shortDate(asked.out, v.req.locale)}${asked.ret ? `, back ${shortDate(asked.ret, v.req.locale)}` : ", one way"}.\n` : "";
  return (
    `${v.facts}\n\nWhat was searched: ${v.viewLine}\n${v.verdictLine}\n${own}\nThe plans, as facts (use these prices exactly as written):\n` +
    v.plans.map((p) => planFacts(p, cheapest, asked, v.req.locale)).join("\n") +
    `\n\nTraveller's own words — dates: "${v.req.flexibilityNote || "—"}"; notes: "${v.req.notes || "—"}".`
  );
}

/**
 * Checks the write-up reply. Numbers must come from the facts (minus the money-format example) and amounts from code. Card lines
 * must not mention money, and date claims must hold. A part that fails is dropped and code's own line stands.
 */
export function guardWriteUp(reply: { analysis: string; lines: { id: string; line: string }[] }, v: VoiceFacts, user = voicePrompt(v)): { analysis: string | null; lines: Record<string, string>; failure?: string } {
  const facts = user.split(money(1234, v.req.currency, v.req.locale)).join(" ");
  const allowed = numbersIn(facts);
  const clean = (s: string) => [...numbersIn(s)].every((n) => allowed.has(n));
  const amounts = planAmounts(v.plans);
  for (const d of numbersIn(v.verdictLine)) amounts.add(d);
  const supplied = new Set([...planAmounts(v.plans), ...moneyIn(facts)]);
  const asked = { out: v.req.departDate, ret: v.req.returnDate };
  const askedDays = new Set([asked.out, asked.ret].filter((d): d is string => Boolean(d)).map(monthDay));
  const shifts = v.plans.map((p) => shiftOf(p, asked));
  const daysOf = (p: FlightPlan, i: number) =>
    new Set([...p.legs.flatMap((l) => (l.isoDate ? [l.isoDate] : [])), ...(asked.out ? [shiftDay(asked.out, shifts[i].out)] : []), ...(asked.ret ? [shiftDay(asked.ret, shifts[i].ret)] : [])].map(monthDay));
  const everyDay = new Set([...datesIn(facts).map((d) => d.md), ...v.plans.flatMap((p, i) => [...daysOf(p, i)])]);
  const lines: Record<string, string> = {};
  for (const l of reply.lines) {
    const i = v.plans.findIndex((p) => p.id === l.id);
    if (i >= 0 && clean(l.line) && !mentionsMoney(l.line, amounts) && datesHold(l.line, { shifts: [shifts[i]], dates: daysOf(v.plans[i], i), asked: askedDays })) lines[l.id] = undash(l.line);
  }
  const a = reply.analysis;
  const why = !clean(a)
    ? "used a number it was not given"
    : !moneyAllowed(a, supplied)
      ? "named an amount code did not work out"
      : !datesHold(a, { shifts, dates: everyDay, asked: askedDays })
        ? "said something about the dates that is not so"
        : null;
  return { analysis: why ? null : firstSentence(undash(a)), lines, ...(why ? { failure: `the write-up ${why}: "${a.slice(0, 140)}"` } : {}) };
}

export async function narrate(model: ModelOption, v: VoiceFacts, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<VoiceOutcome> {
  const t0 = Date.now();
  const user = voicePrompt(v);
  const r = await callModelStructured(model, VoiceSchema, "voice", VOICE_SYSTEM, user, {
    effort: "low",
    timeoutMs: opts.timeoutMs ?? 9_000,
    maxTokens: 1_500,
    signal: opts.signal,
  });
  if (!r.parsed) return { analysis: null, lines: {}, usage: r.usage, failure: r.failure, ms: Date.now() - t0 };
  return { ...guardWriteUp(r.parsed, v, user), usage: r.usage, ms: Date.now() - t0 };
}

/* ------------------------------ Follow-ups ------------------------------ */

export const AnswerSchema = z.object({
  answer: z.string().describe("1–2 short, plain sentences for the traveler, under 40 words; a number only where no card shows it"),
  picks: z
    .array(
      z.object({
        label: z.string().describe("Short card label, ≤18 chars"),
        summary: z.string().describe("One short line (≤15 words) on what this plan is or buys, shown on the card; never a price, which the card already shows"),
        outbound_id: z.number().int(),
        return_id: z.number().int().nullable(),
      })
    )
    .max(3)
    .describe("Plans this answer turned up, by id; empty when the answer is prose only"),
  search: z
    .object({
      note: z.string().describe("One plain line shown while the queries run: what you're checking"),
      queries: z.array(PlannedQuerySchema).max(8).describe("Shopping queries to run; empty when only a grid or an explore is wanted"),
      grid: z
        .object({
          from: z.string().describe("IATA origin"),
          to: z.array(z.string()).min(1).max(2).describe("One or two IATA destinations; two when they said 'or'"),
          out_from: z.string().describe("YYYY-MM-DD, earliest outbound"),
          out_to: z.string().describe("YYYY-MM-DD, latest outbound; at most thirteen days after out_from"),
          ret_from: z.string().nullable().describe("YYYY-MM-DD, earliest return; null for one-way"),
          ret_to: z.string().nullable().describe("YYYY-MM-DD, latest return; null for one-way"),
          mix: z.boolean().describe("True when out to one listed airport and back from the other is fine"),
        })
        .nullable()
        .describe("The chat's date grid, rebuilt for these windows: every pair of days priced as the cheapest way to fly it. For 'what about January', 'show me the whole month', 'a grid for those dates', 'add a few days'. null otherwise."),
      explore: z
        .object({
          origin: z.string().describe("IATA origin"),
          out_date: z.string().nullable().describe("YYYY-MM-DD, or null for 'a week, any time in the next six months'"),
          ret_date: z.string().nullable().describe("YYYY-MM-DD, or null"),
          hint: z.string().describe("Their words for what they want: 'somewhere warm', 'international', 'a beach'"),
        })
        .nullable()
        .describe("A list of places priced from an origin, for 'where else could I go', 'somewhere warm instead', 'other cities from Chicago'. null otherwise."),
    })
    .nullable()
    .describe("Things to run BEFORE answering, when the rows can't answer the question: shopping queries, a date grid, an explore list. null to answer from what's here."),
});

export type Answer = z.infer<typeof AnswerSchema>;

/**
 * Amounts a follow-up answer may name, as bare digits: row and card prices, their per-seat shares, the difference between any
 * two cards, and any `extra` amounts code priced.
 */
export function answerAmounts(o: { rows: { price: number | null }[]; plans: { price: number }[]; seats: number; extra?: (number | null | undefined)[] }): Set<string> {
  const out = new Set<string>();
  const add = (n: number | null | undefined) => {
    if (n != null && Number.isFinite(n) && n > 0) out.add(String(Math.round(n)));
  };
  const seats = Math.max(1, o.seats);
  for (const x of [...o.rows, ...o.plans]) if (x.price != null) [x.price, x.price / seats].forEach(add);
  for (const a of o.plans) for (const b of o.plans) add(Math.abs(a.price - b.price));
  (o.extra ?? []).forEach(add);
  return out;
}

/** Fallback answer when the model named an amount code didn't work out: points to what the page shows, without numbers. */
export function plainAnswer(o: { cards: number; grid: boolean; places: boolean }): string | null {
  if (o.cards) return o.cards > 1 ? "The cards below have the prices." : "The card below has the price.";
  if (o.grid) return "The date grid now has those dates. Open it to see every pair of days.";
  if (o.places) return "The places are below, with their prices.";
  return null;
}

export type AnswerPayload = {
  req: SearchRequest;
  today: string;
  question: string;
  rows: ModelRow[];
  plansShown: { label: string; price: number; summary?: string }[];
  handoff: string;
  history: { question: string; answer: string }[];
  canSearch: boolean;
  searched?: string;
  /** The grid or explore results in code's words, for the second pass. */
  viewsBuilt?: string;
  /** Asked from the date grid's own box. */
  fromGrid?: boolean;
  facts: string;
  timeoutMs: number;
};

export async function answerQuestion(model: ModelOption, payload: AnswerPayload): Promise<{ result: Answer | null; failure?: string; usage: ModelUsage }> {
  const history = payload.history.length
    ? `Earlier in this conversation (oldest first):\n` + payload.history.map((h) => `They asked: "${h.question}"\nYou said: "${h.answer}"`).join("\n\n") + `\n\n`
    : "";
  const user =
    `Today is ${payload.today}.\n\n${payload.facts}\n\nIntake:\n${JSON.stringify(payload.req, null, 2)}\n\n${payload.handoff}\n` +
    `Plans currently shown to the traveler:\n${JSON.stringify(payload.plansShown)}\n\n` +
    history +
    `Every itinerary held (fare = one-way | round-trip; a round-trip row's price covers the whole trip):\n${JSON.stringify(payload.rows)}\n\n` +
    (payload.viewsBuilt ? `${payload.viewsBuilt}\n\n` : "") +
    (payload.searched
      ? `You already searched for this question: ${payload.searched}\nAnswer now from the rows above and leave search null.\n\n`
      : payload.canSearch
        ? ""
        : `Searching is not available for this question — answer from the rows and leave search null.\n\n`) +
    (payload.fromGrid ? `They asked this from the date grid: when it is about other dates, return search.grid for them.\n\n` : "") +
    `Their question now: "${payload.question}"`;
  const r = await callModelStructured(model, AnswerSchema, "followup_answer", ANSWER_SYSTEM, user, {
    effort: "low",
    timeoutMs: payload.timeoutMs,
    maxTokens: 4_000,
  });
  if (r.parsed) return { result: r.parsed, usage: r.usage };
  // Salvage a reply that failed to parse: try the JSON object in it, else use its prose.
  const raw = (r.rawText ?? "").trim();
  if (raw) {
    const brace = raw.indexOf("{");
    if (brace >= 0) {
      try {
        return { result: AnswerSchema.parse(JSON.parse(raw.slice(brace))), usage: r.usage };
      } catch {
        /* fall through to the prose */
      }
    }
    const prose = (brace > 0 ? raw.slice(0, brace) : raw).trim();
    if (prose) return { result: { answer: prose.slice(0, 600), picks: [], search: null }, usage: r.usage };
  }
  return { result: null, failure: r.failure, usage: r.usage };
}
