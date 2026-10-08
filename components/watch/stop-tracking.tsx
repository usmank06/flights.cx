"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BellOff, CircleAlert } from "lucide-react";
import { SiteHeader } from "@/components/site/header";
import { CloudBand } from "@/components/site/cloud-band";
import { Button, Spinner, buttonClass } from "@/components/ui/primitives";

type State = "tracking" | "stopping" | "stopped" | "gone" | "invalid" | "failed";

/**
 * The page behind an alert email's "Stop tracking" link. It stops the watch with its own POST on load, since mail scanners open every
 * link and opening the link alone must not stop anything.
 */
export function StopTracking({ id, token, state: initial, trip, slug }: { id: string; token: string; state: "tracking" | "gone" | "invalid"; trip: string | null; slug: string | null }) {
  const [state, setState] = useState<State>(initial);
  const started = useRef(false);

  const stop = useCallback(async () => {
    setState("stopping");
    try {
      const res = await fetch(`/api/watch/stop?w=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.status === 403) return setState("invalid");
      if (!res.ok) throw new Error();
      setState("stopped");
    } catch {
      setState("failed");
    }
  }, [id, token]);

  useEffect(() => {
    if (initial !== "tracking" || started.current) return;
    started.current = true;
    void stop();
  }, [initial, stop]);

  const words: Record<State, { title: string; body: string }> = {
    tracking: { title: "Stopping your price alert…", body: trip ?? "" },
    stopping: { title: "Stopping your price alert…", body: trip ?? "" },
    stopped: { title: "You’ve stopped tracking this price", body: `${trip ? `${trip}. ` : ""}We won’t check it or email you about it again.` },
    gone: { title: "You’re not tracking this price any more", body: "There’s nothing left to stop. Your other price alerts are on Your trips." },
    invalid: { title: "This link doesn’t work", body: "It may not have been copied in full. Sign in on Your trips to see and stop your price alerts." },
    failed: { title: "We couldn’t stop it", body: "Give it a moment and try again." },
  };
  const { title, body } = words[state];
  const busy = state === "tracking" || state === "stopping";

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <SiteHeader />
      <main className="relative isolate mx-auto flex w-full max-w-[560px] flex-col px-4 pt-10 pb-16 sm:px-7 sm:pt-20">
        <section className="slip flex flex-col gap-5 rounded-[28px] p-6 sm:p-8" aria-live="polite">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            {busy ? <Spinner className="h-5 w-5" /> : state === "failed" || state === "invalid" ? <CircleAlert className="h-6 w-6" strokeWidth={1.9} /> : <BellOff className="h-6 w-6" strokeWidth={1.9} />}
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="display text-[28px] leading-tight font-semibold text-ink">{title}</h1>
            {body && <p className="text-[15px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]">{body}</p>}
          </div>
          {!busy && (
            <div className="flex flex-wrap gap-2">
              {state === "failed" ? (
                <Button variant="primary" size="md" onClick={() => void stop()} className="max-sm:w-full">
                  Try again
                </Button>
              ) : (
                <Link href="/account" className={buttonClass("primary", "md", "max-sm:w-full")}>
                  Your trips
                </Link>
              )}
              {state === "stopped" && slug && (
                <Link href={`/s/${slug}`} className={buttonClass("secondary", "md", "max-sm:w-full")}>
                  See the trip
                </Link>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
