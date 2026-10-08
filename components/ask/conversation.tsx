"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, RotateCcw } from "lucide-react";
import { remember, rememberWords, SEARCHES_KEY, useHasSearched } from "@/lib/history";
import { codeNext } from "@/lib/intake/next";
import { contradicted, oneWayIn } from "@/lib/intake/words";
import { BRIEF_QUESTION, QUESTION_BY_KEY, SKIPPED, isQuestionKey, monthOptions, type Option, type QuestionKey, type SetField } from "@/lib/intake/questions";
import { Button, cx, Spinner } from "@/components/ui/primitives";
import { useBrowserLocale } from "@/components/ui/use-locale";
import { useMedia } from "@/components/ui/use-media";
import { usePresence } from "@/components/ui/presence";
import { useCurrency } from "@/components/site/currency";
import { Island, IslandPart } from "@/components/site/island";
import { RecentPills, useRecentSearches } from "@/components/history/recent-searches";
import { recaptchaHeaders, startSearch } from "@/components/search/search-client";
import { EMPTY_DRAFT, requestFromDraft, type Draft } from "@/components/search/draft";
import { BriefComposer, ChoiceAnswer, Composer, DatesAnswer, PlaceAnswer, TextAnswer, WhenAnswer, WhoAnswer } from "./answers";
import { Answered, Ask } from "./turns";
import { datesAnswer, noteForDates, noteForDestination, noteForOrigin, noteForWho, placeShort, whoAnswer } from "./replies";
import { shownError } from "@/components/ui/errors";

/**
 * The search as a conversation: the trip in free text, then one question at a time until the intake model says the search can start.
 * Given a draft, it edits an existing search. Searching again always creates a new search.
 */
type Phase = "brief" | "thinking" | "asking" | "review" | "starting" | "failed";

/** Open-destination quick picks under the first box and the destination question. The planner reads them as ordinary text. */
const OPEN_QUICK = [
  { key: "anywhere", label: "Anywhere", value: "Anywhere" },
  { key: "warm", label: "Somewhere warm", value: "Somewhere warm" },
];

/** The brief's first sentence on one line, truncated for the header capsule. */
function briefShort(text: string): string {
  const first = text.replace(/\s*\n\s*/g, " ").split(/[.!?]/)[0].trim();
  return first.length > 34 ? `${first.slice(0, 32).replace(/\s+\S*$/, "").replace(/[\s,;:(&/·—–-]+$/, "")}…` : first;
}

/** The note under an answer saying how the search will use it, for the questions where code can tell. */
function noteFor(key: string, answer: string, draft: Draft): string | undefined {
  if (answer === SKIPPED) return undefined;
  switch (key) {
    case "destination":
      return noteForDestination(answer);
    case "origin":
      return noteForOrigin(answer);
    case "dates":
      return draft.set.includes("dates") ? noteForDates(draft) : undefined;
    case "who":
      return noteForWho(draft);
    default:
      return undefined;
  }
}

/** An answer's bubble text, with a skip shown as the tapped button's label. Saved searches can hold a skip on any question. */
function shownAnswer(key: string, a: string): string {
  if (a !== SKIPPED) return a;
  return isQuestionKey(key) && QUESTION_BY_KEY[key].control.kind !== "text" ? "No preference" : "Nothing to add";
}

/** The answer quoted on a Keep button, truncated without a trailing separator. */
const keepLabel = (a: string, max = 40) => (a.length > max ? `${a.slice(0, max - 2).replace(/[\s,;:(&/·—–→-]+$/, "")}…` : a);

/** Delay before the typing bubble shows, so a fast reply doesn't flash it. */
const TYPING_AFTER_MS = 250;

/** Height in px of the recent trips under the landing box on a laptop: a header line plus a row per trip. */
const tripsLift = (rows: number) => (rows ? 54 + 48 * rows : 0);

