/**
 * Sends browser errors to /api/errors, except ones from wallet extensions. Each message is sent once per page load, up to five
 * in total, so an error loop can't flood the log.
 */
const sent = new Set<string>();
const MAX_PER_PAGE = 5;

/**
 * Crypto wallet extensions (including Brave's) inject a script that sets `window.ethereum.selectedAddress` and throws when no
 * wallet is set up. The site never uses either, so errors mentioning them come from the wallet.
 */
export const fromWallet = (message: string): boolean => /\bethereum\b|\bselectedAddress\b/.test(message);

export function reportClientError(error: unknown, where: string, digest?: string): void {
  try {
    const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "A non-error was thrown");
    if (fromWallet(e.message)) return;
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
