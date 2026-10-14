import type { Metadata } from "next";
import { CloudBand } from "@/components/site/cloud-band";
import { SiteHeader } from "@/components/site/header";
import { HowItWorks } from "@/components/site/how-it-works";
import { StatsView, type Day } from "@/components/stats/stats-view";
import { metrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unlisted: reachable by its address only, so no index, no sitemap entry and no link from the site. */
export const metadata: Metadata = {
  title: "Numbers",
  description: "How flights.cx is doing, by day.",
  robots: { index: false, follow: false },
};

const DAY_MS = 86_400_000;
const FIRST_DAY = "2026-09-24";

/** The daily rollups summed across trip shapes, one row per calendar day with zeros where nothing happened. */
async function days(): Promise<Day[]> {
  const to = new Date().toISOString().slice(0, 10);
  const rows = await (await metrics()).rollups(FIRST_DAY, to);
  const byDay = new Map<string, Day>();
  for (let t = Date.parse(`${FIRST_DAY}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, { day, searches: 0, completed: 0, failed: 0, durationMs: 0, costUsd: 0 });
  }
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.searches += r.searches;
    d.completed += r.completed;
    d.failed += r.failed;
    d.durationMs += r.sumDurationMs;
    d.costUsd += r.sumModelCostUsd;
  }
  return [...byDay.values()];
}

/** The numbers page: the same chrome as every inner page, the day-by-day counts in the middle. Nothing here names a trip or a person. */
export default async function Stats() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-ground">
      <CloudBand className="h-[240px] sm:h-[300px]" />
      <SiteHeader />
      <HowItWorks />
      <main id="main" className="mx-auto w-full max-w-[920px] flex-1 px-5 pt-10 pb-24 sm:pt-12">
        <h1 className="display text-[36px] leading-[1.05] font-semibold text-ink sm:text-[50px]">Numbers</h1>
        <StatsView days={await days()} />
      </main>
    </div>
  );
}
