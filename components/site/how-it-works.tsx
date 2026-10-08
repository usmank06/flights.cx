"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/overlay";
import { Button } from "@/components/ui/primitives";
import { useBrowserLocale } from "@/components/ui/use-locale";
import type { AllTime } from "@/lib/metrics";

/** "How it works" is a modal so the user stays on the current page. */

const STEPS: { title: string; body: string }[] = [
  {
    title: "Say it your way",
    body: "Type a city, an idea like “somewhere warm in March”, or the whole trip in one go. It asks only what it still needs, one question at a time.",
  },
  {
    title: "It does the legwork",
    body: "It prices your trip exactly as you asked, then tries the days either side and the airports nearby, on one ticket or two. That’s dozens of searches, and it takes about a minute.",
  },
  {
    title: "You get the best few, and why",
    body: "Two or three ways to fly it, each with a line on what sets it apart, and a grid of dates you can widen. Book opens the booking page with those exact flights already picked.",
  },
];

const HOW =
  "An AI reads your trip and explains the picks, but every price comes from a real search. You don’t need an account. Sign in to get price alerts by email.";

/** Fetched once per page load, on first open. Retried on the next open if it failed. */
let asked: Promise<AllTime | null> | null = null;
function loadTotals(): Promise<AllTime | null> {
  asked ??= fetch("/api/stats")
    .then((r) => (r.ok ? r.json() : null))
    .then((t) => (t && [t.searches, t.flights, t.savedUsd].every((n) => typeof n === "number") ? (t as AllTime) : null))
    .catch(() => null)
    .then((t) => {
      if (!t) asked = null;
      return t;
    });
  return asked;
}

/** Full numbers below 100,000 and compact (1.2M) above, to fit a phone's column. */
function count(n: number, locale: string, currency?: string): string {
  const style = currency ? { style: "currency" as const, currency, maximumFractionDigits: 0 } : {};
  const compact = n >= 100_000 ? { notation: "compact" as const, maximumFractionDigits: 1 } : {};
  try {
    return new Intl.NumberFormat(locale, { ...style, ...compact }).format(n);
  } catch {
    return new Intl.NumberFormat("en-US", { ...style, ...compact }).format(n);
  }
}

/** Site-wide totals. Holds its space while loading so the modal doesn't jump. Hidden on error or before the first search. */
function Totals({ open }: { open: boolean }) {
  const locale = useBrowserLocale();
  const [totals, setTotals] = useState<AllTime | null | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    loadTotals().then((t) => live && setTotals(t));
    return () => {
      live = false;
    };
  }, [open]);
  if (totals === null || (totals && totals.searches === 0)) return null;
  const items = [
    { value: totals ? count(totals.searches, locale) : "0", label: "searches run" },
    { value: totals ? count(totals.flights, locale) : "0", label: "flights looked at" },
    { value: totals ? count(totals.savedUsd, locale, "USD") : "0", label: "found in savings" },
  ];
  return (
    <dl className={`grid grid-cols-3 gap-3 transition-opacity duration-300 ${totals ? "opacity-100" : "opacity-0"}`}>
      {items.map((s) => (
        <div key={s.label} className="flex flex-col-reverse gap-0.5">
          <dt className="text-[13px] leading-snug text-ink-muted">{s.label}</dt>
          <dd className="display nums text-[24px] leading-tight font-semibold text-ink sm:text-[26px]">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "How it works" button in the bottom-left corner, placed by globals.css (`.to-corner`). Phones use the menu entry instead. */
export function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="to-corner float press fixed z-40 flex h-10 items-center rounded-full px-4 text-[13.5px] font-semibold text-ink"
      >
        How it works
      </button>
      <HowItWorksModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The modal, also opened from the phone menu. On phones it's laid out tighter, with a Got it button, to fit a 360×780 screen. */
export function HowItWorksModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label="How it works" width={540}>
      {/* On a phone the title sits level with the Close button, just under the grabber. */}
      <div className="flex flex-col gap-4 px-6 pt-0.5 pb-5 sm:gap-6 sm:px-8 sm:pt-8 sm:pb-8">
        <div className="flex flex-col gap-1.5 pr-10">
          <p className="display text-[28px] leading-tight font-semibold text-ink">How it works</p>
          <p className="text-[15px] leading-relaxed text-ink-muted max-sm:hidden">What happens after you type your trip.</p>
        </div>
        <ol className="flex flex-col border-t border-rule">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-4 border-b border-rule py-2.5 sm:py-4">
              <span className="nums mt-px shrink-0 text-[13px] font-semibold text-ink-muted">0{i + 1}</span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[15.5px] font-semibold tracking-[-0.01em] text-ink">{s.title}</span>
                <span className="text-[14px] leading-snug text-ink-muted sm:text-[14.5px] sm:leading-relaxed">{s.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <Totals open={open} />
        <p className="rounded-2xl bg-soft px-4 py-3 text-[13.5px] leading-normal text-ink-soft sm:py-3.5 sm:leading-relaxed">
          {HOW}{" "}
          {/* Reachable from every page, so the privacy policy is always one click away. */}
          <Link href="/privacy" onClick={onClose} className="font-semibold whitespace-nowrap text-ink underline underline-offset-2">
            How your data is used
          </Link>
        </p>
        <Button variant="primary" size="md" className="w-full sm:hidden" onClick={onClose}>
          Got it
        </Button>
      </div>
    </Modal>
  );
}
