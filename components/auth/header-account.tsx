"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { LogOut, Plane } from "lucide-react";
import { Modal, Popover } from "@/components/ui/overlay";
import { SignIn, useAccount } from "./account";

/**
 * Header account control: Sign in (opens a modal in place) or, once signed in, an account menu. Phones use site-menu.tsx.
 * Renders a placeholder until the session is known, so Sign in doesn't flash for signed-in users.
 */
export function HeaderAccount() {
  const { account, loading, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Focus the first item on open so arrow keys work. Popover returns focus to the button on Escape.
  useEffect(() => {
    if (!open || !account) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, account]);
  // Reserve Sign in's width while loading so the header doesn't shift.
  if (loading) return <span className="h-9 w-[70px] shrink-0" aria-hidden />;
  if (account) {
    const item = "press flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] font-medium text-ink hover:bg-soft";
    // Arrow keys cycle through the items, Home and End jump to the ends, and Tab closes the menu.
    const keys = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Tab") return setOpen(false);
      const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const n = items.length;
      const to = e.key === "ArrowDown" ? (at + 1) % n : e.key === "ArrowUp" ? (at - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
      if (to == null || !n) return;
      e.preventDefault();
      items[to].focus();
    };
    // Close first, since `open` also drives the Sign in modal once signed out. Reopen with an error if sign-out fails.
    const leave = async () => {
      setOpen(false);
      setFailed(false);
      if (!(await signOut())) {
        setFailed(true);
        setOpen(true);
      }
    };
    return (
      <div className="relative shrink-0">
        <button
          ref={anchor}
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            setFailed(false);
          }}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Your account"
          title={account.email}
          className="float press fade flex h-9 items-center gap-2 rounded-full pr-[5px] pl-[5px] sm:pr-3.5"
        >
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink uppercase">{account.email.charAt(0)}</span>
          <span className="hidden text-[13.5px] font-medium text-ink-soft sm:inline">Account</span>
        </button>
        <Popover
          open={open}
          onClose={() => {
            setOpen(false);
            setFailed(false);
          }}
          anchor={anchor}
          align="end"
          label="Your account"
          className="w-[15.5rem]"
        >
          <p className="truncate px-3 pt-1.5 pb-2 text-[12.5px] text-ink-muted">{account.email}</p>
          {failed && (
            <p role="alert" className="px-3 pb-2 text-[13px] leading-snug text-warn">
              We couldn’t sign you out. Try again.
            </p>
          )}
          <div ref={menu} role="menu" aria-label="Your account" onKeyDown={keys} className="flex flex-col">
            <Link href="/account" role="menuitem" onClick={() => setOpen(false)} className={item}>
              <Plane className="h-4 w-4 text-ink-muted" strokeWidth={2} />
              Your trips
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => void leave()}
              className={item}
            >
              <LogOut className="h-4 w-4 text-ink-muted" strokeWidth={2} />
              Sign out
            </button>
          </div>
        </Popover>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => focusPageSignIn() || setOpen(true)} className="float press fade flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13.5px] font-semibold text-ink">
        Sign in
      </button>
      <SignInModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Focuses the account page's sign-in form (`data-page-sign-in`) if it's showing. Returns false if there isn't one. */
function focusPageSignIn(): boolean {
  const field = document.querySelector<HTMLInputElement>("[data-page-sign-in] input");
  if (!field) return false;
  field.scrollIntoView({ block: "center" });
  field.focus({ preventScroll: true });
  return true;
}

/** Sign-in modal, opened from the header and from the phone menu (site-menu.tsx). */
export function SignInModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // If the page already shows a sign-in form, focus it and close instead of opening.
  const onPage = open && typeof document !== "undefined" && document.querySelector("[data-page-sign-in]") != null;
  useEffect(() => {
    if (!onPage) return;
    focusPageSignIn();
    onClose();
  }, [onPage, onClose]);
  if (onPage) return null;
  return (
    // From sm up, pin the dialog's top so messages added below the code field don't move it.
    <Modal open={open} onClose={onClose} label="Sign in" width={460} className="sm:mt-[max(0px,calc(50dvh-13rem))] sm:self-start">
      <div className="px-6 pt-1 pb-6 sm:px-8 sm:pt-8 sm:pb-8">
        <SignIn onDone={onClose} />
      </div>
    </Modal>
  );
}
