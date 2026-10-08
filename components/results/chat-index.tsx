"use client";

import { useEffect, useState } from "react";
import type { FollowUp } from "@/lib/types";
import { cx } from "@/components/ui/primitives";
import { scrollMotion } from "./follow-ups";

/**
 * The chat's table of contents in the rail: the results, then each follow-up, with the one in view marked.
 * Hidden until there are two. At the bottom of the page the last question counts as current, since it can't
 * scroll up into the reading band.
 */
export function ChatIndex({ followUps }: { followUps: FollowUp[] }) {
  const [at, setAt] = useState<string>("top");
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
    <nav aria-label="This conversation" className="fade flex flex-col">
      {/* Matches the rail's divider in search-view; the heading aligns with the row labels. */}
      <div aria-hidden className="mx-2.5 my-2 h-px bg-rule" />
      <p className="px-2.5 pt-3 pb-2.5 text-[13px] font-medium text-ink-muted">In this chat</p>
      <ol className="flex flex-col gap-0.5">
        {item("top", "The results")}
        {followUps.map((f, i) => item(f.id, f.question, i + 1))}
      </ol>
    </nav>
  );
}
