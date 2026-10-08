"use client";

import { useEffect, useState } from "react";

/**
 * Keeps an element rendered with `data-state="closed"` for `exitMs` after `open` turns false, so its exit animation can finish.
 * The previous-value check runs during render, React's recommended way to update state when a prop changes.
 */
export function usePresence(open: boolean, exitMs = 200): { render: boolean; state: "open" | "closed" } {
  const [wasOpen, setWasOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open);
  }
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), exitMs);
    return () => clearTimeout(t);
  }, [closing, exitMs]);
  return { render: open || closing, state: open ? "open" : "closed" };
}
