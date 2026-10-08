"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { ANSWER_MAX, BRIEF_MAX, type Option } from "@/lib/intake/questions";
import { Button, Checkbox, cx, Stepper } from "@/components/ui/primitives";
import { DateRangePicker } from "@/components/search/date-range";
import { Segmented } from "@/components/ui/segmented";
import { useMedia } from "@/components/ui/use-media";
import type { Draft } from "@/components/search/draft";

/**
 * Answer controls for the intake conversation: the brief box, place and text fields, tap lists, the dates calendar and party steppers.
 * Each control submits its own answer.
 */

type Set = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

/* ------------------------------------------------------------------ Typing */

/** Makes the pill act as its field: a press outside the button focuses the input without blurring it first. */
const ownTarget = (t: EventTarget) => t instanceof Element && t.closest("button, input, textarea") != null;
const pillFocus = {
  onMouseDown: (e: React.MouseEvent) => {
    if (!ownTarget(e.target)) e.preventDefault();
  },
  onClick: (e: React.MouseEvent<HTMLElement>) => {
    if (!ownTarget(e.target)) e.currentTarget.querySelector<HTMLElement>("input, textarea")?.focus();
  },
};

/** Shows the characters left near a field's limit, so input isn't cut off silently. */
function LimitNote({ length, max }: { length: number; max: number }) {
  const left = max - length;
  if (left > Math.min(100, max / 10)) return null;
  return (
    <p className="px-5 pt-2 text-[13px] text-ink-muted" aria-live="polite">
      {left > 0 ? `${left} character${left === 1 ? "" : "s"} left` : "That’s as much as I can read in one go."}
    </p>
  );
}

/** The one-line field with its send button. */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  labelledBy,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  labelledBy?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const ready = value.trim().length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend();
      }}
    >
      <div className="float field flex h-[54px] cursor-text items-center gap-2 rounded-full pr-2 pl-5" {...pillFocus}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-labelledby={labelledBy}
          maxLength={ANSWER_MAX}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-muted"
        />
        {/* 44px touch target on coarse pointers. */}
        <button
          type="submit"
          aria-label="Send"
          disabled={!ready}
          className={cx("press flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full pointer-coarse:h-11 pointer-coarse:w-11", ready ? "btn-primary" : "bg-ink/[0.06] text-ink-faint")}
        >
          <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.4} />
        </button>
      </div>
      <LimitNote length={value.length} max={ANSWER_MAX} />
    </form>
  );
}

