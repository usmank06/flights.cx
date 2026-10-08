"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, ChevronDown } from "lucide-react";
import { money } from "@/lib/format";
import { DEFAULT_HOURS, parseAmount, wholeTarget, type PriceWatch } from "@/lib/watch/types";
import { CurrencySign } from "@/components/site/currency-sign";
import { Button, Spinner } from "@/components/ui/primitives";
import { SignIn, useAccount } from "@/components/auth/account";
import { shownError } from "@/components/ui/errors";

/**
 * Price tracking: re-runs a search daily and emails when the price moves 5% or drops below a target. It needs an account because it
 * sends email, so signed-out travellers get an inline sign-in.
 */
export function useWatch(slug: string) {
  const { account } = useAccount();
  const [watch, setWatch] = useState<PriceWatch | null>(null);
  /**
   * Fetches without setting state. Returns `undefined` when unknown and `null` when not watching, so the page doesn't offer to start
   * a watch that already exists.
   */
  const fetchWatch = useCallback(async (): Promise<PriceWatch | null | undefined> => {
    if (!account) return null;
    try {
      // The server matches by trip, since re-runs and "Search again" get new slugs for the same trip.
      const res = await fetch(`/api/watch?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (!res.ok) return undefined;
      const data = await res.json();
      return (data.watch as PriceWatch | null) ?? null;
    } catch {
      return undefined;
    }
  }, [account, slug]);
  const reload = useCallback(async () => {
    const mine = await fetchWatch();
    if (mine !== undefined) setWatch(mine);
  }, [fetchWatch]);
  useEffect(() => {
    let live = true;
    void fetchWatch().then((mine) => {
      if (live && mine !== undefined) setWatch(mine);
    });
    return () => {
      live = false;
    };
  }, [fetchWatch]);
  return { watch, setWatch, reload };
}

export function WatchPrice({
  slug,
  best,
  currency,
  locale,
  state,
  onDone,
}: {
  slug: string;
  best: number;
  currency: string;
  locale: string;
  state: ReturnType<typeof useWatch>;
  onDone: () => void;
}) {
  const { account, loading, refresh } = useAccount();
  const { watch, setWatch, reload } = state;
  // The action in flight, so the spinner shows on the pressed button.
  const [busy, setBusy] = useState<"start" | "stop" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"move" | "target">("move");
  const [target, setTarget] = useState("");

  async function create() {
    setBusy("start");
    setError(null);
    try {
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          everyHours: DEFAULT_HOURS,
          trigger: mode === "target" ? { kind: "target", price: parseAmount(target) } : { kind: "move", percent: 5 },
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        // Signed out elsewhere or the session expired: refresh so the sign-in replaces the form.
        await refresh();
      }
      if (!res.ok) throw new Error(data?.error ?? "Couldn’t start tracking this price");
      setWatch(data.watch);
    } catch (e) {
      setError(shownError(e, "Couldn’t start tracking this price. Try again in a moment."));
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    if (!watch) return;
    setBusy("stop");
    setError(null);
    try {
      const res = await fetch(`/api/watch/${watch.id}`, { method: "DELETE" });
      // 401: the session ended and the watch is still running, so show the sign-in.
      if (res.status === 401) await refresh();
      // 404: already gone, which counts as stopped.
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Couldn’t stop tracking this price");
      }
      setWatch(null);
    } catch (e) {
      setError(shownError(e, "Couldn’t stop tracking this price. Try again in a moment."));
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    if (!watch) return;
    setBusy("resume");
    setError(null);
    try {
      const res = await fetch(`/api/watch/${watch.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      const data = await res.json();
      if (res.status === 401) await refresh();
      if (!res.ok) throw new Error(data?.error ?? "Couldn’t resume tracking");
      setWatch(data.watch);
    } catch (e) {
      setError(shownError(e, "Couldn’t resume tracking. Try again in a moment."));
    } finally {
      setBusy(null);
    }
  }

  const heading = (title: string, sub: string) => (
    <div className="flex flex-col gap-1.5 pr-10">
      <p className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">{title}</p>
      <p className="text-[14.5px] leading-relaxed text-ink-muted">{sub}</p>
    </div>
  );

  if (loading)
    return (
      <div className="flex justify-center py-10 text-ink-muted">
        <Spinner className="h-5 w-5" />
      </div>
    );

  if (!account)
    return (
      <SignIn
        reason="Sign in to get an email when the price changes."
        onDone={() => {
          setError(null);
          void reload();
        }}
      />
    );

  if (watch) {
    // Paused from the account page. The scheduler skips it, so don't call it tracked.
    const paused = watch.status === "paused";
    return (
      <div className="flex flex-col gap-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {paused ? <Bell className="h-6 w-6" strokeWidth={1.9} /> : <BellRing className="h-6 w-6" strokeWidth={1.9} />}
        </div>
        {paused
          ? heading("Price tracking is paused", "We won’t check this trip or email you until you resume.")
          : heading("You’re tracking this price", `We check every day and email you ${alertWords(watch.trigger, watch.currency, watch.locale)}.`)}
        {/* On phones Resume spans the full width above an even pair, so nothing overflows at 360px. */}
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {paused && (
            <Button variant="primary" onClick={() => void resume()} disabled={busy != null} busy={busy === "resume"} className="max-sm:col-span-2 max-sm:w-full">
              Resume
            </Button>
          )}
          <Button variant="secondary" onClick={() => void stop()} disabled={busy != null} busy={busy === "stop"} className="max-sm:w-full">
            Stop tracking
          </Button>
          <Button variant="soft" onClick={onDone} className="max-sm:w-full">
            Done
          </Button>
        </div>
        {error && <p className="text-[13.5px] text-warn">{error}</p>}
      </div>
    );
  }

  // Integer units, as the server stores it (lib/watch/types.ts), so page and route agree on "below today's price".
  const price = wholeTarget(parseAmount(target) ?? 0);
  const tooHigh = mode === "target" && price > 0 && price >= best;
  // The server swaps a target that isn't below today's price for a change alert, so don't send one.
  const noTarget = mode === "target" && !(price > 0 && price < best);
  const field = "nums h-11 rounded-xl bg-soft px-3 text-[15px] text-ink outline-none focus:bg-paper focus:ring-2 focus:ring-accent pointer-coarse:text-[16px]";
  return (
    <div className="flex flex-col gap-5">
      {heading("Track prices", `It’s ${money(best, currency, locale)} now. We’ll check every day and email you when it changes.`)}
      <div className="flex flex-col gap-2">
        <label htmlFor={`alert-${slug}`} className="text-[13.5px] font-medium text-ink-soft">
          Email me when
        </label>
        <div className="relative">
          <select id={`alert-${slug}`} value={mode} onChange={(e) => setMode(e.target.value as "move" | "target")} className={`${field} w-full cursor-pointer appearance-none pr-10`}>
            <option value="move">The price changes by 5% or more</option>
            <option value="target">The price drops below an amount</option>
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 h-4 w-4 -translate-y-1/2 text-ink-muted" strokeWidth={2.2} />
        </div>
        {mode === "target" && (
          <div className={`${field} flex items-center gap-1.5 focus-within:bg-paper focus-within:ring-2 focus-within:ring-accent`}>
            <CurrencySign code={currency} className="text-ink-muted" />
            <input
              autoFocus
              inputMode="decimal"
              aria-label="Alert price"
              className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-muted"
              placeholder={String(Math.round(best * 0.9))}
              value={target}
              // Digits and separators only; parseAmount handles either decimal convention.
              onChange={(e) => setTarget(e.target.value.replace(/[^0-9.,\s '’]/g, "").slice(0, 14))}
            />
          </div>
        )}
        {tooHigh && <p className="text-[13.5px] text-warn">That’s not below today’s {money(best, currency, locale)}. Enter a lower price.</p>}
      </div>
      <Button variant="primary" size="md" onClick={() => void create()} disabled={busy != null || noTarget} busy={busy === "start"} className="w-full">
        {busy === "start" ? "Starting…" : "Track prices"}
      </Button>
      {error && <p className="text-[13.5px] text-warn">{error}</p>}
    </div>
  );
}

/** The alert condition as text, e.g. "when the price drops below $550", for the dialog and the account page. */
export function alertWords(trigger: PriceWatch["trigger"], currency: string, locale: string): string {
  return trigger.kind === "target" ? `when the price drops below ${money(trigger.price, currency, locale)}` : `when the price changes by ${trigger.percent}% or more`;
}
