"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "./primitives";
import { usePresence } from "./presence";

/**
 * Overlays: Popover (under its trigger), Sheet (from the side) and Modal (centred). On phones the sheet and modal rise from
 * the bottom and can be dragged down to close. All close on Escape or an outside click, restore focus, and animate out.
 */

/* --------------------------------- Popover -------------------------------- */

/**
 * Panel under its trigger, positioned against the caller's `position: relative` wrapper so it needs no measuring.
 * Clicks on `anchor` don't count as outside, so the trigger can toggle it.
 */
export function Popover({
  open,
  onClose,
  anchor,
  align = "start",
  className = "",
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const { render, state } = usePresence(open, 150);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    // Capture phase and stopPropagation, so Escape closes only the popover and not a sheet around it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      (anchor.current as HTMLElement | null)?.focus?.();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!render) return null;
  const place = align === "end" ? "right-0 origin-top-right" : align === "center" ? "left-1/2 -translate-x-1/2 origin-top" : "left-0 origin-top-left";
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      data-state={state}
      className={cx(
        "pop absolute top-[calc(100%+10px)] z-50 rounded-3xl bg-paper p-2 shadow-[0_0_0_1px_var(--color-rule),var(--shadow-lg)]",
        place,
        className
      )}
    >
      {children}
    </div>
  );
}

/* ----------------------------- Sheet and modal ---------------------------- */

/** Open overlays, oldest first. Only the top one handles Escape and Tab. */
const stack: object[] = [];

/**
 * Last element focused outside any dialog, restored when one closes. Needed because an autoFocus field can take focus before
 * the dialog's effect runs, hiding what opened it.
 */
let lastOutside: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLElement && !e.target.closest("[aria-modal='true']")) lastOutside = e.target;
    },
    true
  );

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useOverlay(open: boolean, onClose: () => void, panel: RefObject<HTMLElement | null>) {
  // Keep the latest onClose in a ref. Callers pass a new function each render, and re-running the effect would steal focus.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Escape closes the top overlay only, Tab is trapped inside it, and the page behind is scroll-locked. Focus moves into the panel
  // unless something inside already has it, and returns to the opener on close.
  useEffect(() => {
    if (!open) return;
    const me = {};
    stack.push(me);
    // Flags stacked overlays so globals.css can darken the scrollbar gutter to match the deeper scrim.
    const stacked = () => document.documentElement.toggleAttribute("data-stacked", stack.length > 1);
    stacked();
    const active = document.activeElement as HTMLElement | null;
    const before = active && panel.current?.contains(active) ? lastOutside : active;
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape") return close.current();
      const box = panel.current;
      if (e.key !== "Tab" || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return e.preventDefault();
      const at = document.activeElement;
      const outside = !box.contains(at);
      const wrap = e.shiftKey ? outside || at === box || at === items[0] : outside || at === items[items.length - 1];
      if (!wrap) return;
      e.preventDefault();
      (e.shiftKey ? items[items.length - 1] : items[0]).focus();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    }, 30);
    return () => {
      clearTimeout(t);
      stack.splice(stack.indexOf(me), 1);
      stacked();
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus();
    };
  }, [open, panel]);
}

/** Window for measuring flick speed, in ms. Only the end of the drag counts, so a pause before a flick doesn't cancel it. */
const FLICK_MS = 80;

/**
 * Drag-to-close for phone sheets. The panel (the drag zone's parent) follows the finger and closes past 80px or on a flick,
 * otherwise it settles back. On close the transform stays, so the exit animation starts where the finger let go.
 */
