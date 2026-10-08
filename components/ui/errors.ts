/** User-facing error text: the message of a plain Error thrown by our code, else the fallback, so internal errors aren't shown. */
export function shownError(e: unknown, fallback: string): string {
  return e instanceof Error && e.constructor === Error && e.message.trim() ? e.message : fallback;
}
