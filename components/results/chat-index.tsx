"use client";

import { useEffect, useRef, useState } from "react";
import type { FollowUp } from "@/lib/types";
import { cx } from "@/components/ui/primitives";
import { scrollMotion } from "./follow-ups";

/** The smallest list height worth showing in the sticky rail, about three rows. */
const MIN_LIST_PX = 128;

/**
 * The chat's table of contents in the rail: the results, then each follow-up, with the one in view marked.
 * Hidden until there are two. At the bottom of the page the last question counts as current, since it can't
 * scroll up into the reading band.
 */
export function ChatIndex({ followUps }: { followUps: FollowUp[] }) {
  const [at, setAt] = useState<string>("top");
  const listRef = useRef<HTMLOListElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const ids = followUps.map((f) => f.id).join(",");
  useEffect(() => {
    if (!ids) return;
    const list = ids.split(",");
    const els = list.map((id) => document.getElementById(`f-${id}`)).filter((el): el is HTMLElement => Boolean(el));
    const atFoot = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const io = new IntersectionObserver(
      (entries) => {
        if (atFoot()) return setAt(list[list.length - 1]);
        // The topmost question inside the reading band (the rootMargin) counts as the one being read.
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setAt(seen.target.id.slice(2));
      },
      { rootMargin: "-20% 0px -55% 0px" }
    );
    for (const el of els) io.observe(el);
    const onScroll = () => {
      if (window.scrollY < 200) setAt("top");
      else if (atFoot()) setAt(list[list.length - 1]);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [ids]);

  // Only the list scrolls inside the sticky rail. When the window is too short for the rail's buttons plus a few rows (a small
  // window, or zoomed in), data-short makes the rail scroll with the page instead (see search-view).
  const count = followUps.length;
  useEffect(() => {
    const rail = navRef.current?.parentElement;
    const list = listRef.current;
    if (!rail || !list) return;
    const fit = () => {
      // The rail's height without the list, which is the same whether or not the rail is sticky.
      const rest = rail.getBoundingClientRect().height - list.getBoundingClientRect().height;
      const room = parseFloat(getComputedStyle(rail).maxHeight);
      const avail = Number.isFinite(room) ? room : window.innerHeight - 10 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      rail.toggleAttribute("data-short", rest + Math.min(list.scrollHeight, MIN_LIST_PX) > avail);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(rail);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      rail.removeAttribute("data-short");
    };
  }, [count]);

  // Keep the current row visible by scrolling the list, never the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !row) return;
    const top = row.offsetTop; // From the list's top edge, since the list is position: relative.
    const pad = 8;
    if (top < list.scrollTop + pad) list.scrollTo({ top: top - pad, behavior: scrollMotion() });
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight - pad) list.scrollTo({ top: top + row.offsetHeight - list.clientHeight + pad, behavior: scrollMotion() });
  }, [at]);

  if (followUps.length < 2) return null;
  const go = (id: string) => {
    if (id === "top") window.scrollTo({ top: 0, behavior: scrollMotion() });
    else document.getElementById(`f-${id}`)?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
    setAt(id);
  };
  const item = (id: string, text: string, n?: number) => (
    <li key={id}>
      <button
        type="button"
        onClick={() => go(id)}
        aria-current={at === id ? "location" : undefined}
        className={cx(
          "press flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] leading-snug transition-colors",
          at === id ? "bg-soft font-semibold text-ink" : "text-ink-muted hover:bg-soft hover:text-ink"
        )}
      >
        <span className={cx("nums mt-px w-4 shrink-0 text-[11.5px] font-semibold", at === id ? "text-accent" : "text-ink-muted")}>{n}</span>
        <span className="line-clamp-2 min-w-0">{text}</span>
      </button>
    </li>
  );
  return (
    // min-h-0 lets the nav shrink to the rail's capped height so the list can scroll.
    <nav ref={navRef} aria-label="This conversation" className="fade flex min-h-0 flex-col">
      {/* Matches the rail's divider in search-view. */}
      <div aria-hidden className="mx-2.5 my-2 h-px shrink-0 bg-rule" />
      {/* -m-1 p-1 keeps focus rings inside the scroll box without shifting the rows. */}
      <ol ref={listRef} className="rail-scroll relative -m-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1">
        {item("top", "The results")}
        {followUps.map((f, i) => item(f.id, f.question, i + 1))}
      </ol>
    </nav>
  );
}
