import type { CabinClass, IntakeTurn, SearchRequest } from "@/lib/types";
import { HASSLE_OPTIONS, QUESTION_BY_KEY, SET_FIELDS, type SetField } from "@/lib/intake/questions";
import { dayLabel } from "./dates";

/**
 * The conversation's state, which becomes a `SearchRequest`. The planner reads the words: `brief` and each question with its answer
 * (`turns`). Fields listed in `set` were set by a control and are taken as given; the rest are defaults the words can override.
 */
export type Draft = {
  /** The first box, as typed. */
  brief: string;
  /** Questions asked after the brief, in order, with answers as shown in their bubbles. */
  turns: IntakeTurn[];
  /** The fields an answer set outright. */
  set: SetField[];
  from: string;
  to: string;
  /** ISO days, or "" when not chosen. */
  depart: string;
  ret: string;
  oneWay: boolean;
  flexible: boolean;
  /** How the dates can move, in the traveller's words: "a few days either side", "back by the 3rd". */
  flexNote: string;
  /** 0 = nonstop only … 3 = anything for a deal. */
  hassle: number;
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
  cabin: CabinClass;
  carryOn: number;
  checked: number;
  notes: string;
};

/** Defaults before anything is said: one adult, economy, no bags, one stop. The words can override all of it. */
export const EMPTY_DRAFT: Draft = {
  brief: "",
  turns: [],
  set: [],
  from: "",
  to: "",
  depart: "",
  ret: "",
  oneWay: false,
  flexible: false,
  flexNote: "",
  hassle: 1,
  adults: 1,
  children: 0,
  infantsInSeat: 0,
  infantsOnLap: 0,
  cabin: "economy",
  carryOn: 0,
  checked: 0,
  notes: "",
};

export const hassleTitle = (v: number) => HASSLE_OPTIONS.find((o) => o.value === String(v))?.title ?? HASSLE_OPTIONS[1].title;

/** Party label for the chip: "1 adult", "2 adults", or the total when there are children or infants. */
export function whoLabel(d: Pick<Draft, "adults" | "children" | "infantsInSeat" | "infantsOnLap">): string {
  const total = d.adults + d.children + d.infantsInSeat + d.infantsOnLap;
  if (total === d.adults) return `${d.adults} adult${d.adults === 1 ? "" : "s"}`;
  return `${total} travelers`;
}

/**
 * Rebuilds a draft from a stored request for editing (an edit always creates a new search). Shared requests carry no words
 * (`publicRecord`), so the owning browser merges its own back in first (lib/history.ts) and others start from `understood`.
 */
export function draftFromRequest(req: SearchRequest, understood?: string | null): Draft {
  const fields = {
    from: req.from,
    to: req.to,
    depart: req.departDate ?? "",
    ret: req.returnDate ?? "",
    oneWay: Boolean(req.departDate) && req.returnDate == null,
    flexible: req.datesFlexible,
    flexNote: req.flexibilityNote,
    hassle: req.hassle,
    adults: req.passengers.adults,
    children: req.passengers.children,
    infantsInSeat: req.passengers.infantsInSeat,
    infantsOnLap: req.passengers.infantsOnLap,
    cabin: req.cabin,
    carryOn: req.bags.carryOn,
    checked: req.bags.checked,
    notes: req.notes,
  };
  if (req.brief) return { ...fields, brief: req.brief, turns: req.turns ?? [], set: req.set ?? [] };
  if (req.set && understood) return { ...fields, brief: understood, turns: [], set: req.set };
  // No words stored: rebuild turns from the fields, using the current question titles.
  const turns: IntakeTurn[] = [{ key: "origin", q: QUESTION_BY_KEY.origin.title, a: req.from }];
  if (req.departDate)
    turns.push({
      key: "dates",
      q: QUESTION_BY_KEY.dates.title,
      a: req.returnDate ? `${dayLabel(req.departDate, req.locale)} → ${dayLabel(req.returnDate, req.locale)}` : `${dayLabel(req.departDate, req.locale)}, one way`,
    });
  turns.push({ key: "stops", q: QUESTION_BY_KEY.stops.title, a: hassleTitle(req.hassle) });
  if (req.notes.trim()) turns.push({ key: "anything_else", q: QUESTION_BY_KEY.anything_else.title, a: req.notes.trim() });
  return { ...fields, brief: req.to, turns, set: [...SET_FIELDS] };
}

/** The request the conversation sends: the words, the answers, and the fields a control set. */
export function requestFromDraft(d: Draft, currency: string, locale: string): SearchRequest {
  const set = new Set(d.set);
  const has = (f: SetField) => set.has(f);
  return {
    from: has("from") ? d.from.trim() : "",
    to: has("to") ? d.to.trim() : "",
    departDate: has("dates") ? d.depart || null : null,
    returnDate: has("dates") && !d.oneWay ? d.ret || null : null,
    datesFlexible: d.flexible,
    flexibilityNote: d.flexible ? d.flexNote.trim() : "",
    bags: { carryOn: d.carryOn, checked: d.checked },
    cabin: d.cabin,
    passengers: { adults: d.adults, children: d.children, infantsInSeat: d.infantsInSeat, infantsOnLap: d.infantsOnLap },
    currency,
    locale,
    hassle: d.hassle,
    // Only the notes as set. The planner reads the answers from `turns`.
    notes: d.notes.trim().slice(0, 600),
    brief: d.brief.trim(),
    turns: d.turns,
    set: [...set],
  };
}
