import type { ChoiceAnswer, JevClient, JevQuestion, NoulAnswer } from "@/lib/search/jev";
import { BRIEF_QUESTION, MAX_QUESTIONS, QUESTIONS, isQuestionKey, type QuestionKey } from "./questions";
import { destinationSaid, originSaid, partyOpen, partySaid, whenSaid } from "./words";

/**
 * Picks the next intake question. Jev chooses from the bank (questions.ts) or starts the search, and code enforces the rules: no
 * repeats, a missing place or date and the hassle question before searching, and "anything else?" last unless the first words said
 * everything. Without Jev the order is fixed and skips what the words already say (words.ts).
 */

export type NextTurn = { key: string; q: string; a: string };
export type NextInput = { brief: string; turns: NextTurn[] };
export type NextOutcome = {
  next: QuestionKey | "search";
  source: "jev" | "code";
  ms: number;
  failure?: string;
  /** Jev's 0-1 confidence that origin, destination, timing and stops were said, and that the first message covered everything. */
  knows?: { origin: number; destination: number; when: number; hassle: number; everything: number };
};

const SEARCH = "search";
/** Code asks this last, so it isn't offered to Jev. */
const LAST: QuestionKey = "anything_else";
/** How much hassle a cheaper fare is worth. Asked before LAST unless already answered. */
const HASSLE: QuestionKey = "stops";
/** Words about stops, checked when there is no Jev. */
const STOP_WORDS = /\b(non-?stops?|direct|stop-?overs?|stops?|layovers?|connections?|connecting|change planes|red-?eyes?|overnights?)\b/i;
/** Everything the traveller has typed, the first words and every answer. */
const wordsOf = (input: NextInput) => [input.brief, ...input.turns.map((t) => t.a)].join("\n");

/** What the chooser is told the search needs, and what it assumes when nothing is said. */
const TASK =
  "A traveller is describing a trip to an AI flight search. Before it searches it may ask a few short questions, one at a time: only what it still needs, never what they already said.";
const NEEDS = {
  essential: ["where the trip starts", "where it goes — one place, several places, or an open idea like 'somewhere warm' or 'anywhere'"],
  useful: ["when — dates, a month, a season, or an event to fit around", "who is going"],
  assumed_when_not_said: "leaving in about two weeks for about a week, round trip, one adult, economy, one stop is fine, no checked bags",
};

export function jevQuestions(asked: Set<string>, left: number): Record<string, JevQuestion> {
  const criteria: Record<string, string> = {
    [SEARCH]:
      left <= 0
        ? "Start the search now: no questions are left."
        : "Start the search now. Right when where from and where to are known (even vaguely) and the rest can take a sensible default, or when any further question would not change the flights found.",
  };
  for (const q of QUESTIONS) if (!asked.has(q.key) && q.key !== LAST) criteria[q.key] = `Ask “${q.title}” — ${q.when}`;
  return {
    next: {
      type: "choice",
      instructions:
        "Choose the ONE question the search should ask next, or start the search. Read every word of the conversation, including what they said in passing: never ask about something they have already answered in any words — if they wrote 'two of us, business class', do not ask who is going or which cabin; if they gave a month or a festival, do not ask when. Ask the essentials first (where to, where from, when). Fewer questions is better: when an answer would not change the flights found, start the search.",
      criteria,
    },
    has_origin: {
      type: "noul",
      instructions: "Has the traveller said, anywhere in the conversation, where the trip starts — a city, an airport, or the place they live and would leave from?",
      criteria: { true: "a starting place is named or unmistakable", false: "nothing says where they would fly from" },
    },
    has_destination: {
      type: "noul",
      instructions: "Has the traveller said where they want to go, even vaguely? A city, several places, a region, 'anywhere', 'somewhere warm' or 'a beach' all count.",
      criteria: { true: "they said where, however loosely", false: "nothing at all about where they want to go" },
    },
    has_hassle: {
      type: "noul",
      instructions: "Has the traveller said, anywhere in the conversation, how they feel about stops, layovers, connections or odd hours — 'nonstop only', 'one stop is fine', 'don't mind layovers if it's cheaper', 'no red-eyes'?",
      criteria: { true: "they said something about stops, layovers or hassle", false: "nothing about stops, layovers or hassle" },
    },
    said_everything: {
      type: "noul",
      instructions: "Did the traveller's FIRST message alone say where from, where to, when, who is going and how they feel about stops — everything, with nothing left to ask?",
      criteria: { true: "the first message alone covers all of it", false: "something is missing from the first message" },
    },
    has_when: {
      type: "noul",
      instructions: "Has the traveller said anything about when — dates, a month, a season, a holiday, 'next weekend', or an event the trip fits around?",
      criteria: { true: "something about when is said", false: "nothing at all about when" },
    },
  };
}

