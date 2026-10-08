"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "@/components/ui/primitives";
import { CURRENCIES, setCurrency, useCurrency } from "./currency";
import { CurrencySign } from "./currency-sign";

/**
 * Searchable currency list for the header popover and the phone menu sheet. In a sheet the search field (and `head`) stays
 * pinned while the sheet scrolls, avoiding a nested scroller.
 */
export function CurrencyList({
  onChosen,
  inSheet = false,
  autoFocus = false,
  head,
}: {
  onChosen: () => void;
  inSheet?: boolean;
  autoFocus?: boolean;
  /** Pinned above the field in a sheet, e.g. a button back to the menu. */
  head?: ReactNode;
}) {
  const currency = useCurrency();
  const [q, setQ] = useState("");
  const t = q.trim().toLowerCase();
  const shown = t ? CURRENCIES.filter((c) => c.code.toLowerCase().includes(t) || c.name.toLowerCase().includes(t) || (!!c.symbol && c.symbol === q.trim())) : CURRENCIES;
  const choose = (code: string) => {
    setCurrency(code);
    setQ("");
    onChosen();
  };
  const field = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  /** Arrow keys move between the search field and the rows. */
  const walk = (e: KeyboardEvent<HTMLElement>) => {
    const list = [...(rows.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" && at >= 0 ? 0 : e.key === "End" && at >= 0 ? list.length - 1 : null;
    if (to == null || !list.length) return;
    e.preventDefault();
    if (to < 0) field.current?.focus();
    else list[Math.min(to, list.length - 1)].focus();
  };
  // 16px on a touch screen: iOS zooms into any field set smaller.
  const input = (
    <input
      ref={field}
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && shown[0]) {
          // Stop the Enter from also clicking whatever takes focus next, which would reopen the list.
          e.preventDefault();
          choose(shown[0].code);
        } else if (e.key === "ArrowDown") walk(e);
      }}
      placeholder="Find a currency"
      aria-label="Find a currency"
      autoFocus={autoFocus}
      className="h-10 rounded-2xl bg-soft/90 px-3.5 text-[14px] text-ink outline-none placeholder:text-ink-muted focus:bg-paper focus:ring-2 focus:ring-accent pointer-coarse:text-[16px]"
    />
  );
  return (
    <div className="flex flex-col gap-1.5">
      {inSheet ? (
        // Below the sheet's Close button (z-10), above the rows. Without a head, the padding keeps the field clear of Close.
        <div className={cx("sticky top-0 z-[1] flex flex-col bg-paper pb-1.5", head ? "" : "pt-2 pr-12")}>
          {head}
          {input}
        </div>
      ) : (
        input
      )}
      {/* A group of buttons, since menu semantics would clash with the search field above. */}
      <div ref={rows} role="group" aria-label="Currencies" onKeyDown={walk} className={cx("flex flex-col", !inSheet && "max-h-[calc(100dvh-8rem)] overflow-y-auto")}>
        {shown.map((c) => {
          const on = c.code === currency;
          return (
            <button
              key={c.code}
              type="button"
              aria-current={on || undefined}
              onClick={() => choose(c.code)}
              className={cx(
                "press flex w-full items-center gap-3 rounded-xl px-2.5 text-left focus-visible:outline-offset-[-2px]",
                inSheet ? "py-2.5" : "py-2",
                on ? "bg-accent-soft" : "hover:bg-soft"
              )}
            >
              {/* Fixed width so the codes line up. Longer signs get a smaller font. */}
              <span
                className={cx(
                  "flex h-8 w-10 shrink-0 items-center justify-center rounded-lg font-semibold whitespace-nowrap",
                  [...(c.symbol ?? "")].length > 2 ? "text-[11px] tracking-[-0.02em]" : "text-[13.5px]",
                  on ? "bg-paper text-accent-ink" : "bg-soft text-ink-soft"
                )}
              >
                <CurrencySign code={c.code} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cx("nums text-[14px] font-semibold", on ? "text-accent-ink" : "text-ink")}>{c.code}</span>
                <span className="truncate text-[12.5px] text-ink-muted">{c.name}</span>
              </span>
              {on && <Check className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.6} />}
            </button>
          );
        })}
        {!shown.length && <p className="px-3 py-3 text-[13.5px] text-ink-muted">No currency matches “{q.trim()}”.</p>}
      </div>
    </div>
  );
}
