import { cx } from "@/components/ui/primitives";

/** Loading placeholder shaped like a plan card. */
export function CardSkeleton({ count = 3, compact = false }: { count?: number; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cx("fade flex flex-col rounded-[24px] bg-paper ring-1 ring-rule", compact ? "gap-3 p-4" : "gap-4 p-5 sm:p-6")}
          style={{ animationDelay: `${i * 90}ms` }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <span className="shimmer h-5 w-28 rounded-full" />
              {!compact && <span className="shimmer h-3.5 w-full max-w-[26rem] rounded-full" />}
            </div>
            <span className="shimmer h-7 w-20 rounded-full" />
          </div>
          {/* A container like the card's, so the times bar shows only at widths where the card puts them on one row. */}
          <div className="@container flex flex-col gap-4 rounded-[20px] bg-soft/80 px-3 py-4 sm:px-4">
            {[0, 1].map((r) => (
              <div key={r} className="flex items-center gap-4">
                <span className="shimmer h-7 w-7 shrink-0 rounded-lg" />
                <span className="shimmer h-4 w-24 rounded-full" />
                <span className="shimmer hidden h-5 w-28 rounded-full @lg:block" />
                <span className="flex-1" />
                <span className="shimmer h-4 w-16 rounded-full" />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <span className="shimmer h-10 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
