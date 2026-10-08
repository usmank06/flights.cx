"use client";

import { cx } from "./primitives";

/** Segmented control: mutually exclusive options on a grey track, with the selected one on white. */
export function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full rounded-full bg-soft-strong/80 p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "press shrink-0 rounded-full font-semibold whitespace-nowrap",
              // 40px tall on phones to match chips.
              size === "sm" ? "h-7 px-3 text-[12.5px]" : "h-8 px-3.5 text-[13.5px] max-sm:h-10 max-sm:px-4",
              on ? "bg-paper text-ink shadow-sm" : "text-ink-muted hover:text-ink"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
