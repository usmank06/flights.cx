"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { BellRing, CircleAlert, LogOut } from "lucide-react";
import { money, stamp } from "@/lib/format";
import { CABIN_LABEL, type SearchSummary } from "@/lib/types";
import type { PriceWatch } from "@/lib/watch/types";
import { Button, Spinner, buttonClass } from "@/components/ui/primitives";
import { useMedia } from "@/components/ui/use-media";
import { shownError } from "@/components/ui/errors";
import { SiteHeader } from "@/components/site/header";
import { CloudBand } from "@/components/site/cloud-band";
import { HowItWorks } from "@/components/site/how-it-works";
import { RecentList, route, useRecentSearches, when as tripDates } from "@/components/history/recent-searches";
import { alertWords } from "@/components/watch/watch-price";
import { SignIn, useAccount } from "./account";

const WATCHES_FAILED = "We couldn’t load your price alerts. Give it a minute and try again.";

type Watched = { list: PriceWatch[]; trips: Map<string, SearchSummary> };

/** "Your trips": this browser's searches, plus the account's searches from other devices and its price alerts when signed in. */
export function AccountView({ signedInAs = null }: { signedInAs?: string | null }) {
  const { account, loading, signOut } = useAccount();
  // The server-rendered email until the client session check finishes, so the subtitle is right on first paint.
  const email = loading ? signedInAs : (account?.email ?? null);
  const searches = useRecentSearches();
  const [watches, setWatches] = useState<Watched | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const narrow = useMedia("(max-width: 639px)");

  /** Doesn't set state, so callers can drop a stale result. Throws on failure so an outage isn't shown as "no alerts yet". */
  const fetchWatches = useCallback(async (): Promise<Watched | null> => {
    if (!account) return null;
    const r = await fetch("/api/watch", { cache: "no-store" });
    const w = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(w?.watches)) throw new Error("watches");
    const list = w.watches as PriceWatch[];
    const slugs = [...new Set(list.map((x) => x.slug))];
    // Load each watch's search so its row can show the route and dates.
    const found: SearchSummary[] = slugs.length
      ? await fetch("/api/searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs }) })
          .then((res) => (res.ok ? res.json() : { searches: [] }))
          .then((d) => d.searches ?? [])
          .catch(() => [])
      : [];
    return { list, trips: new Map<string, SearchSummary>(found.map((s) => [s.slug, s])) };
  }, [account]);

  const load = useCallback(async () => {
    try {
      const next = await fetchWatches();
      if (next) {
        setWatches(next);
        setWatchError(null);
      }
    } catch {
      setWatchError(WATCHES_FAILED);
    }
  }, [fetchWatches]);

  useEffect(() => {
    let live = true;
    fetchWatches().then(
      (next) => {
        if (!live || !next) return;
        setWatches(next);
        setWatchError(null);
      },
      () => {
        if (live) setWatchError(WATCHES_FAILED);
      }
    );
    return () => {
      live = false;
    };
  }, [fetchWatches]);

  const leave = async () => {
    setSignOutFailed(false);
    setSignOutFailed(!(await signOut()));
  };

  // `data-page-sign-in` lets the header's Sign in focus this form instead of opening a modal (header-account.tsx).
  const signIn = !loading && !account && (
    <section data-page-sign-in className="slip rounded-[28px] p-5 sm:p-8">
      <SignIn />
    </section>
  );
  // On phones with saved searches, list them above the sign-in card.
  const signInFirst = !narrow || searches?.length === 0;
  const signInLast = narrow && !!searches?.length;
  // Wait for both the session and the searches before rendering, so nothing shifts as they arrive.
  const ready = !loading && searches != null;

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <SiteHeader />
      <main className="relative isolate mx-auto mb-10 flex w-full max-w-[820px] flex-col gap-8 px-4 pt-8 pb-10 sm:mb-12 md:mb-24 sm:gap-12 sm:px-7 sm:pt-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="display text-[38px] leading-none font-semibold text-ink sm:text-[52px]">Your trips</h1>
            {/* Lets a long email address wrap so it can't widen the page. */}
            <p className="text-[15px] text-ink-muted [overflow-wrap:anywhere]">{email ? `Signed in as ${email}` : "Kept in this browser. Sign in to have them everywhere."}</p>
          </div>
          {/* Hidden on phones, where the menu has Sign out. */}
          {account && (
            <Button variant="secondary" size="sm" onClick={() => void leave()} className="max-sm:hidden">
              <LogOut className="h-4 w-4" strokeWidth={2} />
              Sign out
            </Button>
          )}
          {signOutFailed && (
            <p role="alert" className="step-in flex basis-full items-start gap-2.5 rounded-2xl bg-warn-soft px-4 py-3 text-[14px] leading-snug text-warn">
              <CircleAlert className="mt-px h-[17px] w-[17px] shrink-0" strokeWidth={2.2} />
              <span>We couldn’t sign you out. Try again.</span>
            </p>
          )}
        </header>

        {!ready && (
          <div className="flex justify-center py-8 text-ink-muted">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {ready && signInFirst && signIn}

        {ready && (
          <section className="flex flex-col gap-4">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Searches</h2>
            {searches == null ? null : searches.length === 0 ? (
              <>
                <div className="flex flex-col gap-3 sm:hidden">
                  <p className="text-[15px] text-ink-muted">Nothing yet.</p>
                  <Link href="/" className={buttonClass("primary", "md", "self-start")}>
                    Start a search
                  </Link>
                </div>
                <p className="slip rounded-3xl px-5 py-5 text-[15px] text-ink-muted max-sm:hidden">
                  Nothing yet.{" "}
                  <Link href="/" className="font-semibold text-accent hover:underline">
                    Search for a flight
                  </Link>{" "}
                  and it will show up here.
                </p>
              </>
            ) : (
              <RecentList searches={searches} />
            )}
          </section>
        )}

        {ready && signInLast && signIn}

        {ready && account && (
          <section id="alerts" className="flex scroll-mt-24 flex-col gap-4">
            <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Price alerts</h2>
            {watchError && (
              <p role="alert" className="rounded-2xl bg-warn-soft px-4 py-3 text-[14.5px] leading-relaxed text-warn">
                {watchError}
              </p>
            )}
            {watches == null ? (
              !watchError && (
                <div className="flex justify-center py-8 text-ink-muted">
                  <Spinner className="h-5 w-5" />
                </div>
              )
            ) : watches.list.length === 0 ? (
              <p className="slip rounded-3xl px-5 py-5 text-[15px] leading-relaxed text-ink-muted">No price alerts yet. Choose Track prices on a search to get one.</p>
            ) : (
              // On phones the alerts form one card of divided rows, like the searches list.
              <ul className="flex flex-col gap-3 max-sm:gap-0 max-sm:divide-y max-sm:divide-rule max-sm:overflow-hidden max-sm:rounded-3xl max-sm:bg-paper max-sm:ring-1 max-sm:ring-rule">
                {watches.list.map((w) => (
                  <WatchRow key={w.id} watch={w} trip={watches.trips.get(w.slug)} onChanged={load} narrow={narrow} />
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
      <HowItWorks />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="nums">
      <span className="text-ink-muted">{label}:</span> <span className="text-ink-soft">{children}</span>
    </span>
  );
}

function WatchRow({ watch, trip, onChanged, narrow }: { watch: PriceWatch; trip?: SearchSummary; onChanged: () => void; narrow: boolean }) {
  const { refresh } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watch/${watch.id}`, init);
      // Already removed (e.g. in another tab): reload the list.
      if (res.status === 404) {
        onChanged();
        return;
      }
      // Signed out elsewhere: refresh the session so the page shows Sign in.
      if (res.status === 401) await refresh();
      // The route's error message is written for users, so show it.
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "");
      onChanged();
    } catch (e) {
      setError(shownError(e, "That didn’t work. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };
  const was = money(watch.referencePrice, watch.currency, watch.locale);
  // Show the traveller count when above one and the cabin when not economy, as the searches list does.
  const dates = trip?.departDate ? [tripDates(trip), trip.travellers > 1 ? `${trip.travellers} travelers` : null, trip.cabin !== "economy" ? CABIN_LABEL[trip.cabin] : null].filter(Boolean).join(" · ") : null;
  const alert = watch.status === "paused" ? "Paused" : watch.status === "ended" ? "Ended" : alertWords(watch.trigger, watch.currency, watch.locale).replace(/^when the price /, "").replace(/^./, (c: string) => c.toUpperCase());
  const checked = watch.lastRunAt ? stamp(watch.lastRunAt, watch.locale) : "not yet";
  const told = watch.lastNotifiedPrice != null ? `${money(watch.lastNotifiedPrice, watch.currency, watch.locale)}${watch.lastNotifiedAt ? `, ${stamp(watch.lastNotifiedAt, watch.locale)}` : ""}` : null;
  return (
    <li className="slip flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-3xl px-5 py-4 max-sm:rounded-none max-sm:px-4 max-sm:shadow-none">
      {/* Hidden on phones to save width. The heading already says these are alerts. */}
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent max-sm:hidden">
        <BellRing className="h-5 w-5" strokeWidth={1.9} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* 44px touch target on coarse pointers. Negative margins keep the layout unchanged. */}
        <Link href={`/s/${watch.slug}`} className="self-start text-[15px] font-semibold text-ink hover:underline pointer-coarse:-my-[11px] pointer-coarse:py-[11px]">
          {trip ? route(trip) : `A trip at ${was}`}
        </Link>
        <span className="flex flex-col gap-0.5 text-[13.5px] text-ink-muted">
          <span className="flex flex-wrap gap-x-4 gap-y-0.5">
            {dates && <Fact label="Dates">{dates}</Fact>}
            <Fact label="Price when tracked">{was}</Fact>
          </span>
          <span className="flex flex-wrap gap-x-4 gap-y-0.5">
            <Fact label="Alert">{alert}</Fact>
            <Fact label="Last checked">{checked}</Fact>
            {told && <Fact label="Last alert">{told}</Fact>}
          </span>
        </span>
        {watch.status === "ended" && watch.endedReason && <span className="text-[13px] text-warn">{watch.endedReason}</span>}
      </span>
      {/* On phones the buttons get their own line, so the trip text isn't squeezed, and become 44px secondary buttons. */}
      <span className="flex items-center gap-1 max-sm:basis-full max-sm:gap-2 max-sm:pt-1">
        {watch.status !== "ended" && (
          <Button
            variant={narrow ? "secondary" : "ghost"}
            size="sm"
            className="max-sm:h-11"
            disabled={busy}
            onClick={() =>
              void act({
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: watch.status === "active" ? "paused" : "active" }),
              })
            }
          >
            {watch.status === "active" ? "Pause" : "Resume"}
          </Button>
        )}
        <Button variant={narrow ? "secondary" : "ghost"} size="sm" className="max-sm:h-11" disabled={busy} onClick={() => void act({ method: "DELETE" })}>
          Remove
        </Button>
      </span>
      {error && (
        <p role="alert" className="basis-full pl-[60px] text-[13px] text-warn max-sm:pl-0">
          {error}
        </p>
      )}
    </li>
  );
}