/** Quick-answer chips under a field, e.g. "Somewhere warm" or a recent origin. */
export function Quick({ items, onPick }: { items: { key: string; label: string; value: string }[]; onPick: (v: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-3">
      {items.map((q, i) => (
        <button
          key={q.key}
          type="button"
          onClick={() => onPick(q.value)}
          className="float step-in press h-9 rounded-full px-4 text-[14px] font-medium text-ink max-sm:h-10"
          style={{ animationDelay: `${160 + i * 50}ms` }}
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}

/** A typed place, sent as free text for the planner to read. */
export function PlaceAnswer({
  placeholder,
  initial,
  onAnswer,
  labelledBy,
  quick,
  autoFocus,
}: {
  /** The question's hint from questions.ts. */
  placeholder: string;
  initial: string;
  onAnswer: (v: string) => void;
  labelledBy: string;
  /** Quick picks shown while the field is empty. */
  quick: { key: string; label: string; value: string }[];
  autoFocus: boolean;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  return (
    <div>
      <Composer
        value={value}
        onChange={setValue}
        onSend={() => onAnswer(value.trim())}
        placeholder={placeholder}
        labelledBy={labelledBy}
        inputRef={input}
      />
      {!value.trim() && <Quick items={quick} onPick={onAnswer} />}
    </div>
  );
}

/* ------------------------------------------------------------------- Cards */

/** The group's visible radio rows (rows hidden on a phone are skipped). */
const rowsOf = (group: HTMLElement | null) => (group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter((r) => r.getClientRects().length > 0) : []);

/**
 * Tappable answers as a radio group with one tab stop (the chosen row, else the first). Arrows, Home and End move focus without
 * answering, since an answer moves the conversation on. Space or Enter answers.
 */
export function Choices({ children, labelledBy }: { children: ReactNode; labelledBy: string }) {
  const group = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rows = rowsOf(group.current);
    if (rows.filter((r) => r.tabIndex === 0).length === 1) return;
    const stop = rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0];
    for (const r of rows) r.tabIndex = r === stop ? 0 : -1;
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = rowsOf(group.current);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const n = rows.length;
    const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1 + n, ArrowLeft: at - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    for (const r of rows) r.tabIndex = -1;
    rows[to % n].tabIndex = 0;
    rows[to % n].focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="step-in slip overflow-hidden rounded-[20px]">
      {children}
    </div>
  );
}

export function Choice({ title, sub, chosen = false, onClick, className }: { title: string; sub?: string; chosen?: boolean; onClick: () => void; className?: string }) {
  // The card clips its edges, so the focus ring is drawn inside the row.
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onClick}
      className={cx(
        "group relative flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-rule first:before:hidden first:rounded-t-[20px] last:rounded-b-[20px] hover:bg-well active:bg-soft focus-visible:outline-offset-[-2px]",
        className
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[16px] font-medium text-ink">{title}</span>
        {sub && <span className="text-[13.5px] leading-snug text-ink-muted">{sub}</span>}
      </span>
      {chosen ? <Check className="h-[18px] w-[18px] shrink-0 text-accent" strokeWidth={2.6} /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />}
    </button>
  );
}

const PARTIES = [
  { key: "one", title: "Just me", sub: "One adult", who: { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0 } },
  { key: "two", title: "Two of us", sub: "Two adults", who: { adults: 2, children: 0, infantsInSeat: 0, infantsOnLap: 0 } },
  { key: "family", title: "A family", sub: "Two adults, two children", who: { adults: 2, children: 2, infantsInSeat: 0, infantsOnLap: 0 } },
] as const;

export function WhoAnswer({ draft, set, onAnswer, labelledBy, answered }: { draft: Draft; set: Set; onAnswer: () => void; labelledBy: string; answered: boolean }) {
  const match = PARTIES.find((p) => p.who.adults === draft.adults && p.who.children === draft.children && !draft.infantsInSeat && !draft.infantsOnLap);
  // Editing a custom party opens with its counts showing.
  const [custom, setCustom] = useState(answered && !match);
  const narrow = useMedia("(max-width: 639px)");
  const still = useMedia("(prefers-reduced-motion: reduce)");
  const counts = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // On a phone the presets hide when the counts open, so scroll the counts into view. Only when tapped open, not when editing.
  useEffect(() => {
    if (!custom || !opened.current) return;
    opened.current = false;
    if (narrow) counts.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [custom, narrow, still]);
  return (
    <div className="flex flex-col gap-3">
      <Choices labelledBy={labelledBy}>
        {PARTIES.map((p) => (
          <Choice
            key={p.key}
            title={p.title}
            sub={p.sub}
            chosen={answered && !custom && match?.key === p.key}
            className={custom ? "max-sm:hidden" : undefined}
            onClick={() => {
              set("adults", p.who.adults);
              set("children", p.who.children);
              set("infantsInSeat", 0);
              set("infantsOnLap", 0);
              onAnswer();
            }}
          />
        ))}
        {/* On a phone this is the only row while the counts are open. Tapping it again closes them. */}
        <Choice
          title="Something else"
          sub="Kids, babies or a bigger group"
          chosen={custom || (answered && !match)}
          className={custom ? "max-sm:rounded-t-[20px] max-sm:before:hidden" : undefined}
          onClick={() => {
            if (narrow && custom) return setCustom(false);
            opened.current = !custom;
            setCustom(true);
          }}
        />
      </Choices>
      {custom && (
        <div ref={counts} className="step-in slip flex scroll-mb-6 flex-col rounded-[20px] px-5 py-2">
          <div className="flex flex-col divide-y divide-rule">
            <Stepper
              label="Adults"
              value={draft.adults}
              min={1}
              onChange={(v) => {
                set("adults", v);
                if (draft.infantsOnLap > v) set("infantsOnLap", v);
              }}
            />
            <Stepper label="Children" hint="Aged 2–11" value={draft.children} onChange={(v) => set("children", v)} max={8} />
            <Stepper label="Infants in a seat" value={draft.infantsInSeat} onChange={(v) => set("infantsInSeat", v)} max={8} />
            <Stepper label="Infants on a lap" hint="One per adult" value={draft.infantsOnLap} onChange={(v) => set("infantsOnLap", v)} max={draft.adults} />
          </div>
          <div className="flex justify-end py-3">
            <Button variant="primary" className="max-sm:w-full" onClick={onAnswer}>
              Continue
              <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- Dates */

/** The calendar card: trip type, dates, flexibility, then Continue. */
export function DatesAnswer({ draft, set, onAnswer, onSkip, locale }: { draft: Draft; set: Set; onAnswer: () => void; onSkip: () => void; locale: string }) {
  const complete = Boolean(draft.depart) && (draft.oneWay || Boolean(draft.ret));
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-2 pt-1 pb-3 sm:px-3">
        <Segmented
          label="Trip type"
          value={draft.oneWay}
          onChange={(v) => {
            set("oneWay", v);
            if (v) set("ret", "");
          }}
          options={[
            { value: false, label: "Round trip" },
            { value: true, label: "One way" },
          ]}
        />
      </div>
      <DateRangePicker depart={draft.depart} ret={draft.oneWay ? "" : draft.ret} oneWay={draft.oneWay} locale={locale} onChange={(a, b) => (set("depart", a), set("ret", b))} />
      <div className="px-2 pt-2 pb-1 sm:px-3">
        <Checkbox
          checked={draft.flexible}
          onChange={(v) => set("flexible", v)}
        >
          My dates are flexible
        </Checkbox>
      </div>
      {/* `inert` keeps the collapsed field out of the tab order. */}
      <div className="grow" data-open={draft.flexible} inert={!draft.flexible}>
        {/* Padding inside the collapsing wrapper keeps the focus ring from being clipped. */}
        <div>
          <label className="flex flex-col px-2 pt-2 pb-1 sm:px-3">
            <input
              aria-label="How flexible your dates are"
              value={draft.flexNote}
              onChange={(e) => set("flexNote", e.target.value)}
              placeholder="A few days either side…"
              className="h-11 w-full rounded-xl bg-well px-3.5 text-[15px] text-ink outline-none placeholder:text-ink-muted focus:bg-paper focus:ring-2 focus:ring-accent pointer-coarse:text-[16px]"
            />
          </label>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-2 pt-4 pb-1 sm:px-3">
        <Button
          variant="secondary"
          onClick={() => {
            set("depart", "");
            set("ret", "");
            onSkip();
          }}
        >
          Not sure yet
        </Button>
        <Button variant="primary" disabled={!complete} onClick={onAnswer}>
          Continue
          <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
        </Button>
      </div>
    </Card>
  );
}

/**
 * The dates question, answered in words by default ("a week in March" gives when, how long and how flexible). Words go to the planner
 * and set no dates. The calendar is one tap away and sets exact dates.
 */
export function WhenAnswer({
  initial,
  picked,
  labelledBy,
  autoFocus,
  onAnswer,
  onSkip,
  calendar,
}: {
  initial: string;
  /** The answer being edited came from the calendar, so open it there. */
  picked: boolean;
  labelledBy: string;
  autoFocus: boolean;
  onAnswer: (v: string) => void;
  onSkip: () => void;
  calendar: ReactNode;
}) {
  const [picking, setPicking] = useState(picked);
  const link = "press self-start rounded-full px-2 py-1 text-[14px] font-medium text-ink-muted hover:text-ink";
  if (picking)
    return (
      <div className="flex flex-col gap-3">
        {calendar}
        <button type="button" onClick={() => setPicking(false)} className={link}>
          Or say it in words
        </button>
      </div>
    );
  return (
    <TextAnswer
      initial={initial}
      placeholder="A week in March, say…"
      labelledBy={labelledBy}
      autoFocus={autoFocus}
      onAnswer={(v) => (v ? onAnswer(v) : onSkip())}
      footer={(v) => (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => setPicking(true)} className={link}>
            Pick exact dates
          </button>
          <Button variant="secondary" onClick={() => (v.trim() ? onAnswer(v.trim()) : onSkip())}>
            {v.trim() ? "Continue" : "Not sure yet"}
          </Button>
        </div>
      )}
    />
  );
}


/* ------------------------------------------------------------- The first box */

/** The first box, for describing the trip. Grows with its text. Enter sends and Shift+Enter adds a line. */
export function BriefComposer({
  initial = "",
  onSend,
  labelledBy,
  autoFocus,
  notOnTouch = false,
  placeholder = "Tokyo in April, from Chicago, two of us…",
  hero = false,
  quick = [],
}: {
  initial?: string;
  onSend: (text: string) => void;
  labelledBy?: string;
  autoFocus: boolean;
  /** Skip autofocus on touch screens, where the keyboard would cover the page. Checked at mount, since the server can't know. */
  notOnTouch?: boolean;
  placeholder?: string;
  hero?: boolean;
  quick?: { key: string; label: string; value: string }[];
}) {
  const [value, setValue] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const t = value.trim();

  useEffect(() => {
    if (autoFocus && !(notOnTouch && window.matchMedia("(pointer: coarse)").matches)) area.current?.focus({ preventScroll: true });
  }, [autoFocus, notOnTouch]);
  // Grow with the text up to six lines. Empty on the first screen it stays one line, since Chrome counts the placeholder in scrollHeight.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${hero && !value ? 26 + 2 * 9 : Math.min(el.scrollHeight, 6 * 26 + 30)}px`;
  }, [value, hero]);

  const send = (text: string) => {
    const v = text.trim();
    if (v) onSend(v);
  };
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(value);
        }}
        {...pillFocus}
        className={cx("float field relative flex cursor-text items-end gap-2 rounded-[28px] py-2 pr-2 pl-5", hero && "lifted intro [animation-delay:120ms] sm:py-2.5 sm:pl-6")}
      >
        {/* A shorter one-line hint on phones. The textarea keeps the full placeholder, transparent, for screen readers. */}
        {hero && !value && (
          <span aria-hidden className="pointer-events-none absolute top-[17px] right-14 left-5 truncate text-[16px] leading-[26px] text-ink-muted sm:hidden">
            Tokyo in April, two of us…
          </span>
        )}
        <textarea
          ref={area}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(value);
            }
          }}
          placeholder={placeholder}
          aria-labelledby={labelledBy}
          maxLength={BRIEF_MAX}
          autoComplete="off"
          spellCheck={false}
          // When empty, hide overflow so a wrapping placeholder can't scroll the one-line box.
          className={cx(
            "min-w-0 flex-1 resize-none bg-transparent py-[9px] text-[16px] leading-[26px] text-ink outline-none placeholder:text-ink-muted",
            !value && "overflow-hidden",
            hero && "max-sm:placeholder:text-transparent sm:text-[17px]"
          )}
        />
        {/* Centred on the last text line (26px line, 9px padding each side). 44px on coarse pointers. */}
        <button
          type="submit"
          aria-label="Send"
          disabled={!t}
          className={cx("press mb-[2px] flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full pointer-coarse:mb-0 pointer-coarse:h-11 pointer-coarse:w-11", t ? "btn-primary" : "bg-ink/[0.06] text-ink-faint")}
        >
          <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.4} />
        </button>
      </form>
      <LimitNote length={value.length} max={BRIEF_MAX} />
      {!t && <Quick items={quick} onPick={send} />}
    </div>
  );
}

