"use client";

import { useBrokenImage } from "@/components/ui/use-broken-image";
import { countryCode, countryName } from "@/lib/countries";

/**
 * A country flag as an image, since Windows has no flag emoji glyphs. `country` is an ISO 3166-1 alpha-2 code or a country
 * name from the provider; an unknown name renders nothing.
 */
export function Flag({ country, size = 20, className = "" }: { country: string | null | undefined; size?: number; className?: string }) {
  const { broken, ref, onError } = useBrokenImage();
  const iso = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : countryCode(country);
  if (!iso) return null;
  const name = countryName(iso) ?? iso;
  if (broken)
    return (
      <span aria-label={name} className={`nums inline-flex shrink-0 items-center rounded-[3px] bg-soft px-1 text-[10px] font-semibold text-ink-soft ${className}`}>
        {iso}
      </span>
    );
  const h = Math.round(size * 0.75);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a CDN PNG with an onError fallback; see the header comment
    <img
      ref={ref}
      src={`https://flagcdn.com/w40/${iso.toLowerCase()}.png`}
      srcSet={`https://flagcdn.com/w80/${iso.toLowerCase()}.png 2x`}
      alt={name}
      title={name}
      width={size}
      height={h}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={onError}
      className={`inline-block shrink-0 rounded-[3px] object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.06)] ${className}`}
      style={{ width: size, height: h }}
    />
  );
}