export function jevState(input: NextInput, asked: number) {
  return {
    task: TASK,
    what_the_search_needs: NEEDS,
    questions_asked_so_far: asked,
    questions_left: Math.max(0, MAX_QUESTIONS - asked),
    conversation: [{ asked: BRIEF_QUESTION, answered: input.brief }, ...input.turns.map((t) => ({ asked: t.q, answered: t.a }))],
  };
}

export async function nextQuestion(input: NextInput, jev: JevClient | null, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<NextOutcome> {
  const t0 = Date.now();
  const asked = new Set(input.turns.map((t) => t.key));
  const count = input.turns.length;
  if (asked.has(LAST)) return { next: SEARCH, source: "code", ms: 0 };
  const words = wordsOf(input);
  const fallback = (failure?: string): NextOutcome => ({ next: codeNext(asked, words), source: "code", ms: Date.now() - t0, ...(failure ? { failure } : {}) });
  if (!asked.has("who") && partyOpen(words)) return { next: "who", source: "code", ms: 0 };
  if (!jev) return fallback();

  let answers;
  try {
    ({ answers } = await jev(jevState(input, count), jevQuestions(asked, MAX_QUESTIONS - count), { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 4_000 }));
  } catch (e) {
    return fallback(`Jev: ${(e as Error).message}`);
  }
  const noul = (k: string, dflt: number) => (answers[k]?.type === "noul" ? (answers[k] as NoulAnswer).noul : dflt);
  const knows = {
    origin: noul("has_origin", 1),
    destination: noul("has_destination", 1),
    when: noul("has_when", 1),
    hassle: noul("has_hassle", 0),
    everything: noul("said_everything", 0),
  };
  const c = answers.next?.type === "choice" ? (answers.next as ChoiceAnswer) : null;
  if (!c) return { ...fallback("Jev returned no choice"), knows };

  // Jev's choice if it is still open, otherwise the likeliest open option.
  const ranked = Object.entries(c.probabilities ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const open = (k: string) => k === SEARCH || (isQuestionKey(k) && !asked.has(k));
  // With no questions left, search. The checks below can still ask what is required.
  let next = count >= MAX_QUESTIONS ? SEARCH : ([c.choice, ...ranked].find(open) as QuestionKey | "search" | undefined);
  if (!next) return { ...fallback("Jev chose nothing that was still open"), knows };

  if (next === SEARCH) {
    // A search with no origin cannot run, whatever else is known.
    if (knows.origin < 0.4 && !asked.has("origin")) next = "origin";
    else if (knows.destination < 0.4 && !asked.has("destination")) next = "destination";
    else if (knows.when < 0.3 && !asked.has("dates") && !asked.has("month")) next = "dates";
    // Then the hassle question, which the picks depend on.
    else if (knows.hassle < 0.5 && !asked.has(HASSLE)) next = HASSLE;
    // "Anything else?" last, unless the first words said everything and nothing has been asked.
    else if (count > 0 || knows.everything < 0.5) next = LAST;
  }
  return { next, source: "jev", ms: Date.now() - t0, knows };
}

/* ------------------------------- Without Jev ------------------------------ */

/**
 * The fixed order without Jev: destination, origin, dates, who, stops, then "anything else?". Skips a question already asked or
 * answered in `words` (everything typed so far).
 */
export function codeNext(asked: Set<string>, words = ""): QuestionKey | "search" {
  const said: Partial<Record<QuestionKey, () => boolean>> = {
    destination: () => destinationSaid(words),
    origin: () => originSaid(words),
    dates: () => asked.has("month") || whenSaid(words),
    who: () => partySaid(words),
    [HASSLE]: () => STOP_WORDS.test(words),
  };
  for (const k of ["destination", "origin", "dates", "who", HASSLE, LAST] as QuestionKey[]) if (!asked.has(k) && !said[k]?.()) return k;
  return SEARCH;
}
