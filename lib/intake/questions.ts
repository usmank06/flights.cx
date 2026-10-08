import type { CabinClass } from "@/lib/types";

/**
 * The intake question bank, which Jev picks from (next.ts). A control can set a request field outright, overriding the words, but
 * every answer also reaches the planner as words. Shared by browser and server, so it imports neither.
 */

export type QuestionKey =
  | "destination"
  | "origin"
  | "dates"
  | "trip_type"
  | "flexibility"
  | "trip_length"
  | "month"
  | "who"
  | "cabin"
  | "bags"
  | "stops"
  | "separate_tickets"
  | "mix_airports"
  | "times"
  | "airlines"
  | "constraints"
  | "vibe"
  | "region"
  | "anything_else";

/** Request fields a control can set outright. The planner can't override them. */
export type SetField = "from" | "to" | "dates" | "party" | "cabin" | "bags" | "hassle";
export const SET_FIELDS: SetField[] = ["from", "to", "dates", "party", "cabin", "bags", "hassle"];

/** What a tapped answer sets on the draft, beyond its words. */
export type Patch = Partial<{
  oneWay: boolean;
  flexible: boolean;
  flexNote: string;
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
  cabin: CabinClass;
  carryOn: number;
  checked: number;
  hassle: number;
}>;

export type Option = { value: string; title: string; sub?: string; patch?: Patch; sets?: SetField[] };

export type Control =
  | { kind: "place"; side: "from" | "to"; placeholder: string }
  | { kind: "dates" }
  | { kind: "who" }
  | { kind: "choice"; options: Option[] | "months" }
  | { kind: "text"; placeholder: string };

export type Question = {
  key: QuestionKey;
  title: string;
  sub?: string;
  control: Control;
  /** For the chooser: when this question is worth asking. One line, about what is missing. */
  when: string;
};

export const HASSLE_OPTIONS: Option[] = [
  { value: "0", title: "Nonstop only", sub: "At a decent hour", patch: { hassle: 0 }, sets: ["hassle"] },
  { value: "1", title: "One stop is fine", sub: "A short connection, nothing silly", patch: { hassle: 1 }, sets: ["hassle"] },
  { value: "2", title: "Long layovers are OK", sub: "Odd hours too, if it saves real money", patch: { hassle: 2 }, sets: ["hassle"] },
  { value: "3", title: "Anything for a deal", sub: "Separate tickets, overnight connections", patch: { hassle: 3 }, sets: ["hassle"] },
];

