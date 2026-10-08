"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellRing, Check, Link2, PenLine, RotateCw } from "lucide-react";
import { remember, rememberWords, wordsFor } from "@/lib/history";
import { stamp } from "@/lib/format";
import type { SearchRecord } from "@/lib/types";
import { Button, cx, Spinner } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlay";
import { useNowMinute } from "@/components/ui/use-now";
import { rerunSearch } from "@/components/search/search-client";
import { useCurrency } from "@/components/site/currency";
import { WatchPrice, type useWatch } from "@/components/watch/watch-price";
import { trackable } from "@/lib/watch/types";
import { shownError } from "@/components/ui/errors";
import { scrollMotion } from "./follow-ups";

/**
 * Rail row style (elsewhere these buttons are chips). Icon and label line up with the Date grid and price rows
 * (10px in, 10px apart); the longhand padding and gap override the Button's own.
 */
const railClass = "w-full justify-start rounded-xl pl-2.5 pr-2.5 gap-2.5 h-10 font-medium pointer-coarse:h-11";

/** Copies or shares the page link. Anyone with the link can view the search. */
export function ShareButton({ wide = false }: { wide?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy(button: HTMLButtonElement) {
    try {
      if (!wide && navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ url: window.location.href, title: document.title });
        return;
      }
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      // "Link copied" is wider than "Share" and can end up under the row's fade on a phone, so scroll it into view.
      if (!wide) requestAnimationFrame(() => button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollMotion() }));
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* dismissed or clipboard blocked; the link is still in the address bar */
    }
  }
  return (
    // Labelled on phones too; a bare link icon in the scrolling row reads as decoration.
    <Button variant={wide ? "ghost" : "secondary"} size="sm" onClick={(e) => void copy(e.currentTarget)} aria-live="polite" className={cx(wide ? railClass : "max-sm:h-10 pointer-coarse:h-10")}>
      {copied ? <Check className="h-4 w-4 text-good" strokeWidth={2.4} /> : <Link2 className="h-4 w-4" strokeWidth={2.2} />}
      <span>{copied ? "Link copied" : wide ? "Share this search" : "Share"}</span>
    </Button>
  );
}

/**
 * "Track prices": sets up daily price alerts in a dialog. Hidden once the trip is too close to track, unless a watch exists.
 * The page owns the watch state (`useWatch`) and passes it to both the rail and row buttons so they stay in sync.
 */
export function TrackButton({
  slug,
  best,
  departDate,
  currency,
  locale,
  state,
  wide = false,
}: {
  slug: string;
  best: number | null;
  departDate: string | null;
  currency: string;
  locale: string;
  state: ReturnType<typeof useWatch>;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // From the clock store: 0 on the server, so hydration matches and the button hides once the client knows the date.
  const now = useNowMinute();
  // A paused watch still exists but isn't checked, so it doesn't count as tracking.
  const on = state.watch?.status === "active";
  const paused = state.watch?.status === "paused";
  // The API refuses trips that leave before the next daily check, so hide the button unless a watch already exists.
  if (best == null || (now && !on && !paused && !trackable(departDate, now))) return null;
  return (
    <>
      <Button variant={wide ? "ghost" : "secondary"} size="sm" onClick={() => setOpen(true)} className={cx(on && "bg-soft text-ink", wide ? railClass : "max-sm:h-10 pointer-coarse:h-10")}>
        {on ? <BellRing className="h-4 w-4" strokeWidth={2.2} /> : <Bell className="h-4 w-4" strokeWidth={2.2} />}
        {on ? "Tracking prices" : paused ? "Tracking paused" : "Track prices"}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} label="Track prices" width={460} className="sm:mt-[max(0px,calc(50dvh-13rem))] sm:self-start">
        {/* Less top padding on phones, where the sheet's grabber sits above. */}
        <div className="px-6 pt-3 pb-6 sm:px-8 sm:pt-8 sm:pb-8">
          <WatchPrice slug={slug} best={best} currency={currency} locale={locale} state={state} onDone={() => setOpen(false)} />
        </div>
      </Modal>
    </>
  );
}

/** Reruns the request as a new search in the header's currency, so the original link keeps its results. */
function useRerun(slug: string) {
  const router = useRouter();
  const currency = useCurrency();
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function rerun() {
    setRerunning(true);
    setError(null);
    try {
      const next = await rerunSearch(slug, currency);
      remember(next);
      rememberWords(next, wordsFor(slug));
      router.push(`/s/${next}`);
    } catch (e) {
      setError(shownError(e, "We couldn’t start your search. Give it a moment and try again."));
      setRerunning(false);
    }
  }
  return { rerun, rerunning, error };
}

/** The rail's Edit search button. TripSummary owns the panel it opens. */
export function EditSearchButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className={railClass}>
      <PenLine className="h-4 w-4" strokeWidth={2.2} />
      Edit search
    </Button>
  );
}

