"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PenLine } from "lucide-react";
import { useOwnWords } from "@/lib/history";
import type { PlanView, SearchRequest } from "@/lib/types";
import { CABIN_LABEL } from "@/lib/types";
import { AIRPORTS } from "@/lib/airports";
import { askedInWords, placeLabel, resolveAirport } from "@/lib/search/intake";
import { cx } from "@/components/ui/primitives";
import { CloseButton, useOverlay } from "@/components/ui/overlay";
import { usePresence } from "@/components/ui/presence";
import { Conversation } from "@/components/ask/conversation";
import { placeShort } from "@/components/ask/replies";
import { rangeLabel } from "./dates";
import { draftFromRequest, whoLabel } from "./draft";

/**
 * The trip summary at the top of a result, laid out like a boarding pass: airport codes at each end, dates above the route and the party
 * below it. Edit opens the conversation prefilled; searching again creates a new search and leaves this one unchanged.
 */
type End = { codes: string[]; name: string };

function endsOf(places: { code: string; name: string }[] | undefined, typed: string): End | null {
  if (places?.length) return { codes: places.map((p) => p.code), name: [...new Set(places.map((p) => p.name))].join(" or ") };
  const t = typed.trim();
  if (!t) return null;
  const code = resolveAirport(t);
  return { codes: code ? [code] : [], name: code && AIRPORTS[code] ? placeShort(t) : placeLabel(t) };
}

/**
 * One end of the trip: large codes with the city below, or the open-destination text (up to two lines) when there is no airport yet.
 * Both ends align to the top so their first line centres on the route.
 */
function Codes({ end, align, crowded = false }: { end: End; align: "start" | "end"; crowded?: boolean }) {
  if (!end.codes.length)
    return (
      <span className={cx("display line-clamp-2 max-w-[10rem] min-w-[6.5rem] text-[18px] leading-[22px] font-semibold wrap-break-word text-ink sm:max-w-[16rem] sm:min-w-0 sm:text-[26px] sm:leading-[32px] sm:mt-1 mt-[2px]", align === "end" ? "text-right" : "")}>
        {end.name}
      </span>
    );
  // Over three codes in total: from md show up to three per end; below md, the first code plus a count, with the city cut to its width.
  const more = crowded ? end.codes.length - 1 : 0;
  return (
    <span className={cx("flex shrink-0 flex-col", align === "end" ? "items-end text-right" : "items-start")}>
      {more > 0 ? (
        <span className="display text-[26px] leading-none font-semibold text-ink sm:text-[40px]">
          {end.codes[0]}
          <span className="max-md:hidden"> / {end.codes.slice(1, 3).join(" / ")}</span>
          <span className="ml-1 align-super text-[0.45em] text-ink-muted md:hidden">+{more}</span>
        </span>
      ) : (
        <span className="display text-[26px] leading-none font-semibold text-ink sm:text-[40px]">{end.codes.slice(0, 3).join(" / ")}</span>
      )}
      <span className={cx("mt-1 max-w-[11rem] truncate text-[13px] text-ink-muted sm:max-w-[14rem]", more > 0 && "max-md:w-0 max-md:min-w-full")}>{end.name}</span>
    </span>
  );
}

/**
 * The route between the ends (ring, dotted line, dot), with `over` above it and `under` below. Its 24px height is centred on the codes'
 * first line (26px on a phone, 40px from sm).
 */
function Route({ running, over, under }: { running: boolean; over?: string | null; under?: string | null }) {
  return (
    <span className="relative mx-2 mt-px flex h-6 min-w-[2.5rem] flex-1 items-center sm:mx-4 sm:mt-2 sm:min-w-[9rem]">
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border-[2px] border-ink-faint bg-ground" />
      <span aria-hidden className="mx-1 h-0 flex-1 border-t-[2px] border-dotted border-rule-strong" />
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent shadow-[0_0_0_4px_rgba(26,90,224,0.14)]" />
      {/* The sweep is clipped to the dotted line (inset past the 10px ring and dot plus 4px margin) and faded at both ends. */}
      {running && (
        <span aria-hidden className="absolute inset-y-0 right-3.5 left-3.5 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_15%,#000_85%,transparent)]">
          <span className="sweep-way absolute top-1/2 left-0 h-[2px] w-1/3 -translate-y-1/2 rounded-full bg-accent/70" />
        </span>
      )}
      {/* From md only, truncated to the gap between the ends. Below md, TripSummary shows them under the line instead. */}
      {over && <span className="nums absolute -inset-x-3 bottom-full mb-1 truncate text-center text-[13.5px] font-semibold text-ink max-md:hidden">{over}</span>}
      {under && <span className="nums absolute -inset-x-3 top-full mt-1 truncate text-center text-[13px] text-ink-muted max-md:hidden">{under}</span>}
    </span>
  );
}

