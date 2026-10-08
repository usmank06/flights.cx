import type { Metadata } from "next";
import { Missing } from "@/components/site/missing";

// A missing page has no canonical URL.
export const metadata: Metadata = { title: "Not found", alternates: { canonical: null } };

/** Generic 404. Missing searches have their own page in app/s/[slug]. */
export default function NotFound() {
  return <Missing title="This page flew somewhere else." body="The link may be old, or mistyped." />;
}
