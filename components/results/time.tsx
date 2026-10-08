import { clockParts } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { dayMarkTitle, splitTime } from "./plan-meta";

/**
 * A flight time in the locale's clock format, with a smaller day period and a superscript day mark ("7:20 PM", "09:40⁺¹").
 * Input is 24-hour with an optional day offset ("19:20+1").
 */
export function Time({ value, locale, size = 20, className = "" }: { value: string; locale: string; size?: number; className?: string }) {
  const { time, plus } = splitTime(value);
  const c = clockParts(time, locale);
  const period = (side: "before" | "after") => <span className={cx("text-[0.62em] font-semibold", side === "before" ? "mr-[0.22em]" : "ml-[0.18em]")}>{c.period}</span>;
  return (
    <span className={cx("nums font-semibold whitespace-nowrap text-ink", className)} style={{ fontSize: size }}>
      {c.period && c.periodFirst && period("before")}
      {c.time}
      {c.period && !c.periodFirst && period("after")}
      {plus && (
        <sup className="ml-0.5 text-[0.55em] font-semibold text-ink-muted" title={dayMarkTitle(plus)}>
          {plus}
        </sup>
      )}
    </span>
  );
}
