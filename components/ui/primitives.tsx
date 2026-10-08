"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, Loader2, Minus, Plus } from "lucide-react";

/** Join class names, dropping the falsy ones. */
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/**
 * Button variants: primary for the main action (Search, Book), secondary for other actions (Share, Track prices), soft for
 * options inside a panel, and ghost for low-emphasis text buttons.
 */
type Variant = "primary" | "secondary" | "soft" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "float text-ink",
  soft: "bg-soft text-ink hover:bg-soft-strong",
  ghost: "text-ink-soft hover:bg-soft hover:text-ink",
};
const SIZE: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13.5px] gap-1.5",
  md: "h-11 px-5 text-[14.5px] gap-2",
  lg: "h-14 px-7 text-[16px] gap-2.5",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra = "") {
  return cx(
    "press inline-flex shrink-0 items-center justify-center rounded-full font-semibold whitespace-nowrap disabled:cursor-default disabled:opacity-50",
    VARIANT[variant],
    SIZE[size],
    extra
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  busy = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean }) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {busy && <Loader2 className="spin h-4 w-4" strokeWidth={2.4} aria-hidden />}
      {children}
    </button>
  );
}

/** Round icon-only button. `label` sets its accessible name and tooltip. */
export function IconButton({
  label,
  children,
  className = "",
  size = 40,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cx("press inline-flex shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-soft hover:text-ink", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 className={cx("spin", className)} strokeWidth={2.4} aria-hidden />;
}

/** A small label, for a group heading inside a panel. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-[13px] font-medium text-ink-muted", className)}>{children}</p>;
}

/** Number input with minus and plus buttons (travellers, bags). The value is announced as it changes. */
export function Stepper({
  label,
  hint,
  value,
  onChange,
  min = 0,
  max = 9,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  // 44px touch targets on phones.
  const btn =
    "press flex h-9 w-9 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-full ring-1 ring-rule-strong text-ink hover:bg-soft disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[14.5px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[12.5px] text-ink-muted">{hint}</span>}
      </div>
      <div className="flex items-center gap-3 max-sm:gap-2">
        <button type="button" className={btn} aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
          <Minus className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
        <span className="nums w-4 text-center text-[15px] font-semibold" aria-live="polite">
          {value}
        </span>
        <button type="button" className={btn} aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

/** Styled checkbox with a label, backed by a visually hidden native input. */
export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[14px] font-medium text-ink-soft max-sm:min-h-11">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-paper ring-[1.5px] ring-rule-strong transition-colors duration-150 peer-checked:bg-accent peer-checked:ring-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
        <Check className={cx("h-3.5 w-3.5 text-white transition-opacity duration-150", checked ? "opacity-100" : "opacity-0")} strokeWidth={3} />
      </span>
      {children}
    </label>
  );
}

export const fieldClass =
  "h-12 w-full rounded-2xl bg-soft px-4 text-[15px] text-ink outline-none ring-1 ring-transparent transition-[background-color,box-shadow] duration-200 placeholder:text-ink-muted focus:bg-paper focus:ring-2 focus:ring-accent";