/* ------------------------------------------------------------ Tapped answers */

/** A list of choices, optionally with a free-text alternative ("ten days instead") for the planner to read. */
export function ChoiceAnswer({
  options,
  chosen,
  labelledBy,
  onPick,
  other = true,
}: {
  options: Option[];
  chosen?: string | null;
  labelledBy: string;
  onPick: (o: Option) => void;
  /** Offer "say it another way" under the list. */
  other?: boolean;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const narrow = useMedia("(max-width: 639px)");
  // Focus the field once "say it another way" is tapped.
  useEffect(() => {
    if (typing) field.current?.focus();
  }, [typing]);
  return (
    <div className="flex flex-col gap-3">
      <Choices labelledBy={labelledBy}>
        {options.map((o) => (
          <Choice key={o.value} title={o.title} sub={o.sub} chosen={chosen === o.value} onClick={() => onPick(o)} />
        ))}
      </Choices>
      {other &&
        (typing ? (
          <div className="step-in">
            <Composer value={text} onChange={setText} onSend={() => onPick({ value: "other", title: text.trim() })} placeholder="Say it your way" labelledBy={labelledBy} inputRef={field} />
          </div>
        ) : narrow ? (
          // A full button on phones, where the text link is too small to tap.
          <Button variant="secondary" className="self-start" onClick={() => setTyping(true)}>
            Or say it another way
          </Button>
        ) : (
          <button type="button" onClick={() => setTyping(true)} className="press self-start rounded-full px-2 py-1 text-[14px] font-medium text-ink-muted hover:text-ink">
            Or say it another way
          </button>
        ))}
    </div>
  );
}

/** A free-text answer. `footer` renders under the field with the current value, so its button can send it. */
export function TextAnswer({
  initial = "",
  placeholder,
  labelledBy,
  autoFocus,
  onAnswer,
  footer,
}: {
  initial?: string;
  placeholder: string;
  labelledBy: string;
  autoFocus: boolean;
  onAnswer: (v: string) => void;
  footer?: (value: string) => ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const field = <Composer value={value} onChange={setValue} onSend={() => onAnswer(value.trim())} placeholder={placeholder} labelledBy={labelledBy} inputRef={input} />;
  if (!footer) return field;
  return (
    <div className="flex flex-col gap-3">
      {field}
      {footer(value)}
    </div>
  );
}


/** White card for answers that take more than one tap. */
export function Card({ children }: { children: ReactNode }) {
  return <div className="step-in slip rounded-[24px] p-3 sm:p-4">{children}</div>;
}
