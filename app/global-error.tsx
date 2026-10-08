"use client";

import { useEffect } from "react";
import { reportClientError } from "@/components/site/report-error";

/** Shown when the root layout fails. Uses inline styles since no stylesheet can be assumed. Try again refetches via `retry`. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => reportClientError(error, "root layout", error.digest), [error]);
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · flights.cx</title>
      </head>
      <body style={{ margin: 0, fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", background: "#fff", color: "#0f1217" }}>
        {/* dvh, since 100vh is taller than the visible area while a phone's toolbar shows. */}
        <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          <p style={{ color: "#955200", fontWeight: 600, margin: 0 }}>Something went wrong</p>
          <h1 style={{ fontSize: 32, letterSpacing: "-0.03em", margin: "8px 0 0" }}>flights.cx didn’t load.</h1>
          <p style={{ color: "#5d636e", maxWidth: 420, lineHeight: 1.6 }}>Try it again. If you were in the middle of a search, it is still running.</p>
          <button onClick={() => retry()} style={{ marginTop: 16, height: 48, padding: "0 24px", borderRadius: 999, border: 0, background: "#1a5ae0", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