/** The rail's Search again: current prices, as a new search. */
export function SearchAgainButton({ slug }: { slug: string }) {
  const { rerun, rerunning, error } = useRerun(slug);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => void rerun()} disabled={rerunning} className={railClass}>
        {rerunning ? <Spinner className="h-4 w-4" /> : <RotateCw className="h-4 w-4" strokeWidth={2.2} />}
        {rerunning ? "Starting…" : "Search again"}
      </Button>
      {error && <p className="px-1 text-[12.5px] text-warn">{error}</p>}
    </>
  );
}

/** The rail's price stamp, flagged in amber once it's a day or more old. Search again is the row below it. */
export function RailFreshness({ capturedAt, locale }: { capturedAt: string | null; locale: string }) {
  const now = useNowMinute();
  if (!capturedAt) return null;
  const hours = now ? Math.floor((now - Date.parse(capturedAt)) / 3_600_000) : null;
  const ago = hours == null ? "" : hours < 1 ? "just now" : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  return (
    <p className="nums px-2.5 pb-2 text-[12.5px] leading-snug text-ink-muted">
      Prices from <span className="whitespace-nowrap">{stamp(capturedAt, locale)}</span>
      {ago && <span className="whitespace-nowrap"> · {ago}</span>}
      {hours != null && hours >= 24 && <span className="block text-warn">Probably out of date</span>}
    </p>
  );
}

/**
 * When the prices were captured, with Search again: a quiet line from sm up, a stamp over full buttons on phones.
 * With `before` (a failed search's Edit search), both show as full buttons at every width, `before` first.
 */
export function Freshness({ record, before, railed = false }: { record: SearchRecord; before?: ReactNode; railed?: boolean }) {
  const { rerun, rerunning, error } = useRerun(record.slug);
  // The clock comes from a store so "3h ago" can't differ between server and client render.
  // The stamp uses the search's locale to match its prices.
  const now = useNowMinute();
  const { capturedAt, request } = record;
  const hours = now && capturedAt ? Math.floor((now - Date.parse(capturedAt)) / 3_600_000) : null;
  const stale = hours != null && hours >= 24;
  const ago = hours == null ? "" : hours < 1 ? "just now" : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;

  // Same format as the rail: stamp · how long ago.
  const full = now && capturedAt ? `Prices from ${stamp(capturedAt, request.locale)} · ${ago}` : "Prices from this search";
  return (
    <>
      {/* A quiet line; only the staleness warning is amber. */}
      {/* Hidden on lg when the rail shows RailFreshness instead. */}
      <p className={cx("nums flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-muted max-sm:hidden", before != null && "hidden", railed && "lg:hidden")}>
        {capturedAt && (
          <span>
            {full}
            {stale && <span className="text-warn"> · probably out of date</span>}
          </span>
        )}
        {/* Hidden on lg when the rail has its own Search again. */}
        <button
          type="button"
          onClick={() => void rerun()}
          disabled={rerunning}
          className={cx("press inline-flex items-center gap-1 rounded-full font-semibold text-accent hover:text-accent-ink disabled:opacity-60 pointer-coarse:min-h-11", railed && "lg:hidden")}
        >
          {rerunning ? <Spinner className="h-3 w-3" /> : <RotateCw className="h-3 w-3" strokeWidth={2.6} />}
          {rerunning ? "Starting…" : "Search again"}
        </button>
        {error && <span className="text-warn">{error}</span>}
      </p>
      {/* Phones, or a failed search at any width: a short stamp, full-size buttons, then the error. */}
      <div className={cx("flex flex-col items-start gap-3", before == null && "sm:hidden")}>
        {capturedAt && (
          <p className="nums text-[12.5px] text-ink-muted" title={full}>
            {now ? `Prices checked ${ago}` : "Prices from this search"}
            {stale && <span className="text-warn"> · probably out of date</span>}
          </p>
        )}
        {/* With `before`, phones stack both buttons full-width, `before` on top, instead of wrapping unevenly. */}
        <div className={cx("flex flex-wrap gap-2", before != null && "max-sm:w-full max-sm:flex-col")}>
          {before}
          <Button variant="secondary" size="md" onClick={() => void rerun()} disabled={rerunning} className={cx(before != null && "max-sm:w-full")}>
            {rerunning ? <Spinner className="h-4 w-4" /> : <RotateCw className="h-4 w-4" strokeWidth={2.2} />}
            {rerunning ? "Starting…" : "Search again"}
          </Button>
        </div>
        {error && <p className="text-[13px] text-warn">{error}</p>}
      </div>
    </>
  );
}

/** Shown when the header's currency differs from the search's, with a button to rerun in the header's currency. */
export function CurrencyNote({ slug, currency }: { slug: string; currency: string }) {
  const shown = useCurrency();
  const { rerun, rerunning, error } = useRerun(slug);
  if (shown === currency) return null;
  return (
    <p className="text-[13.5px] leading-relaxed text-ink-muted">
      These prices are in {currency}, the currency of this search.{" "}
      <button type="button" onClick={() => void rerun()} disabled={rerunning} className="font-semibold text-accent hover:underline disabled:opacity-60 pointer-coarse:min-h-11">
        {rerunning ? "Starting…" : `Search again in ${shown}`}
      </button>
      {error && <span className="text-warn"> {error}</span>}
    </p>
  );
}
