"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleHelp, Coins, LogIn, LogOut, Menu, Plane, ShieldCheck } from "lucide-react";
import { useAccount } from "@/components/auth/account";
import { SignInModal } from "@/components/auth/header-account";
import { Sheet } from "@/components/ui/overlay";
import { cx } from "@/components/ui/primitives";
import { useCurrency } from "./currency";
import { CurrencySign } from "./currency-sign";
import { CurrencyList } from "./currency-list";
import { HowItWorksModal } from "./how-it-works";
import { Wordmark } from "./logo";
import { REPO_URL } from "./repo";

const ROW = "press flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[16px] font-medium text-ink hover:bg-soft";
const ICON = "h-[18px] w-[18px] shrink-0 text-ink-muted";
const NEXT = <ChevronRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />;

/** The sheet's exit animation (overlay.tsx) plus a frame. Dialogs opened from the menu wait this long so they don't stack. */
const HAND_OFF = 260;

/**
 * Phone header menu (below 768px): a Menu button, or the user's initial when signed in, that opens a sheet with the links,
 * currency and account actions. The trigger is a 44px target laid out as a 36px pill.
 */
export function SiteMenu({ className = "" }: { className?: string }) {
  const { account, loading, signOut } = useAccount();
  const currency = useCurrency();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "currency">("menu");
  const [failed, setFailed] = useState(false);
  const [how, setHow] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);

  // Reserve the button's space while loading so the header doesn't shift.
  if (loading) return <span aria-hidden className={cx("h-9 w-9 shrink-0", className)} />;

  const close = () => setOpen(false);
  const show = () => {
    setView("menu");
    setFailed(false);
    setOpen(true);
  };
  /** Closes the menu, then runs `next` after its exit animation. */
  const handOff = (next: () => void) => {
    close();
    clearTimeout(later.current);
    later.current = setTimeout(next, HAND_OFF);
  };
  // Close first, then reopen with an error if sign-out fails.
  const leave = async () => {
    close();
    setFailed(false);
    if (!(await signOut())) {
      setFailed(true);
      setView("menu");
      setOpen(true);
    }
  };
  const initial = account && (
    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink uppercase">{account.email.charAt(0)}</span>
  );
  const label = account ? "Your account" : "Menu";

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={cx("press -m-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full", className)}
      >
        <span className="float flex h-9 w-9 items-center justify-center rounded-full text-ink">{initial || <Menu className="h-4 w-4" strokeWidth={2.2} />}</span>
      </button>
      <Sheet open={open} onClose={close} label={label}>
        <Glide>
          <div className="px-3 pb-3">
            {view === "currency" ? (
              <CurrencyList
                inSheet
                onChosen={close}
                head={
                  // Text lines up with the Close button. The button extends below it to a 44px target.
                  <button type="button" onClick={() => setView("menu")} className="press flex h-11 w-full items-start gap-2 rounded-xl px-3 pt-[3px] pr-12 text-left text-[16px] font-semibold text-ink">
                    <ChevronLeft aria-hidden className="-ml-1 h-6 w-5 shrink-0 text-ink-muted" strokeWidth={2.2} />
                    Currency
                  </button>
                }
              />
            ) : (
              <>
                {/* Level with the Close button, and clear of it. */}
                <div className="flex h-[30px] items-center gap-2.5 px-3 pr-12">
                  {account ? (
                    <>
                      {initial}
                      <span className="truncate text-[13.5px] text-ink-muted">{account.email}</span>
                    </>
                  ) : (
                    <Wordmark size={16} />
                  )}
                </div>
                {failed && (
                  <p role="alert" className="px-3 pt-1.5 text-[13px] leading-snug text-warn">
                    We couldn’t sign you out. Try again.
                  </p>
                )}
                <div role="group" aria-label={label} className="mt-1.5 flex flex-col">
                  <Link href="/account" onClick={close} className={ROW}>
                    <Plane aria-hidden className={ICON} strokeWidth={2} />
                    Your trips
                    {NEXT}
                  </Link>
                  <Row icon={<CircleHelp aria-hidden className={ICON} strokeWidth={2} />} onClick={() => handOff(() => setHow(true))}>
                    How it works
                    {NEXT}
                  </Row>
                  <Row icon={<Coins aria-hidden className={ICON} strokeWidth={2} />} onClick={() => setView("currency")}>
                    Currency
                    <span className="nums ml-auto text-[14px] text-ink-muted">
                      <CurrencySign code={currency} /> {currency}
                    </span>
                    <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
                  </Row>
                  <a href={REPO_URL} target="_blank" rel="noreferrer noopener" onClick={close} className={ROW}>
                    {/* GitHub's mark (Octicons, mark-github), as in the corner button. */}
                    <svg viewBox="0 0 16 16" aria-hidden className={ICON} fill="currentColor">
                      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
                    </svg>
                    Source on GitHub
                    <ArrowUpRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-ink-faint" strokeWidth={2} />
                  </a>
                  <Link href="/privacy" onClick={close} className={ROW}>
                    <ShieldCheck aria-hidden className={ICON} strokeWidth={2} />
                    Privacy
                    {NEXT}
                  </Link>
                  <div role="separator" className="my-1 h-px bg-rule" />
                  {account ? (
                    <Row icon={<LogOut aria-hidden className={ICON} strokeWidth={2} />} onClick={() => void leave()}>
                      Sign out
                    </Row>
                  ) : (
                    <Row icon={<LogIn aria-hidden className={ICON} strokeWidth={2} />} onClick={() => handOff(() => setSignIn(true))}>
                      Sign in
                      {NEXT}
                    </Row>
                  )}
                </div>
              </>
            )}
          </div>
        </Glide>
      </Sheet>
      <HowItWorksModal open={how} onClose={() => setHow(false)} />
      <SignInModal open={signIn} onClose={() => setSignIn(false)} />
    </>
  );
}

/**
 * Animates its height to fit its content, so the sheet resizes smoothly between the menu and the currency list.
 * Uses `overflow-clip` because `overflow-hidden` makes a scroll container, and the list's sticky field would stick to it.
 */
function Glide({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  // Unset until measured, so the sheet opens at its natural height without animating.
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const seen = new ResizeObserver(() => setHeight(el.offsetHeight));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <div style={{ height }} className="overflow-clip transition-[height] duration-300 ease-[var(--ease-out)]">
      <div ref={inner}>{children}</div>
    </div>
  );
}

function Row({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={ROW}>
      {icon}
      {children}
    </button>
  );
}