function useDragToClose(open: boolean, onClose: () => void) {
  // `trail`: recent finger positions and times, covering the last FLICK_MS.
  const drag = useRef<{ el: HTMLElement; id: number; y0: number; dy: number; trail: { t: number; dy: number }[] } | null>(null);
  const moved = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = moved.current;
    if (!open || !el) return;
    el.style.transform = "";
    el.style.transition = "";
    moved.current = null;
  }, [open]);
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = d.el;
    // Speed over the last FLICK_MS, or since pointerdown if the drag was shorter.
    let from = d.trail[0];
    for (const p of d.trail) if (p.t <= e.timeStamp - FLICK_MS) from = p;
    const speed = (d.dy - from.dy) / Math.max(1, Math.min(FLICK_MS, e.timeStamp - from.t));
    // Require some distance for a flick, since a tap can register a high speed over a couple of pixels.
    if (d.dy > 80 || (d.dy > 12 && speed > 0.5)) {
      onClose();
      return;
    }
    if (d.dy < 4) {
      el.style.transform = "";
      el.style.transition = "";
      // A tap: pass the click to the element under the drag zone, e.g. a row at the top of the sheet.
      const zone = e.currentTarget;
      zone.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      zone.style.pointerEvents = "";
      if (e.type === "pointerup" && under instanceof HTMLElement && el.contains(under)) under.click();
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.style.transition = still ? "none" : "transform .25s var(--ease-out)";
    el.style.transform = "";
    if (!still) el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      const el = e.currentTarget.parentElement;
      if (e.button !== 0 || !el) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { el, id: e.pointerId, y0: e.clientY, dy: 0, trail: [{ t: e.timeStamp, dy: 0 }] };
      moved.current = el;
      el.style.transition = "none";
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.dy = Math.max(0, e.clientY - d.y0);
      d.el.style.transform = `translateY(${d.dy}px)`;
      d.trail.push({ t: e.timeStamp, dy: d.dy });
      while (d.trail.length > 1 && d.trail[1].t <= e.timeStamp - FLICK_MS) d.trail.shift();
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

/** Drag area over the grabber, clear of the Close button. Must be a direct child of the panel it moves. */
const DRAG_ZONE = "absolute inset-x-14 top-0 z-[5] h-8 cursor-grab touch-none";

/** Close button for sheets and modals: a 38px circle with a 44px touch target that takes no extra space. */
export function CloseButton({ onClose, className = "" }: { onClose: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Close"
      title="Close"
      onClick={onClose}
      className={cx(
        "press group z-10 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full pointer-coarse:-m-[3px] pointer-coarse:h-11 pointer-coarse:w-11",
        className
      )}
    >
      <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-soft text-ink-soft group-hover:text-ink">
        <X className="h-4 w-4" strokeWidth={2.2} />
      </span>
    </button>
  );
}

/** Side panel on desktop, bottom sheet on phones, e.g. flight details or a price watch. */
export function Sheet({
  open,
  onClose,
  label,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** Pinned to the bottom of the sheet, e.g. the Book button. */
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const { render, state } = usePresence(open, 240);
  useOverlay(open, onClose, panel);
  const drag = useDragToClose(open, onClose);
  if (!render) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div data-state={state} className="scrim absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-state={state}
        style={{ ["--w" as string]: `${width}px` }}
        className="sheet absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-[28px] bg-paper shadow-lg outline-none md:inset-y-3 md:right-3 md:left-auto md:max-h-none md:w-[var(--w)] md:rounded-[28px]"
      >
        <div className="flex justify-center pt-2.5 md:hidden" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-rule-strong" />
        </div>
        <div aria-hidden className={cx(DRAG_ZONE, "md:hidden")} {...drag} />
        <CloseButton onClose={onClose} className="absolute top-3 right-3 md:top-4 md:right-4" />
        {/* Without a footer, pad the content clear of the home indicator. */}
        <div className={cx("min-h-0 flex-1 overflow-y-auto overscroll-contain", !footer && "max-md:pb-[env(safe-area-inset-bottom)]")}>{children}</div>
        {footer && <div className="border-t border-rule px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** Centred dialog, e.g. the date-pair grid or sign-in. On phones it is a bottom sheet with a drag grabber. */
export function Modal({
  open,
  onClose,
  label,
  children,
  width = 560,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Matches the phone slide-down exit in globals.css, the longer of the two exit animations.
  const { render, state } = usePresence(open, 240);
  useOverlay(open, onClose, panel);
  const drag = useDragToClose(open, onClose);
  if (!render) return null;
  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-end justify-center sm:items-center sm:p-6">
      <div data-state={state} className="scrim absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-state={state}
        style={{ maxWidth: width }}
        className={cx(
          "modal relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-paper shadow-lg outline-none sm:rounded-[28px]",
          className
        )}
      >
        <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-rule-strong" />
        </div>
        <div aria-hidden className={cx(DRAG_ZONE, "sm:hidden")} {...drag} />
        <CloseButton onClose={onClose} className="absolute top-3.5 right-3.5" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain max-sm:pb-[env(safe-area-inset-bottom)]">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/* ---------------------------------- Panel --------------------------------- */

/** Popover on desktop, sheet on phones, where a popover near the screen edge would run off it. */
export function Panel({
  open,
  onClose,
  anchor,
  align = "start",
  label,
  className = "",
  phone,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  align?: "start" | "center" | "end";
  label: string;
  className?: string;
  /** From `usePhone()`, passed in so all panels agree. */
  phone: boolean;
  children: ReactNode;
}) {
  if (phone)
    return (
      <Sheet open={open} onClose={onClose} label={label}>
        {/* Title lines up with the Close button. The sheet already pads for the home indicator. */}
        <div className="px-4 pb-6">
          <p className="mb-3 flex h-[30px] items-center pr-12 text-[17px] font-semibold text-ink">{label}</p>
          {children}
        </div>
      </Sheet>
    );
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} align={align} label={label} className={className}>
      {children}
    </Popover>
  );
}
