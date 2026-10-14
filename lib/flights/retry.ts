import type { CallOptions } from "./backend";
import { FlightsError } from "./errors";

/** How a provider asks again: asks per call, and the pause after a failed one, which grows with each. */
export type Retry = { asks: number; askAgainMs: number };

/** A pause the signal cuts short. */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const stop = () => (clearTimeout(t), done());
    const t = setTimeout(() => (signal?.removeEventListener("abort", stop), done()), ms);
    signal?.addEventListener("abort", stop, { once: true });
  });

export const asFlightsError = (e: unknown): FlightsError => (e instanceof FlightsError ? e : new FlightsError("HTTP_ERROR", (e as Error)?.message ?? String(e)));

/**
 * Runs a provider call until it answers or `opts.signal` stops it. It makes up to `retry.asks` asks with a growing pause
 * between them, counts each one (`onAsk`) and reports each failure before the next ask (`onRetry`). Throws the last failure
 * as a FlightsError whose message says how many asks were made. Every provider's calls go through this or do the same
 * (lib/flights/backend.ts).
 */
export async function asked<T>(call: (signal?: AbortSignal) => Promise<T>, retry: Retry, opts: CallOptions = {}): Promise<T> {
  const { signal } = opts;
  let last: FlightsError | null = null;
  let made = 0;
  for (let ask = 1; ask <= retry.asks && !signal?.aborted; ask++) {
    made++;
    opts.onAsk?.();
    try {
      return await call(signal);
    } catch (e) {
      last = asFlightsError(e);
      if (signal?.aborted) break;
      // No pause after the last ask, since it would only hold up the caller.
      if (ask < retry.asks) {
        opts.onRetry?.(last);
        await pause(retry.askAgainMs * ask, signal);
      }
    }
  }
  if (signal?.aborted) throw new FlightsError("TIMEOUT", made ? `stopped after ${made} ask${made === 1 ? "" : "s"}` : "stopped before it was asked");
  throw new FlightsError(last?.kind ?? "NO_PAYLOAD", `no answer after ${made} asks (${last?.message ?? "no detail"})`);
}
