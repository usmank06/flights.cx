"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { wordsFor } from "@/lib/history";
import type { PlanView, SearchRequest } from "@/lib/types";
import { SiteHeader } from "@/components/site/header";
import { CloudBand } from "@/components/site/cloud-band";
import { HowItWorks } from "@/components/site/how-it-works";
import { Conversation } from "@/components/ask/conversation";
import { draftFromRequest, type Draft } from "@/components/search/draft";
import { Scene } from "./scene";

/**
 * The home page: the first question over the animated sky, which fades once the conversation starts.
 * Statically rendered; `?from=<slug>` is read in the browser, and that search is fetched to prefill the conversation.
 */
export function Home() {
  const [prefill, setPrefill] = useState<{ slug: string; draft: Draft } | null>(null);
  // `data-still` disables overscroll bounce in globals.css so the header and questions don't get dragged.
  useEffect(() => {
    document.documentElement.dataset.still = "";
    return () => {
      delete document.documentElement.dataset.still;
    };
  }, []);
  // flow-root stops the pane's bottom margin collapsing through body, which would put the corner button on the pane's corner.
  return (
    <div className="relative isolate flow-root min-h-dvh bg-ground">
      {/* Below the animated scene; the same sky and clouds stay at the top of the page once the scene fades. */}
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <Conversation
        key={prefill?.slug ?? "new"}
        initial={prefill?.draft}
        header={(island) => <SiteHeader center={island} />}
        backdrop={<Scene />}
        corner={<HowItWorks />}
      />
      <Suspense fallback={null}>
        <FromLink onLoad={setPrefill} />
      </Suspense>
    </div>
  );
}

/** Reads `?from=` and passes back a draft prefilled from that search. Renders nothing. */
function FromLink({ onLoad }: { onLoad: (p: { slug: string; draft: Draft }) => void }) {
  const from = useSearchParams().get("from");
  useEffect(() => {
    if (!from) return;
    let live = true;
    fetch(`/api/search/${encodeURIComponent(from)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((record: { request?: SearchRequest; plan?: PlanView | null } | null) => {
        // If the search isn't found, this is a new search. Restores this browser's saved wording if any,
        // otherwise the request as the search understood it.
        if (live && record?.request) onLoad({ slug: from, draft: draftFromRequest({ ...record.request, ...wordsFor(from) }, record.plan?.understood) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [from, onLoad]);
  return null;
}