export const QUESTIONS: Question[] = [
  {
    key: "destination",
    title: "Where do you want to go?",
    control: { kind: "place", side: "to", placeholder: "Tokyo, Lisbon or Porto…" },
    when: "They have not said where they want to go at all. A region, 'anywhere', 'somewhere warm' or a list of places all count as saying it.",
  },
  {
    key: "origin",
    title: "Where are you flying from?",
    control: { kind: "place", side: "from", placeholder: "A city or an airport" },
    when: "They have not said where the trip starts: no city, airport or home town to leave from.",
  },
  {
    key: "dates",
    title: "When are you going?",
    control: { kind: "dates" },
    when: "They have not said when: no dates, no month, no season and no event to fit around.",
  },
  {
    key: "trip_type",
    title: "Round trip, or one way?",
    control: {
      kind: "choice",
      options: [
        { value: "round", title: "Round trip" },
        { value: "one", title: "One way" },
      ],
    },
    when: "They said when they leave but it is unclear whether they are coming back.",
  },
  {
    key: "flexibility",
    title: "Are your dates flexible?",
    sub: "A day or two either way is often the biggest saving.",
    control: {
      kind: "choice",
      options: [
        { value: "fixed", title: "No, those exact days", patch: { flexible: false, flexNote: "" } },
        { value: "few", title: "A day or two either side", patch: { flexible: true, flexNote: "a day or two either side" } },
        { value: "week", title: "Up to a week", patch: { flexible: true, flexNote: "up to a week either way" } },
        { value: "any", title: "Whenever’s cheapest", patch: { flexible: true, flexNote: "whenever is cheapest" } },
      ],
    },
    when: "They gave dates but did not say whether those dates can move.",
  },
  {
    key: "trip_length",
    title: "How long do you want to be away?",
    control: {
      kind: "choice",
      options: [
        { value: "weekend", title: "A long weekend", sub: "Three or four nights" },
        { value: "week", title: "About a week" },
        { value: "two-weeks", title: "Two weeks or so" },
        { value: "longest", title: "As long as possible", sub: "Within the dates that work" },
      ],
    },
    when: "They gave a rough time or a window to travel in, but not how long the trip should be.",
  },
  {
    key: "month",
    title: "Roughly when?",
    sub: "We’ll find the cheapest days in it.",
    control: { kind: "choice", options: "months" },
    when: "They sound open about timing and have given no dates at all; a rough month is easier to answer than exact days.",
  },
  {
    key: "who",
    title: "Who’s going?",
    control: { kind: "who" },
    when: "They have not said who is travelling or how many people.",
  },
  {
    key: "cabin",
    title: "Which cabin?",
    control: {
      kind: "choice",
      options: [
        { value: "economy", title: "Economy", patch: { cabin: "economy" }, sets: ["cabin"] },
        { value: "premium-economy", title: "Premium economy", sub: "More room, for a bit more", patch: { cabin: "premium-economy" }, sets: ["cabin"] },
        { value: "business", title: "Business", patch: { cabin: "business" }, sets: ["cabin"] },
        { value: "first", title: "First", patch: { cabin: "first" }, sets: ["cabin"] },
      ],
    },
    when: "Only when comfort seems to matter to them — a very long flight, a special occasion, points — and they have not said. Economy is assumed otherwise.",
  },
  {
    key: "bags",
    title: "What are you bringing?",
    sub: "Some fares charge for bags; the prices will include yours.",
    control: {
      kind: "choice",
      options: [
        { value: "none", title: "Just a small bag", sub: "Fits under the seat", patch: { carryOn: 0, checked: 0 }, sets: ["bags"] },
        { value: "carry-on", title: "A carry-on", sub: "In the overhead bin", patch: { carryOn: 1, checked: 0 }, sets: ["bags"] },
        { value: "checked", title: "A checked bag", sub: "And a carry-on", patch: { carryOn: 1, checked: 1 }, sets: ["bags"] },
      ],
    },
    when: "Only when bags could change the price: a long stay, a family, or a budget trip, and they have not said what they are bringing.",
  },
  {
    key: "stops",
    title: "How much hassle is a cheaper fare worth?",
    control: { kind: "choice", options: HASSLE_OPTIONS },
    when: "They have not said how they feel about stops, layovers or odd hours, and the trip is long enough for it to matter.",
  },
  {
    key: "separate_tickets",
    title: "Would you book two separate tickets if it’s cheaper?",
    sub: "One ticket out, another back. If one flight changes, the other won’t change with it.",
    control: {
      kind: "choice",
      options: [
        { value: "yes", title: "Yes, if it saves money" },
        { value: "no", title: "No, one ticket please" },
      ],
    },
    when: "Price clearly matters most and they have not said whether two separate tickets would be acceptable.",
  },
  {
    key: "mix_airports",
    title: "Could you fly into one and home from the other?",
    control: {
      kind: "choice",
      options: [
        { value: "yes", title: "Yes, either way works" },
        { value: "no", title: "No, the same airport both ways" },
      ],
    },
    when: "They named two or more places for the same end of the trip (like 'Lisbon or Porto') and did not say whether mixing them is fine.",
  },
  {
    key: "times",
    title: "Any times you’d rather not fly?",
    control: {
      kind: "choice",
      options: [
        { value: "no-red-eyes", title: "No red-eyes", sub: "Nothing overnight" },
        { value: "mornings", title: "Mornings are best" },
        { value: "evenings", title: "Evenings are best" },
        { value: "any", title: "I don’t mind" },
      ],
    },
    when: "Rarely needed: only when they hinted that the time of day matters (young children, a meeting on arrival) and did not say.",
  },
  {
    key: "airlines",
    title: "Any airlines you like, or want to avoid?",
    control: { kind: "text", placeholder: "Miles with United…" },
    when: "Rarely needed: only when they mentioned an airline, an alliance, miles or points.",
  },
  {
    key: "constraints",
    title: "Is there anything the dates have to fit around?",
    control: { kind: "text", placeholder: "A birthday on the 12th…" },
    when: "Their timing depends on something they hinted at but did not pin down: work, school, an event, a deadline.",
  },
  {
    key: "vibe",
    title: "What kind of place are you after?",
    control: {
      kind: "choice",
      options: [
        { value: "beach", title: "Beach and sun" },
        { value: "city", title: "A city break" },
        { value: "mountains", title: "Mountains or snow" },
        { value: "surprise", title: "Surprise me", sub: "Wherever is cheapest" },
      ],
    },
    when: "The destination is open or vague ('anywhere', 'somewhere') and they have not said what kind of place they want.",
  },
  {
    key: "region",
    title: "How far are you happy to go?",
    control: {
      kind: "choice",
      options: [
        { value: "near", title: "Somewhere close", sub: "A short flight" },
        { value: "country", title: "Anywhere in my country" },
        { value: "abroad", title: "Abroad" },
        { value: "world", title: "Anywhere in the world" },
      ],
    },
    when: "The destination is open and they have not said how far they would go or whether abroad is fine.",
  },
  {
    key: "anything_else",
    title: "Anything else we should know?",
    sub: "A must-have or a deal-breaker.",
    control: { kind: "text", placeholder: "Either airport’s fine…" },
    when: "Never the chooser’s: code always asks it last, unless the first words said everything (next.ts).",
  },
];

export const QUESTION_BY_KEY: Record<QuestionKey, Question> = Object.fromEntries(QUESTIONS.map((q) => [q.key, q])) as Record<QuestionKey, Question>;
export const isQuestionKey = (v: unknown): v is QuestionKey => typeof v === "string" && v in QUESTION_BY_KEY;

/** The first box's prompt. It is not one of the questions. */
export const BRIEF_QUESTION = "Where to next?";

/** The most questions Jev chooses. Code may still ask a missing place or date, the hassle and the price, then "anything else?". */
export const MAX_QUESTIONS = 6;

/** The most answers a conversation can hold: Jev's questions plus the six that code may add after them. */
export const MAX_TURNS = MAX_QUESTIONS + 6;

/** Length limits for the first box and each answer, applied by the inputs and the server (coerceSearchRequest). */
export const BRIEF_MAX = 1_000;
export const ANSWER_MAX = 500;

/** The answer to a skipped question, as the chooser and the planner read it. */
export const SKIPPED = "Skipped — use a sensible default";

/** The next six months as answers, from the current month, in the traveller's language. */
export function monthOptions(today: Date, locale = "en-US"): Option[] {
  const out: Option[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + i, 15));
    const name = d.toLocaleDateString(locale, { month: "long", timeZone: "UTC", calendar: "gregory" });
    const year = d.getUTCFullYear() !== today.getUTCFullYear() ? ` ${d.getUTCFullYear()}` : "";
    out.push({ value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, title: `${name}${year}` });
  }
  out.push({ value: "unsure", title: "Not sure yet", sub: "Whenever is cheapest" });
  return out;
}
