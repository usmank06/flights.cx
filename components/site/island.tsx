"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plane } from "lucide-react";
import { cx, Spinner } from "@/components/ui/primitives";

/** Header capsule showing the trip while the home page asks its questions, with a spinner while busy. Its width animates to fit. */
export function Island({ busy = false, children, className = "" }: { busy?: boolean; children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  // The capsule's width follows its contents, set explicitly so it can be animated.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    // On phones, taps on the header height around the 36px capsule press its button. The capsule clips its contents for the
    // width animation, so the button can't extend its own hit area.
    <div
      className={cx("flex max-w-full items-center max-sm:self-stretch", className)}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.querySelector("button")?.click();
      }}
    >
      <div className="float max-w-full overflow-hidden rounded-full text-ink transition-[width] duration-300 ease-[var(--ease-out)]" style={{ width: width ?? undefined }}>
        {/* Max widths leave room for the other header controls at each breakpoint. Phones drop the plane icon to save space. */}
        <div ref={inner} className="flex h-9 w-max max-w-[calc(100vw-9rem)] items-center gap-2 pr-3.5 pl-3 sm:max-w-[calc(100vw-21rem)] lg:max-w-[min(620px,calc(100vw-28rem))]">
          {busy ? <Spinner className="h-[15px] w-[15px] shrink-0 text-accent" /> : <Plane className="h-[15px] w-[15px] shrink-0 text-ink-muted max-sm:hidden" strokeWidth={2} />}
          {children}
        </div>
      </div>
    </div>
  );
}

/** One part of the trip summary, as a button back to its question when `onClick` is given. */
export function IslandPart({ children, onClick, label }: { children: ReactNode; onClick?: () => void; label?: string }) {
  const cls = "min-w-0 truncate text-[13.5px] font-medium text-ink";
  if (!onClick) return <span className={cls}>{children}</span>;
  return (
    // On phones it fills the capsule's height for a larger tap target.
    <button type="button" onClick={onClick} aria-label={label} className={cx(cls, "press rounded-full hover:text-accent max-sm:self-stretch")}>
      {children}
    </button>
  );
}