// Before first paint, sets --landing-gutter to the scrollbar width (unset for overlay scrollbars). The landing has no scrollbar, so
// globals.css pads the header and corners by this to keep them where other pages have them.
export const GUTTER_PROBE =`try{var d=document.createElement("div");d.style.cssText="position:absolute;top:-200px;width:100px;height:100px;overflow:scroll";document.documentElement.appendChild(d);var w=d.offsetWidth-d.clientWidth;d.remove();if(w>0){var g=document.createElement("style");g.textContent=":root{--landing-gutter:"+w+"px}";document.head.appendChild(g)}}catch(e){}`;
// Before first paint, lifts the column for two rows of trips if this browser has saved searches, so it doesn't move on hydration.
const LIFT_FOR_TRIPS =`try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(SEARCHES_KEY)})||"[]");if(Array.isArray(s)&&s.length){var e=document.createElement("style");e.textContent=":root{--trips-guess:${tripsLift(2)}px}";document.head.appendChild(e)}}catch(e){}`;

/** Set once the app has hydrated. The first-paint scripts render only in the server-rendered page. */
let hydrated = false;

/** sessionStorage key for the home page conversation, so a reload or Back/Forward restores it. */
const SAVED_KEY = "flights.conversation.v1";

/** Fades out a static, inert copy of `el` in its place so whatever replaces it crossfades in. Removed when the fade ends. */
function ghost(el: HTMLElement | null, ms = 320) {
  const main = el?.closest("main");
  if (!el || !main?.parentElement || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const a of ["id", "data-quiet", "data-landing"]) n.removeAttribute(a);
    n.style.animation = "none";
  }
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  Object.assign(copy.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", pointerEvents: "none" });
  main.parentElement.insertBefore(copy, main.nextSibling);
  const gone = () => copy.remove();
  copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-out", fill: "forwards" }).finished.then(gone, gone);
}

/** The draft field each question sets, cleared along with the answer when an edited brief contradicts it. */
const SETS_BY_KEY: Partial<Record<QuestionKey, SetField>> = { dates: "dates", origin: "from", destination: "to" };

/** Whether reCAPTCHA is active (same test as recaptchaToken() in search-client.ts), and so whether its notice is required. */
const RECAPTCHA_SHOWN = (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_RECAPTCHA_LOCAL === "1") && Boolean(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY);

