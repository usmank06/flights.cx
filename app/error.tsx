"use client";

import { Component, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { SiteHeader } from "@/components/site/header";
import { CloudBand } from "@/components/site/cloud-band";
import { HowItWorks } from "@/components/site/how-it-works";
import { reportClientError } from "@/components/site/report-error";

/** Renders nothing if its children throw, so a broken header or corner doesn't take the error page down too. */
class UnlessBroken extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    return this.state.broken ? null : this.props.children;
  }
}

/**
 * Shown when a page fails to render, with the same chrome as the 404 pages. A running search continues on the server.
 * Try again calls `retry`, which refetches from the server first, since `reset` alone would re-render the same failure.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    reportClientError(error, "error page", error.digest);
  }, [error]);
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      {/* Replaces a title that may have failed too, or may still name the search. */}
      <title>Something went wrong · flights.cx</title>
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <UnlessBroken>
        <SiteHeader />
      </UnlessBroken>
      <UnlessBroken>
        <HowItWorks />
      </UnlessBroken>
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-2.5 py-5 text-center sm:px-5 sm:py-16">
        <div className="flex w-full flex-col items-center px-3 py-8 sm:py-14">
          <p className="text-[15px] font-semibold text-warn">Something went wrong</p>
          <h1 className="display mt-2 text-[34px] leading-[1.04] font-semibold text-balance text-ink sm:text-[50px]">This page didn’t load properly.</h1>
          <p className="mt-4 max-w-[30rem] text-[16px] leading-relaxed text-pretty text-ink-muted">
            Try it again. If you were in the middle of a search, it is still running, and its link will show the results.
          </p>
          <div className="mt-7 flex w-full max-w-[17rem] flex-col items-stretch gap-3 sm:mt-8 sm:w-auto sm:max-w-none sm:flex-row sm:items-center">
            <button type="button" onClick={() => retry()} className="btn-primary press inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-semibold">
              <RotateCw className="h-4 w-4" strokeWidth={2.4} />
              Try again
            </button>
            <Link href="/" className="float press inline-flex h-12 items-center justify-center rounded-full px-6 text-[15px] font-semibold text-ink">
              Start a search
            </Link>
          </div>
          {error.digest && <p className="nums mt-8 text-[12px] text-ink-muted">Reference {error.digest}</p>}
        </div>
      </main>
    </div>
  );
}
