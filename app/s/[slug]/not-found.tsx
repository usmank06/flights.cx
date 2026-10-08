import type { Metadata } from "next";
import { Missing } from "@/components/site/missing";

export const metadata: Metadata = { title: "Search not found", alternates: { canonical: null } };

/** 404 for a missing search. The search page also renders it directly when proxy.ts has found no such search. */
export default function SearchNotFound() {
  return <Missing title="We couldn’t find that search." body="The link may be missing a letter. Searching again only takes a minute." />;
}
