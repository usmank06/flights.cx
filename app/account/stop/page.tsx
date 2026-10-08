import type { Metadata } from "next";
import { StopTracking } from "@/components/watch/stop-tracking";
import { store } from "@/lib/store";
import { routeOf, tripWords } from "@/lib/watch/alert";
import { watchStore } from "@/lib/watch/store";
import { stopTokenValid } from "@/lib/watch/stop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Stop tracking", robots: { index: false } };

/** Target of an alert's "Stop tracking" link. Needs no sign-in; the page stops the watch once it opens (lib/watch/stop.ts). */
export default async function StopPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const id = typeof q.w === "string" ? q.w : "";
  const token = typeof q.t === "string" ? q.t : "";
  const valid = stopTokenValid(id, token);
  const watch = valid ? await (await watchStore()).get(id) : null;
  const record = watch ? await (await store()).get(watch.slug) : null;
  const trip = record ? [routeOf(record.request), ...tripWords(record.request)].join(", ") : null;
  return <StopTracking id={id} token={token} state={!valid ? "invalid" : watch ? "tracking" : "gone"} trip={trip} slug={watch?.slug ?? null} />;
}
