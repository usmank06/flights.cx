/**
 * Results page columns, shared with the fixed ask box so it lines up under the answers. An empty right column balances the
 * rail to centre the answers (190 + 20 + 820 + 20 + 190 = the header's 1240px). The right column shrinks first, but not below
 * `--header-side` (set by header.tsx), so the answers stop short of the header's floating currency and account controls.
 */
export const PAGE =
  "mx-auto w-full max-w-[1280px] pr-[max(0.625rem,env(safe-area-inset-right))] pl-[max(0.625rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pl-[max(1.25rem,env(safe-area-inset-left))]";
export const RAILED = "lg:grid lg:grid-cols-[190px_minmax(0,820px)_minmax(calc(var(--header-side,161px)_-_1rem),1fr)] lg:gap-x-5";