export function Conversation({
  initial,
  onStarted,
  header,
  compact = false,
  backdrop,
  corner,
}: {
  /** A search to edit: shows its answers, a box to add something, and Search again. */
  initial?: Draft;
  onStarted?: (slug: string) => void;
  /** Renders the capsule, e.g. into the site header. Omitted when editing a result, which has its own. */
  header?: (island: ReactNode) => ReactNode;
  /** Rendered in a panel (the Edit search dialog) rather than as the page. */
  compact?: boolean;
  /** Full-screen background for the landing, shown until the first words are sent. */
  backdrop?: ReactNode;
  /** Corner content on the landing (How it works), hidden along with the backdrop. */
  corner?: ReactNode;
}) {
  const router = useRouter();
  const locale = useBrowserLocale();
  const currency = useCurrency();
  const still = useMedia("(prefers-reduced-motion: reduce)");
  const touch = useMedia("(pointer: coarse)");
  // Read only by controls that mount after the first words, so the server's `false` doesn't render.
  const narrow = useMedia("(max-width: 639px)");
  const recent = useRecentSearches();

  const [draft, setDraft] = useState<Draft>(initial ?? EMPTY_DRAFT);
  // Mirror of the draft for handlers, so an answer given in the same tick as a stepper change sees the new values.
  const dref = useRef<Draft>(draft);
  const update = (patch: Partial<Draft>) => {
    dref.current = { ...dref.current, ...patch };
    setDraft(dref.current);
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => update({ [k]: v } as Partial<Draft>);

  const [phase, setPhase] = useState<Phase>(initial ? "review" : "brief");
  const [current, setCurrent] = useState<QuestionKey | null>(null);
  /** The answer being edited: the brief, or a turn by index. */
  const [editing, setEditing] = useState<"brief" | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState("");
  const seq = useRef(0);
  const active = useRef<HTMLDivElement>(null);
  /** Height of the last question, held while the next one loads so the page doesn't shrink. */
  const [hold, setHold] = useState(0);
  const [typing, setTyping] = useState(false);
  const [firstPaint] = useState(() => !hydrated);
  // Client-side navigation skips the first-paint script, so measure the gutter in this layout effect instead.
  useLayoutEffect(() => {
    if (compact || getComputedStyle(document.documentElement).getPropertyValue("--landing-gutter")) return;
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;top:-200px;width:100px;height:100px;overflow:scroll";
    document.documentElement.appendChild(d);
    const w = d.offsetWidth - d.clientWidth;
    d.remove();
    if (w > 0) document.documentElement.style.setProperty("--landing-gutter", `${w}px`);
  }, [compact]);
  /** Set by Start over, so the backdrop fades back in. */
  const [returned, setReturned] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    hydrated = true;
  }, []);
  /** The draft from before the current edit. Dates and party write through as they change, so Keep restores this. */
  const before = useRef<Draft | null>(null);

  const touched = draft.brief !== "" || editing != null || phase !== "brief";
  const hero = !touched && !compact;
  const starting = phase === "starting";

  // Keep the active question in view as the page grows.
  useEffect(() => {
    if (!touched) return;
    active.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [phase, current, editing, touched, still]);

  // When a shorter question follows a taller one, hold enough min-height that the page doesn't shrink under the scroll position.
  useLayoutEffect(() => {
    const el = active.current;
    if (phase !== "asking" || editing != null || !el || !hold) return;
    el.style.minHeight = `${hold}px`;
    const last = el.lastElementChild as HTMLElement | null;
    const natural = last ? last.offsetTop + last.offsetHeight - el.offsetTop : 0;
    const room = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
    const keep = Math.max(natural, hold - Math.max(0, room));
    el.style.minHeight = keep > natural + 0.5 ? `${keep}px` : "";
  }, [phase, current, editing, hold]);

  useEffect(() => {
    if (phase !== "thinking") return;
    const t = setTimeout(() => setTyping(true), TYPING_AFTER_MS);
    return () => {
      clearTimeout(t);
      setTyping(false);
    };
  }, [phase]);

  // Focus a new choice or party question's radios (fields autofocus themselves). Not on touch, where the live region announces it.
  useEffect(() => {
    if (phase !== "asking" || !current || editing != null || touch) return;
    const kind = QUESTION_BY_KEY[current].control.kind;
    if (kind === "choice" || kind === "who") active.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
  }, [phase, current, editing, touch]);

  /* ---- the flow ---- */

  async function start(d: Draft) {
    setPhase("starting");
    setError(null);
    try {
      const request = requestFromDraft(d, currency, locale);
      const slug = await startSearch(request);
      remember(slug);
      // Keep the typed words in this browser. The search's shared record doesn't carry them.
      rememberWords(slug, request);
      onStarted?.(slug);
      router.push(`/s/${slug}`);
    } catch (e) {
      setError(shownError(e, "We couldn’t start your search. Give it a moment and try again."));
      // Keep the answers so the same search can be retried.
      setPhase(initial ? "review" : "failed");
    }
  }

  /** Gets the next question from the intake route (codeNext as fallback) or starts the search. "Anything else?" is always last. */
  async function askNext(d: Draft) {
    if (d.turns.some((t) => t.key === "anything_else")) return start(d);
    // Hold the answered question's height until the next one arrives.
    if (phase === "asking" && editing == null && active.current) setHold(active.current.getBoundingClientRect().height);
    setPhase("thinking");
    setError(null);
    const mine = ++seq.current;
    let next: QuestionKey | "search" = codeNext(new Set(d.turns.map((t) => t.key)), [d.brief, ...d.turns.map((t) => t.a)].join("\n"));
    try {
      const res = await fetch("/api/intake/next", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await recaptchaHeaders("intake")) },
        body: JSON.stringify({ brief: d.brief, turns: d.turns }),
      });
      const data = (await res.json().catch(() => null)) as { next?: string } | null;
      if (res.ok && data?.next && (data.next === "search" || isQuestionKey(data.next))) next = data.next as QuestionKey | "search";
    } catch {
      /* offline: use the codeNext fallback */
    }
    if (mine !== seq.current) return;
    if (next === "search") return start(dref.current);
    setCurrent(next);
    setPhase("asking");
  }

  /**
   * Starts editing an answer, reverting any other edit in progress. A pending next-question request is discarded and re-sent when the
   * edit ends, so it doesn't use stale answers.
   */
  function beginEdit(target: "brief" | number) {
    if (before.current) {
      dref.current = before.current;
      setDraft(before.current);
    }
    before.current = dref.current;
    if (phase === "thinking") seq.current++;
    setEditing(target);
  }

  /** Ends an edit, applying it or, with `keep`, restoring the previous draft. */
  function endEdit(keep: boolean) {
    if (keep && before.current) {
      dref.current = before.current;
      setDraft(before.current);
    }
    before.current = null;
    setEditing(null);
    if (phase === "thinking") void askNext(dref.current);
  }

  function submitBrief(text: string) {
    const wasEditing = editing === "brief";
    update({ brief: text });
    if (wasEditing) {
      // Drop answers the new brief contradicts, then decide again what to ask.
      const d = dref.current;
      // Only dates picked on the calendar imply a trip type the brief can contradict.
      const gone = contradicted(text, d.set.includes("dates") ? d.turns : d.turns.filter((t) => t.key !== "dates"), { oneWay: d.oneWay });
      if (!gone.size) return endEdit(false);
      const unset = new Set([...gone].map((k) => SETS_BY_KEY[k as QuestionKey]));
      const trip = oneWayIn(text);
      update({
        turns: d.turns.filter((t) => !gone.has(t.key)),
        set: d.set.filter((f) => !unset.has(f)),
        ...(gone.has("dates") && trip != null ? { oneWay: trip, ...(trip ? { ret: "" } : {}) } : {}),
      });
      before.current = null;
      setEditing(null);
      if (phase === "asking" || phase === "thinking" || phase === "failed") void askNext(dref.current);
      return;
    }
    if (phase === "review") return;
    // Crossfade the landing into the question pane.
    if (landed) ghost(shell.current);
    void askNext(dref.current);
  }

  /** Records an answer (`a` is its bubble text) and the fields it sets, replacing the answer being edited if there is one. */
  function give(key: QuestionKey, a: string, patch: Partial<Draft> = {}, sets: SetField[] = []) {
    const q = QUESTION_BY_KEY[key];
    const d = dref.current;
    const turn = { key, q: q.title, a };
    const at = typeof editing === "number" ? editing : -1;
    const turns = at >= 0 ? d.turns.map((t, i) => (i === at ? turn : t)) : [...d.turns, turn];
    update({ ...patch, turns, set: [...new Set([...(patch.set ?? d.set), ...sets])] });
    if (at >= 0) return endEdit(false);
    void askNext(dref.current);
  }

  const skip = (key: QuestionKey) => give(key, SKIPPED);
  /** Editing a search: adds the extra text as a last turn and runs it as a new search. */
  const searchAgain = () => {
    const text = extra.trim();
    if (text) update({ turns: [...dref.current.turns, { key: "anything_else", q: "Anything to add or change?", a: text }] });
    setExtra("");
    void start(dref.current);
  };

  const reset = () => {
    // Crossfade the pane back to the landing.
    if (!compact) {
      ghost(shell.current);
      setReturned(true);
    }
    seq.current++;
    setHold(0);
    before.current = null;
    dref.current = EMPTY_DRAFT;
    setDraft(EMPTY_DRAFT);
    setPhase("brief");
    setCurrent(null);
    setEditing(null);
    setError(null);
    setExtra("");
  };

  // After a reload or Back/Forward, restore the saved answers and the question being asked.
  const resume = useEffectEvent(() => {
    if (compact || initial || new URLSearchParams(window.location.search).has("from")) return;
    let saved: { draft?: Partial<Draft>; phase?: Phase; current?: unknown } | null = null;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(SAVED_KEY) ?? "null");
    } catch {
      return;
    }
    if (!saved?.draft || typeof saved.draft.brief !== "string" || !saved.draft.brief || !Array.isArray(saved.draft.turns)) return;
    const d = { ...EMPTY_DRAFT, ...saved.draft };
    dref.current = d;
    setDraft(d);
    if (saved.phase === "asking" && isQuestionKey(saved.current)) {
      setCurrent(saved.current);
      setPhase("asking");
    } else if (saved.phase === "failed") setPhase("failed");
    else void askNext(d);
  });
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after hydration
  useEffect(() => resume(), []);
  useEffect(() => {
    if (compact || initial) return;
    try {
      if (draft.brief && (phase === "asking" || phase === "thinking" || phase === "failed")) window.sessionStorage.setItem(SAVED_KEY, JSON.stringify({ draft, phase, current }));
      else window.sessionStorage.removeItem(SAVED_KEY);
    } catch {
      /* storage unavailable (private window): a reload starts over */
    }
  }, [compact, initial, draft, phase, current]);

  /* ---- the controls ---- */

  // One chip per shown place name ("Dallas" and "DFW, DAL" can read the same), keeping the most recent.
  const quickFrom = (recent ?? [])
    .map((r) => ({ key: `r-${r.from}`, label: r.from ? placeShort(r.from) : "", value: r.from }))
    .filter((q, i, all) => q.label && all.findIndex((o) => o.label === q.label) === i)
    .slice(0, 3);
  const months = useMemo(() => monthOptions(new Date(), locale), [locale]);

  /** The answer control for a question. `prior` is the existing answer when editing. */
  const control = (key: QuestionKey, prior?: string): ReactNode => {
    const q = QUESTION_BY_KEY[key];
    const labelledBy = `q-${key}`;
    // On touch, autofocus only when editing (which follows a tap), so the keyboard doesn't cover a question as it arrives.
    const focus = !touch || prior != null;
    const c = q.control;
    switch (c.kind) {
      case "place":
        return (
          <PlaceAnswer
            placeholder={c.placeholder}
            initial={prior && prior !== SKIPPED ? prior : ""}
            labelledBy={labelledBy}
            quick={c.side === "to" ? OPEN_QUICK : quickFrom}
            autoFocus={focus}
            onAnswer={(v) => give(key, v, c.side === "from" ? { from: v } : { to: v }, [c.side])}
          />
        );
      case "dates": {
        // A text answer clears any dates picked on the calendar.
        const words = (v: string) => give(key, v, { depart: "", ret: "", flexible: false, flexNote: "", set: draft.set.filter((f) => f !== "dates") });
        const picked = draft.set.includes("dates");
        return (
          <WhenAnswer
            initial={prior && prior !== SKIPPED && !picked ? prior : ""}
            picked={picked}
            labelledBy={labelledBy}
            autoFocus={focus}
            onAnswer={words}
            onSkip={() => words("Not sure yet")}
            calendar={
              <DatesAnswer
                draft={draft}
                set={set}
                locale={locale}
                onAnswer={() => give(key, datesAnswer(dref.current, locale), {}, ["dates"])}
                onSkip={() => words("Not sure yet")}
              />
            }
          />
        );
      }
      case "who":
        return <WhoAnswer draft={draft} set={set} labelledBy={labelledBy} answered={prior != null} onAnswer={() => give(key, whoAnswer(dref.current), {}, ["party"])} />;
      case "choice": {
        const options: Option[] = c.options === "months" ? months : c.options;
        const chosen = prior ? (options.find((o) => o.title === prior)?.value ?? null) : null;
        const structured = options.some((o) => o.sets?.length);
        return (
          <ChoiceAnswer
            options={options}
            chosen={chosen}
            labelledBy={labelledBy}
            other={!structured}
            onPick={(o) => give(key, o.title, (o.patch ?? {}) as Partial<Draft>, o.sets ?? [])}
          />
        );
      }
      case "text": {
        // The button skips when empty and sends what's typed otherwise. On the last question (unless editing) it starts the search,
        // so on a phone it's the full-width primary.
        const last = key === "anything_else" && prior == null;
        const ends = narrow && last;
        return (
          <TextAnswer
            initial={prior && prior !== SKIPPED ? prior : ""}
            placeholder={c.placeholder}
            labelledBy={labelledBy}
            autoFocus={focus}
            onAnswer={(v) => (v ? give(key, v) : skip(key))}
            footer={(v) => (
              <Button variant={ends ? "primary" : "secondary"} size={ends ? "lg" : "md"} className={ends ? "w-full" : "self-start"} onClick={() => (v.trim() ? give(key, v.trim()) : skip(key))}>
                {v.trim() ? (last ? "Search" : "Continue") : last ? "No, search" : "Nothing to add"}
                {last && <ArrowRight className="h-4 w-4" strokeWidth={2.4} />}
              </Button>
            )}
          />
        );
      }
    }
  };

  /* ---- the capsule: the trip so far ---- */

  const island = draft.brief ? (
    <Island busy={phase === "thinking" || starting}>
      <IslandPart onClick={phase === "review" || starting ? undefined : () => beginEdit("brief")} label="Change what you said">
        {briefShort(draft.brief)}
      </IslandPart>
    </Island>
  ) : null;

  const landed = hero && backdrop != null;
  // On a laptop the trips hang below the centred column, so the column is lifted to keep both centred. Until they load, a browser that
  // has searched before assumes two rows; before hydration the first-paint script's guess applies.
  const searched = useHasSearched();
  const trips = recent ? Math.min(3, recent.length) : searched ? 2 : 0;
  const lift = recent || searched ? ({ "--trips": `${tripsLift(trips)}px` } as CSSProperties) : undefined;
  // Keep the backdrop mounted through its fade-out.
  const sky = usePresence(landed, 600);

  // Phones hide the reCAPTCHA badge while the questions are up (globals.css), so its required notice goes in the page instead.
  // Not in a panel, or on the landing, where the badge stays.
  const captcha =
    RECAPTCHA_SHOWN && !compact && !landed ? (
      <p className="text-[11.5px] leading-snug text-ink-muted sm:hidden">
        This site is protected by reCAPTCHA and the Google{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className="underline">
          Privacy Policy
        </a>{" "}
        and{" "}
        <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer" className="underline">
          Terms of Service
        </a>{" "}
        apply.
      </p>
    ) : null;

  // `data-asking` lets globals.css move the Source button and reCAPTCHA badge out of the question pane's way on narrow screens.
  useEffect(() => {
    if (landed || compact) return;
    document.documentElement.dataset.asking = "";
    return () => {
      delete document.documentElement.dataset.asking;
    };
  }, [landed, compact]);

  // The Edit search dialog is already inside the page's <main>.
  const Shell = compact ? "div" : "main";

  return (
    <>
      {header?.(island)}
      {sky.render && (
        <div
          data-state={sky.state}
          className={cx("pointer-events-none fixed inset-0 -z-10 transition-opacity duration-[600ms] ease-out data-[state=closed]:opacity-0", returned && "fade [animation-duration:600ms]")}
        >
          {backdrop}
        </div>
      )}
      {landed && corner}
      {/* `data-landing` tells globals.css the first screen is up, which has no scrollbar or gutter. */}
      <Shell
        ref={shell}
        data-landing={landed || undefined}
        style={landed ? lift : undefined}
        className={cx(
          // Landing: one screen with the question centred. After the first words: a scrolling white pane.
          !compact &&
            (landed
              ? // On a phone the title sits in the upper third, so it stays put as trips load and the box stays above the keyboard.
                "mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-[620px] flex-col justify-center px-5 pb-16 transition-[padding] duration-500 ease-[var(--ease-out)] max-sm:justify-start max-sm:pt-[16dvh] sm:px-6 lg:pb-[calc(4rem+var(--trips,var(--trips-guess,0px)))]"
              : "fade relative isolate mx-auto mt-2 mb-16 w-[calc(100%-20px)] max-w-[740px] px-5 pt-7 pb-8 short:pt-8 sm:mt-3 sm:mb-16 sm:px-14 sm:pt-16 sm:pb-12")
        )}
      >
        {/* Kept mounted: a script re-created on the client doesn't run, and React warns about it. */}
        {firstPaint && !compact && <script dangerouslySetInnerHTML={{ __html: GUTTER_PROBE + LIFT_FOR_TRIPS }} />}
        {!compact && !landed && <span aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-[28px] bg-paper shadow-[0_0_0_1px_var(--color-rule),var(--shadow-md)] sm:rounded-[36px]" />}
        <div className="flex flex-col gap-7 sm:gap-9">
          {/* `data-quiet` marks the area the backdrop animation keeps clear. */}
          {phase === "brief" || editing === "brief" ? (
            <div ref={active} className="flex scroll-mt-24 scroll-mb-10 flex-col gap-6" data-quiet={landed || undefined}>
              <Ask id="q-brief" title={BRIEF_QUESTION} hero={hero} />
              {/* On a phone Keep sits under the question, above the keyboard. From sm it sits below the box. */}
              {editing === "brief" && (
                <Button variant="secondary" className="max-w-full self-start max-sm:px-4 sm:hidden" onClick={() => endEdit(true)}>
                  <span className="min-w-0 truncate">Keep “{keepLabel(draft.brief, 28)}”</span>
                </Button>
              )}
              <BriefComposer
                key={editing === "brief" ? "edit" : "new"}
                initial={draft.brief}
                onSend={submitBrief}
                labelledBy="q-brief"
                autoFocus
                notOnTouch={!touched}
                hero={hero}
                quick={hero ? [] : OPEN_QUICK}
              />
              {editing === "brief" && (
                <button type="button" onClick={() => endEdit(true)} className="press self-start rounded-full px-2 py-1 text-[14px] font-medium text-ink-muted hover:text-ink max-sm:hidden">
                  Keep “{keepLabel(draft.brief)}”
                </button>
              )}
            </div>
          ) : (
            <Answered question={BRIEF_QUESTION} answer={draft.brief} onEdit={starting ? undefined : () => beginEdit("brief")} />
          )}

          {draft.turns.map((t, i) =>
            editing === i && isQuestionKey(t.key) ? (
              <div key={`${t.key}-${i}-edit`} ref={active} className="flex scroll-mt-24 scroll-mb-10 flex-col gap-6">
                <Ask
                  id={`q-${t.key}`}
                  title={t.q}
                  sub={QUESTION_BY_KEY[t.key].sub}
                />
                {/* Truncates a long answer so the button fits the pane on a 360px screen. */}
                <Button variant="secondary" className="max-w-full self-start max-sm:px-4 sm:hidden" onClick={() => endEdit(true)}>
                  <span className="min-w-0 truncate">Keep “{keepLabel(shownAnswer(t.key, t.a), 28)}”</span>
                </Button>
                {control(t.key, t.a)}
                <button type="button" onClick={() => endEdit(true)} className="press self-start rounded-full px-2 py-1 text-[14px] font-medium text-ink-muted hover:text-ink max-sm:hidden">
                  Keep “{keepLabel(shownAnswer(t.key, t.a))}”
                </button>
              </div>
            ) : (
              <Answered
                key={`${t.key}-${i}`}
                question={t.q}
                answer={shownAnswer(t.key, t.a)}
                note={noteFor(t.key, t.a, draft)}
                onEdit={starting || !isQuestionKey(t.key) ? undefined : () => beginEdit(i)}
              />
            )
          )}

          {/* Typing bubble while the next question loads, in the space the last question took. */}
          {phase === "thinking" && editing == null && (
            <div className="flex flex-col items-start" style={{ minHeight: hold || undefined }}>
              {typing && (
                <span className="msg-in typing flex h-11 items-center gap-1.5 rounded-[22px] rounded-bl-[7px] bg-paper px-4 shadow-sm ring-1 ring-black/[0.05]">
                  <span className="h-2 w-2 rounded-full bg-ink-muted" />
                  <span className="h-2 w-2 rounded-full bg-ink-muted" />
                  <span className="h-2 w-2 rounded-full bg-ink-muted" />
                </span>
              )}
            </div>
          )}
          {/* Always mounted so changes are announced: the wait, and on touch (no autofocus) the new question. */}
          <p className="sr-only" aria-live="polite">
            {phase === "thinking" && typing ? "Working out what to ask next" : phase === "asking" && current && touch && editing == null ? QUESTION_BY_KEY[current].title : ""}
          </p>

          {phase === "asking" && current && editing == null && (
            <div key={`${current}-ask`} ref={active} className="flex scroll-mt-24 scroll-mb-10 flex-col gap-6">
              <Ask id={`q-${current}`} title={QUESTION_BY_KEY[current].title} sub={QUESTION_BY_KEY[current].sub} />
              <div className="msg-in" style={{ animationDelay: "140ms" }}>
                {control(current)}
              </div>
            </div>
          )}

          {/* Editing an existing search. */}
          {phase === "review" && editing == null && (
            <div ref={active} className="step-in flex flex-col gap-4">
              <Ask id="q-more" title="Anything to add or change?" />
              <Composer value={extra} onChange={setExtra} onSend={searchAgain} placeholder="Make it March instead…" labelledBy="q-more" />
              <div className="flex">
                <Button variant="primary" size="lg" className="max-sm:w-full" onClick={searchAgain}>
                  Search again
                  <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
                </Button>
              </div>
            </div>
          )}

          {starting && (
            <p className="fade flex items-center gap-2.5 text-[15.5px] text-ink-muted">
              <Spinner className="h-4 w-4 text-accent" />
              Starting your search…
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-2xl bg-warn-soft px-4 py-3 text-[14.5px] leading-relaxed text-warn">
              {error}
            </p>
          )}
          {phase === "failed" && editing == null && (
            <div ref={active} className="flex scroll-mt-24 scroll-mb-10">
              <Button variant="primary" size="lg" onClick={() => void start(dref.current)}>
                Try again
              </Button>
            </div>
          )}
        </div>
        {/* From lg, trips hang below the box so the question stays put as they load. Below lg they stay in flow, clear of the corners. */}
        {hero && (
          <div className="lg:relative lg:h-0">
            <div className="intro pt-8 lg:absolute lg:inset-x-0 lg:top-0" style={{ animationDelay: "260ms" }}>
              <RecentPills />
            </div>
          </div>
        )}
        {touched && !starting && !initial ? (
          <div className="flex pt-6 max-sm:flex-col max-sm:items-start max-sm:gap-3 sm:pt-10">
            {/* Low emphasis, with a 44px touch target on phones. */}
            <button
              type="button"
              onClick={reset}
              className="press flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[14px] font-medium text-ink-muted hover:text-ink max-sm:-ml-3 max-sm:h-11 max-sm:px-3 sm:-ml-2"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.2} />
              Start over
            </button>
            {captcha}
          </div>
        ) : (
          captcha && <div className="pt-6 sm:hidden">{captcha}</div>
        )}
      </Shell>
    </>
  );
}
