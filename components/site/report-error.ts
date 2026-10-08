/**
 * Sends browser errors to /api/errors. Each message is sent once per page load, up to five in total, so an error loop
 * can't flood the log.
 */
const sent = new Set<string>();
const MAX_PER_PAGE = 5;

export function reportClientError(error: unknown, where: string, digest?: string): void {
  try {
    const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "A non-error was thrown");
    const key = `${where}|${e.message}`;
    if (sent.has(key) || sent.size >= MAX_PER_PAGE) return;
    sent.add(key);
    void fetch("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: e.message.slice(0, 1000), stack: e.stack?.slice(0, 4000) ?? null, where, page: location.pathname, digest: digest ?? null }),
      // Lets the request finish if the page unloads.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must not throw.
  }
}
