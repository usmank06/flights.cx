"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Trash2 } from "lucide-react";
import { CABIN_LABEL, type SearchSummary } from "@/lib/types";
import { money } from "@/lib/format";
import { forget, keyFor, ownedSlugs, wordsFor } from "@/lib/history";
import { isOpenDestination } from "@/lib/search/intake";
import { placeShort } from "@/components/ask/replies";
import { rangeLabel } from "@/components/search/dates";
import { Button, cx } from "@/components/ui/primitives";
import { useAccount } from "@/components/auth/account";

/**
 * This browser's searches (slugs in localStorage) merged with the signed-in account's, newest first. Null until loaded.
 * Each row carries its own currency and locale, since searches can be priced in different currencies.
 */
export function useRecentSearches(): SearchSummary[] | null {
  const { account, loading } = useAccount();
  // Keyed by account, so the list refetches on sign-in or sign-out and an account's trips don't linger on a shared screen.
  const who = loading ? undefined : (account?.email ?? "");
  const [got, setGot] = useState<{ who: string; searches: SearchSummary[] } | null>(null);
  useEffect(() => {
    if (who === undefined) return;
    let live = true;
    const slugs = ownedSlugs();
    const fromBrowser: Promise<SearchSummary[]> = slugs.length
      ? fetch("/api/searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs }) })
          .then((r) => (r.ok ? r.json() : { searches: [] }))
          .then((d) => d.searches ?? [])
          .catch(() => [])
      : Promise.resolve([]);
    // Returns an empty list when signed out, so it's requested unconditionally.
    const fromAccount: Promise<SearchSummary[]> = fetch("/api/account/searches", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { searches: [] }))
      .then((d) => d.searches ?? [])
      .catch(() => []);
    Promise.all([fromBrowser, fromAccount])
      .then(([mine, theirs]) => {
        if (!live) return;
        // Deduped by slug: a search run in this browser while signed in is in both lists.
        const bySlug = new Map<string, SearchSummary>();
        for (const row of [...mine, ...theirs]) bySlug.set(row.slug, row);
        setGot({ who, searches: [...bySlug.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      })
      .catch(() => live && setGot({ who, searches: [] }));
    return () => {
      live = false;
    };
  }, [who]);
  // A list fetched for a different account reads as not loaded, so it disappears as soon as they sign out.
  return got && got.who === who ? got.searches : null;
}

/** A search's route label ("Chicago → anywhere", "Dallas → Lisbon or Porto"), falling back to its own words when it has no route. */
export function route(s: SearchSummary): string {
  const from = placeShort(s.from);
  // An open destination reads as a phrase ("→ somewhere warm"). Lowercase only its first letter so words like "March" keep their case.
  const label = placeShort(s.to);
  const to = isOpenDestination(s.to) ? (label ? label.charAt(0).toLowerCase() + label.slice(1) : "anywhere") : label;
  if (from) return `${from} → ${to}`;
  const words = wordsFor(s.slug)?.brief?.trim();
  if (words) return words.length > 40 ? `${words.slice(0, 38).replace(/\s+\S*$/, "")}…` : words;
  // Started on another device and stopped before planning: no route or words in this browser, so use the destination if it's a place.
  return to && !isOpenDestination(s.to) ? `A trip to ${to}` : "Untitled search";
}
export const when = (s: SearchSummary) => (s.departDate ? rangeLabel(s.departDate, s.returnDate, s.locale) : "Any dates");
const tones = { warn: "text-warn", ink: "font-semibold text-ink", muted: "text-ink-muted" } as const;
function status(s: SearchSummary): { text: string; price?: string; tone: "muted" | "warn" | "ink" } {
  if (s.status === "running") return { text: "searching…", tone: "muted" };
  // Same wording as the search page when a search ends with nothing to book.
  if (s.status === "error") return { text: "no flights to show", tone: "warn" };
  if (s.bestPrice != null) return { text: "from", price: money(s.bestPrice, s.currency, s.locale), tone: "ink" };
  return { text: "no flights found", tone: "muted" };
}

/** When a search ran: "today 9:40 AM", "Oct 5, 9:40 AM". */
function ranAt(s: SearchSummary): string {
  const d = new Date(s.createdAt);
  const time = d.toLocaleTimeString(s.locale, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `today ${time}` : `${d.toLocaleDateString(s.locale, { month: "short", day: "numeric" })}, ${time}`;
}

/** Run times by slug for searches that read the same in the list, so their rows can be told apart. */
function runsOf(list: SearchSummary[]): Map<string, string> {
  const same = (s: SearchSummary) => `${route(s)}|${when(s)}|${s.travellers}|${s.cabin}`;
  const counts = new Map<string, number>();
  for (const s of list) counts.set(same(s), (counts.get(same(s)) ?? 0) + 1);
  return new Map(list.filter((s) => (counts.get(same(s)) ?? 0) > 1).map((s) => [s.slug, ranAt(s)]));
}

/** The home page's three most recent, as pills under the first question. */
export function RecentPills() {
  const searches = useRecentSearches();
  if (!searches?.length) return null;
  const shown = searches.slice(0, 3);
  const runs = runsOf(shown);
  return (
    <div className="fade flex max-w-full flex-col gap-2.5">
      <p className="text-[13.5px] font-medium text-ink-muted">Or pick up where you left off</p>
      {/* Short screens get one sideways-scrolling row, faded at the right, so the pills don't push the question off screen. */}
      <ul className="no-scrollbar flex max-w-full flex-wrap gap-2 short:-mx-5 short:flex-nowrap short:overflow-x-auto short:px-5 short:[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)]">
        {shown.map((s) => {
          const st = status(s);
          return (
            <li key={s.slug} className="min-w-0 max-w-full short:shrink-0">
              {/* One line on a phone: the route truncates first and the dates are visually hidden. */}
              <Link
                href={`/s/${s.slug}`}
                className="float press flex h-10 max-w-full items-center gap-2.5 rounded-full px-4 text-[13.5px]"
              >
                <span className="min-w-0 truncate font-semibold text-ink">{route(s)}</span>
                <span className="nums shrink-0 whitespace-nowrap text-ink-muted max-sm:sr-only">{when(s)}</span>
                {runs.has(s.slug) && <span className="nums shrink-0 whitespace-nowrap text-ink-muted">{runs.get(s.slug)}</span>}
                <span className={cx("shrink-0 whitespace-nowrap", st.tone === "warn" ? "text-warn" : st.tone === "ink" ? "font-medium text-ink" : "text-ink-muted")}>
                  {st.text}
                  {st.price && <span className="nums"> {st.price}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The account page's full list, ten rows at a time. Delete asks for a second press, then hides the search on the server (its link stops
 * working; the record stays for stats) and drops it from this browser's list.
 */
const STEP = 10;

export function RecentList({ searches }: { searches: SearchSummary[] }) {
  const [shown, setShown] = useState(STEP);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const live = searches.filter((s) => !gone.has(s.slug));
  const runs = runsOf(live);

  async function remove(slug: string) {
    setDeleting(slug);
    setFailed(null);
    const key = keyFor(slug);
    const res = await fetch(`/api/search/${slug}`, { method: "DELETE", headers: key ? { "x-owner-key": key } : {} }).catch(() => null);
    setDeleting(null);
    setConfirming(null);
    // 404: already deleted. 403: this browser can't prove ownership. Either way it leaves the list.
    if (res && (res.ok || res.status === 404 || res.status === 403)) {
      forget(slug);
      setGone((g) => new Set([...g, slug]));
    } else setFailed(slug);
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="slip flex flex-col divide-y divide-rule overflow-hidden rounded-3xl">
        {live.slice(0, shown).map((s) => {
          const st = status(s);
          const who = [s.travellers > 1 ? `${s.travellers} travelers` : null, s.cabin === "economy" ? null : CABIN_LABEL[s.cabin]].filter(Boolean);
          const asking = confirming === s.slug;
          return (
            // The row tints when its link is hovered, so the tint spans the delete button too.
            <li key={s.slug} className="flex flex-wrap items-center transition-colors has-[>a:hover]:bg-well">
              {/* The first and last links take the list's rounded corners so their focus rings follow the curve. */}
              <Link
                href={`/s/${s.slug}`}
                className={cx(
                  "group flex min-w-0 flex-1 items-center gap-3 py-4 pl-4 sm:gap-4 sm:pl-5 focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-tl-3xl [li:last-child>&]:rounded-bl-3xl",
                  asking && "max-sm:pr-4"
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="break-words text-[15px] font-semibold text-pretty text-ink sm:truncate">{route(s)}</span>
                  {/* On a phone the details wrap instead of truncating, with the price below them. */}
                  <span className="nums text-[13.5px] text-ink-muted sm:truncate">{[when(s), ...who, runs.get(s.slug)].filter(Boolean).join(" · ")}</span>
                  <span className={cx("text-[14px] sm:hidden", tones[st.tone])}>
                    {st.text}
                    {st.price && <span className="nums"> {st.price}</span>}
                  </span>
                  {failed === s.slug && <span className="text-[12.5px] text-warn">Couldn’t delete that just now. Try again in a moment.</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 max-sm:hidden">
                  <span className={cx("text-[14.5px]", tones[st.tone])}>
                    {st.text}
                    {st.price && <span className="nums"> {st.price}</span>}
                  </span>
                  {s.status === "done" && s.saved != null && s.saved > 0 && (
                    <span className="hidden text-[12.5px] font-medium text-good sm:block">
                      <span className="nums">{money(s.saved, s.currency, s.locale)}</span> under your dates
                    </span>
                  )}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-muted" strokeWidth={2} />
              </Link>
              {/* Outside the link, which can't contain a button. On a phone the confirmation takes its own line under the row. */}
              <span className={cx("flex shrink-0 items-center gap-1 pr-2 pl-1 sm:pr-3", asking && "max-sm:order-last max-sm:w-full max-sm:justify-end max-sm:pt-0 max-sm:pb-3")}>
                {asking ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void remove(s.slug)}
                      disabled={deleting === s.slug}
                      className="press flex h-9 items-center rounded-full px-3 text-[13.5px] font-semibold text-warn hover:bg-warn-soft disabled:opacity-60 pointer-coarse:h-11"
                    >
                      {deleting === s.slug ? "Deleting…" : "Delete"}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="press flex h-9 items-center rounded-full px-3 text-[13.5px] font-semibold text-ink-soft hover:bg-soft pointer-coarse:h-11">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(s.slug)}
                    aria-label={`Delete ${route(s)}, ${when(s)}`}
                    title="Delete this search"
                    className="press flex h-9 w-9 items-center justify-center rounded-full text-ink-faint hover:bg-soft hover:text-ink-soft pointer-coarse:h-11 pointer-coarse:w-11"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={2} />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {live.length > shown && (
        <Button variant="secondary" size="md" className="self-start" onClick={() => setShown((n) => n + STEP)}>
          Show more
        </Button>
      )}
    </div>
  );
}