export function TripSummary({
  slug,
  request,
  plan,
  running,
  editing,
  onEditing,
  railed = false,
  failed = false,
}: {
  slug: string;
  request: SearchRequest;
  plan?: PlanView | null;
  running: boolean;
  /** Controlled edit-panel state, for pages that also open it elsewhere (a failed search's own button). */
  editing?: boolean;
  onEditing?: (open: boolean) => void;
  /** The rail has its own Edit search from lg, so this button hides there. */
  railed?: boolean;
  /** A failed search's card offers its own Edit search, so this button hides. */
  failed?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = editing ?? ownOpen;
  const setOpen = onEditing ?? setOwnOpen;
  // The record has no words; the browser that searched keeps its own.
  const own = useOwnWords(slug);
  const asked = own ? { ...request, ...own } : request;
  const from = endsOf(plan?.origins, request.from);
  const to = plan && !plan.destinations.length ? { codes: [], name: placeLabel(plan.openHint ?? request.to) || "Anywhere" } : endsOf(plan?.destinations, request.to);
  const dates = request.departDate ? rangeLabel(request.departDate, request.returnDate, request.locale) : null;
  // Show the party only once known (from a control or the plan). Before that, "1 adult" is just the default.
  const who = plan || !askedInWords(request) || request.set?.includes("party") ? whoLabel(request.passengers) : null;
  const over = dates ?? (running ? null : "Any dates");
  const underParts = [request.departDate ? (request.returnDate ? "Round trip" : "One way") : null, who, request.cabin !== "economy" ? CABIN_LABEL[request.cabin] : null].filter(Boolean);
  const under = underParts.join(" · ");
  const meta = [over, ...underParts].filter(Boolean);
  // A words-only search has no route until its plan arrives, so show the words if this browser has them. They stay while it runs,
  // so the header doesn't jump when the plan lands.
  const words = asked.brief && (running || !from || !to) ? asked.brief : null;
  // No words and no plan yet: show a placeholder.
  const blank = !words && !from && !to;
  const crowded = (from?.codes.length ?? 0) + (to?.codes.length ?? 0) > 3;
  // Nothing to draw and nothing coming (failed before planning, opened in another browser): render only the edit panel.
  if (blank && !running) return <EditPanel open={open} onClose={() => setOpen(false)} request={asked} understood={plan?.understood ?? null} />;
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-left">
          {words ? (
            <span className="words line-clamp-2 text-[18px] leading-snug text-ink sm:text-[20px]">“{words}”</span>
          ) : (
            <>
              {blank && <span className="shimmer my-2.5 h-6 w-[min(16rem,70%)] rounded-full" />}
              {/* The route fills the gap between the ends; the dates float above it so the codes line up with the rail's top. */}
              <span className={cx("flex w-full items-start", blank && "hidden")}>
                {from && <Codes end={from} align="start" crowded={crowded} />}
                <Route running={running} over={over} under={under} />
                {to && <Codes end={to} align="end" crowded={crowded} />}
              </span>
            </>
          )}
          {/* Breaks only after a "·". Phones drop "Round trip" (the dates imply it) and hide the line while there's nothing to draw. */}
          {/* While a words-only search runs, the line stays (even empty) to hold room for what the plan adds. */}
          {(meta.length > 0 || (words && running)) && (
            <span className={cx("nums text-[13.5px] text-ink-soft", !words && "md:hidden", blank && "max-md:hidden")}>
              {!meta.length && " "}
              {meta.map((p, i) => (
                <span key={i} className={cx(p === "Round trip" && "max-sm:hidden")}>
                  {i > 0 && "\u00a0· "}
                  <span className="whitespace-nowrap">{p}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        {/* A 44px icon button on phones, with the label kept for screen readers. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cx("float press flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-0 text-[13.5px] font-semibold text-ink sm:h-9 sm:w-auto sm:px-3.5", railed && "lg:hidden", failed && "hidden")}
        >
          <PenLine className="h-3.5 w-3.5" strokeWidth={2.2} />
          <span className="max-sm:sr-only">
            Edit<span className="max-sm:hidden"> search</span>
          </span>
        </button>
      </div>
      <EditPanel open={open} onClose={() => setOpen(false)} request={asked} understood={plan?.understood ?? null} />
    </>
  );
}

function EditPanel({ open, onClose, request, understood }: { open: boolean; onClose: () => void; request: SearchRequest; understood: string | null }) {
  const panel = useRef<HTMLDivElement>(null);
  const { render, state } = usePresence(open, 200);
  useOverlay(open, onClose, panel);
  if (!render) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div data-state={state} className="scrim absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden />
      {/* A top sheet on phones; from sm, an inset rounded card like Modal and Sheet. */}
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Edit search"
        data-state={state}
        className="pop absolute inset-x-0 top-0 max-h-dvh overflow-y-auto rounded-b-[32px] bg-ground px-4 pb-6 shadow-lg outline-none sm:inset-x-3 sm:top-3 sm:mx-auto sm:max-h-[calc(100dvh-1.5rem)] sm:max-w-[800px] sm:rounded-[28px] sm:px-6 sm:pb-10"
      >
        {/* The sticky bar includes the top padding, so scrolled content can't show above it. */}
        <div className="sticky top-0 z-10 -mx-4 bg-ground px-4 pt-2 shadow-[0_1px_0_var(--color-rule)] sm:-mx-6 sm:px-6">
          <div className="mx-auto flex h-14 w-full max-w-[720px] items-center justify-between">
            <p className="text-[15px] font-semibold text-ink">Edit search</p>
            <CloseButton onClose={onClose} />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[720px] pt-6">
          <Conversation initial={draftFromRequest(request, understood)} onStarted={onClose} compact />
        </div>
      </div>
    </div>,
    document.body
  );
}
