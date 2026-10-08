import { currencyOf } from "@/lib/currencies";

/** A currency's symbol, drawn as SVG for signs most fonts lack (the riyal and dirham). */
export function CurrencySign({ code, className = "" }: { code: string; className?: string }) {
  const c = currencyOf(code);
  if (c?.svg)
    return (
      <svg viewBox={c.svg.viewBox} aria-label={c.code} role="img" fill="currentColor" className={`inline-block h-[0.8em] w-auto align-[-0.05em] ${className}`}>
        {c.svg.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    );
  return <span className={className}>{c?.symbol ?? code.toUpperCase()}</span>;
}
