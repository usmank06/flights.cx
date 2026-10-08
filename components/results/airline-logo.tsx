"use client";

import { logoUrl } from "@/lib/flights/provider-config";
import { useBrokenImage } from "@/components/ui/use-broken-image";

/**
 * Airline logos by IATA code from the flight provider, falling back to a monogram when there's no logo or the image fails.
 * Uses <img> instead of next/image: the optimizer would spend image quota on a 70px PNG, and the fallback needs onError.
 */

const started = new Set<string>();

/** Prefetches these carriers' logos so the cards find them cached. Browser only; idempotent. */
export function preloadLogos(codes: Iterable<string>): void {
  if (typeof window === "undefined") return;
  for (const code of codes) {
    const src = /^[A-Z0-9]{2}$/.test(code) && !started.has(code) ? logoUrl(code) : null;
    if (!src) continue;
    started.add(code);
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = src;
  }
}

export function Monogram({ code, size = 24 }: { code: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      className="nums flex shrink-0 items-center justify-center rounded-md bg-soft font-semibold text-ink-soft"
    >
      {code}
    </span>
  );
}

export function AirlineLogo({ code, name, size = 24, eager = false }: { code: string; name?: string; size?: number; eager?: boolean }) {
  const { broken, ref, onError } = useBrokenImage();
  const src = /^[A-Z0-9]{2}$/.test(code) ? logoUrl(code) : null;
  if (!src || broken) return <Monogram code={code} size={size} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a CDN PNG with an onError fallback; see the header comment
    <img
      ref={ref}
      src={src}
      alt={name ? `${name} logo` : `${code} logo`}
      width={size}
      height={size}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={onError}
      className="shrink-0 rounded-md bg-white object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * A leg's carriers: up to two logos side by side (overlapping would make a monogram look broken), and a "+N" pill under them
 * for the rest, so the group stays within the logos' width and isn't mistaken for a "+1 day" mark.
 */
export function AirlineLogos({ codes, names, size = 24, eager = false }: { codes: string[]; names?: string[]; size?: number; eager?: boolean }) {
  const shown = codes.slice(0, 2);
  const more = codes.length - shown.length;
  return (
    <span className="flex shrink-0 flex-col items-center gap-1">
      <span className="flex items-center gap-0.5">
        {shown.map((c, i) => (
          <AirlineLogo key={c} code={c} name={names?.[i]} size={size} eager={eager} />
        ))}
      </span>
      {more > 0 && (
        <span className="nums rounded-full bg-soft px-1.5 text-[10px] leading-[14px] font-semibold text-ink-soft" title={names?.slice(2).join(", ")}>
          +{more}
        </span>
      )}
    </span>
  );
}
