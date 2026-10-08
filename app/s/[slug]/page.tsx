import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { tripShape, typicalDurationMs } from "@/lib/metrics";
import { searchTitle } from "@/lib/search/titles";
import { MISSING_SEARCH_HEADER, store, withLiveness } from "@/lib/store";
import { SearchView } from "@/components/search/search-view";
import SearchNotFound from "./not-found";

export const dynamic = "force-dynamic";

/**
 * `withLiveness` turns a long-stale "running" record into an error so the page doesn't show endless progress.
 * Returns null without a lookup when proxy.ts has already found no such search.
 */
async function load(slug: string) {
  if ((await headers()).get(MISSING_SEARCH_HEADER)) return null;
  // The record is serialised into the HTML, so leave out the session rows.
  const record = await (await store()).getPublic(slug);
  return record ? withLiveness(record) : null;
}

/**
 * Rendered from the store so a share link serves real HTML with the results in it. The client view then streams a search
 * that is still running.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const record = await load(slug);
  if (!record) return { title: "Search not found", alternates: { canonical: null }, robots: { index: false, follow: false } };
  // The layout's template adds the site name. The price is in the search's own currency.
  const title = searchTitle(record);
  // No analysis means the search is running or failed, so use the site's description rather than claim flights were found.
  const description = record.analysis ?? "Flight search that checks the dates and airports you didn’t.";
  return {
    title,
    description,
    // Next replaces the layout's openGraph instead of merging it, so repeat siteName and url.
    openGraph: { title, description, type: "website", siteName: "flights.cx", url: `/s/${slug}` },
    twitter: { card: "summary_large_image", title, description },
    // A search is only for people who have its link, so keep it out of search engines.
    robots: { index: false, follow: false },
  };
}

export default async function SearchPage({ params }: { params: Promise<{ slug: string }> }) {
  const record = await load((await params).slug);
  if (!record) {
    // proxy.ts already set the 404 status, so render the full not-found page here instead of calling notFound().
    if ((await headers()).get(MISSING_SEARCH_HEADER)) return <SearchNotFound />;
    notFound();
  }
  // Typical duration of recent similar searches, for the progress screen's estimate.
  const estimate = record.status === "running" ? await typicalDurationMs(tripShape(record.request).openDestination) : null;
  return <SearchView initial={record} estimate={estimate} />;
}
