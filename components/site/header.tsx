"use client";

import { useEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { HeaderAccount } from "@/components/auth/header-account";
import { cx } from "@/components/ui/primitives";
import { Panel } from "@/components/ui/overlay";
import { usePhone } from "@/components/ui/use-media";
import { CloudBand } from "./cloud-band";
import { useCurrency } from "./currency";
import { CurrencySign } from "./currency-sign";
import { CurrencyList } from "./currency-list";
import { Logo } from "./logo";
import { SiteMenu } from "./site-menu";

/** Currency pill ("$ USD") that opens the searchable currency list. */
function CurrencyPicker() {
  const currency = useCurrency();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const phone = usePhone();
  // Desktop popover: close when focus moves out, so it doesn't cover the newly focused element.
  const leave = (e: FocusEvent<HTMLDivElement>) => {
    if (!phone && open && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };
  return (
    <div className="relative" onBlur={leave}>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Currency: ${currency}`}
        className="float press flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-soft hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']"
      >
        <CurrencySign code={currency} className="nums" />
        <span className="nums hidden sm:inline">{currency}</span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-faint" strokeWidth={2.2} />
      </button>
      <Panel open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" label="Currency" phone={phone} className="w-[18.5rem]">
        {/* Return focus to the pill after a choice, as Escape does. */}
        <CurrencyList
          onChosen={() => {
            setOpen(false);
            anchor.current?.focus();
          }}
          autoFocus={!phone}
          inSheet={phone}
        />
      </Panel>
    </div>
  );
}

/** Whether an element paints anything itself: text, media, or a visible background, border or shadow. */
function paints(el: Element): boolean {
  if (el instanceof SVGElement || ["IMG", "CANVAS", "VIDEO", "INPUT", "TEXTAREA"].includes(el.tagName)) return true;
  if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) return true;
  const cs = getComputedStyle(el);
  const seen = (c: string) => c !== "transparent" && !/rgba?\([^)]*,\s*0\)$/.test(c) && !c.endsWith("/ 0)");
  return seen(cs.backgroundColor) || cs.backgroundImage !== "none" || cs.boxShadow !== "none" || (parseFloat(cs.borderTopWidth) > 0 && seen(cs.borderTopColor));
}

/**
 * Whether a box is painted at (x, y) by a `pointer-events: none` child, which hit testing skips. The question card draws its
 * background this way (conversation.tsx).
 */
function backed(box: Element, x: number, y: number): boolean {
  return [...box.children].some((c) => {
    if (getComputedStyle(c).pointerEvents !== "none" || !paints(c)) return false;
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
}

/**
 * Whether page content is scrolling behind any header pill. Samples a 3x3 grid of points on each pill and checks the first painted
 * element under each. Anything as wide as the page counts as background. Content passing between the pills doesn't count.
 */
function useCovered(header: RefObject<HTMLElement | null>): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = header.current;
      if (!el) return setCovered(false);
      const pills = [...el.querySelectorAll<HTMLElement>("a, button")].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0 && r.height >= 28);
      // The body's width, since the window's includes the reserved scrollbar gutter.
      const page = document.body.getBoundingClientRect().width - 2;
      const under = (x: number, y: number) => {
        // Only boxes narrower than the page count as content. Full-width boxes are background.
        const drawn = document.elementsFromPoint(x, y).find((hit) => !el.contains(hit) && (paints(hit) || (hit.getBoundingClientRect().width < page && backed(hit, x, y))));
        return Boolean(drawn && drawn !== document.body && drawn !== document.documentElement && drawn.getBoundingClientRect().width < page);
      };
      // Sample top, middle and bottom: a gap between cards can line up with a pill's middle while an edge is under it.
      setCovered(pills.some((r) => [r.left + 6, r.left + r.width / 2, r.right - 6].some((x) => [r.top + 3, r.top + r.height / 2, r.bottom - 3].some((y) => under(x, y)))));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    return () => {
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      cancelAnimationFrame(frame);
    };
  }, [header]);
  return covered;
}

/**
 * Positions a copy of the page's CloudBand inside the header fade, aligned with the real one as the page scrolls, so the fade
 * matches the sky behind it. Moved with a transform to avoid repaints.
 * Returns the copy's container and the band's height (null when the page has no band).
 */
function useSkyCopy(header: RefObject<HTMLElement | null>): { copy: RefObject<HTMLDivElement | null>; height: number | null } {
  const copy = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = header.current;
      const box = copy.current;
      const sky = el ? [...document.querySelectorAll<HTMLElement>(".cloud-band")].find((b) => !el.contains(b)) : undefined;
      if (!box?.parentElement || !sky) return setHeight(null);
      const r = sky.getBoundingClientRect();
      const fade = box.parentElement.getBoundingClientRect();
      box.style.transform = `translate(${r.left - fade.left}px, ${r.top - fade.top}px)`;
      box.style.width = `${r.width}px`;
      setHeight(Math.round(r.height));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    return () => {
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      cancelAnimationFrame(frame);
    };
  }, [header]);
  return { copy, height };
}

/**
 * Sticky header of floating pills (logo, currency, account) with an optional `center` island. Only the pills take the pointer.
 * Below 768px the controls move into SiteMenu. Their width is published as `--header-side` for the results columns (columns.ts).
 * When content scrolls behind a pill (useCovered), a fade showing the sky band or page background covers it.
 */
export function SiteHeader({ center }: { center?: ReactNode }) {
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = side.current;
    if (!el) return;
    const root = document.documentElement.style;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) root.setProperty("--header-side", `${Math.ceil(w)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.removeProperty("--header-side");
    };
  }, []);
  const bar = useRef<HTMLElement>(null);
  const covered = useCovered(bar);
  const { copy, height: sky } = useSkyCopy(bar);
  return (
    <header ref={bar} className="pointer-events-none sticky top-0 z-40">
      {/* Fade layer: solid at the top, then masked out, showing the sky copy over the page background. */}
      <div
        aria-hidden
        data-on={covered}
        className="absolute inset-x-0 top-0 isolate h-[72px] overflow-hidden bg-ground opacity-0 transition-opacity duration-200 [mask-image:linear-gradient(to_bottom,#000_55%,transparent)] data-[on=true]:opacity-100 [@media(max-height:480px)]:h-16"
      >
        <div ref={copy} className="absolute top-0 left-0" style={sky == null ? undefined : { height: sky }}>
          {sky != null && <CloudBand className="h-full" />}
        </div>
      </div>
      {/* The side padding clears a notch in landscape; env() is 0 anywhere else. */}
      <div className="relative mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pl-[max(1.25rem,env(safe-area-inset-left))] [@media(max-height:480px)]:h-12 [&>*]:pointer-events-auto">
        {/* From lg up, both sides take equal width so the island is centred on the page. */}
        <div className={cx("pointer-events-none! flex shrink-0 [&>*]:pointer-events-auto", center ? "lg:flex-1 lg:basis-0" : null)}>
          <Logo />
        </div>
        {/* On phones the island sits flush right, inset like the logo. */}
        {center ? (
          <div className="pointer-events-none! flex min-w-0 flex-1 justify-center px-1 max-sm:justify-end max-sm:self-stretch max-sm:pr-0 lg:flex-none [&>*]:pointer-events-auto">{center}</div>
        ) : (
          <span className="pointer-events-none! flex-1" />
        )}
        <div className={cx("pointer-events-none! flex shrink-0 justify-end gap-2 [&>*]:pointer-events-auto", center ? "lg:flex-1 lg:basis-0" : null)}>
          {/* Hidden on phones (the menu has them) and beside a trip below 640px. Flex so the account placeholder keeps its width. */}
          <div ref={side} className={cx("shrink-0 items-center gap-2", center ? "hidden sm:flex" : "hidden md:flex")}>
            <CurrencyPicker />
            <HeaderAccount />
          </div>
          {!center && <SiteMenu className="md:hidden" />}
        </div>
      </div>
    </header>
  );
}
