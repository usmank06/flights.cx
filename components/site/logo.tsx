import Link from "next/link";

/** The "flights.cx" wordmark, with the dot drawn in blue (globals.css `.wordmark`). */
export function Wordmark({ size = 19, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`wordmark relative inline-flex items-baseline ${className}`} style={{ fontSize: size }}>
      <span aria-hidden className="flex items-baseline">
        flights
        <span className="wordmark-dot" />
        <span className="text-ink-muted">cx</span>
      </span>
      <span className="sr-only">flights.cx</span>
    </span>
  );
}

/** Header home link. On phones an invisible inset span enlarges the tap target to 44px. */
export function Logo() {
  return (
    <Link href="/" aria-label="flights.cx, home" className="float press flex h-9 shrink-0 items-center rounded-full px-3.5">
      <span aria-hidden className="absolute -inset-1 sm:hidden" />
      <Wordmark size={17} />
    </Link>
  );
}
