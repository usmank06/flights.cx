"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { heldSearches } from "@/lib/history";
import { Button, cx, fieldClass } from "@/components/ui/primitives";
import { shownError } from "@/components/ui/errors";
import { recaptchaToken } from "@/components/search/search-client";
import { useMedia } from "@/components/ui/use-media";

/**
 * Account session and email sign-in with a six-digit code. Everything except email alerts works signed out, and signing in
 * attaches this browser's searches to the account.
 */

type Account = { email: string } | null;

type Ctx = {
  account: Account;
  /** True until the first session check finishes, so "signed out" and "unknown" stay distinct. */
  loading: boolean;
  refresh: () => Promise<void>;
  /** Resolves true once signed out. On false the account stays shown, since the session is still valid. */
  signOut: () => Promise<boolean>;
};

const AccountContext = createContext<Ctx>({
  account: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => false,
});

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Returns the session user without setting state, so a reply after unmount is dropped. `null` means signed out and
   * `undefined` means the check failed, so a network error doesn't show Sign in to a signed-in user.
   */
  const fetchSession = useCallback(async (): Promise<Account | undefined> => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      const data = await res.json();
      return (data.user ?? null) as Account;
    } catch {
      return undefined;
    }
  }, []);

  const refresh = useCallback(async () => {
    const user = await fetchSession();
    if (user !== undefined) setAccount(user);
    setLoading(false);
  }, [fetchSession]);

  useEffect(() => {
    let live = true;
    void fetchSession().then((user) => {
      if (!live) return;
      if (user !== undefined) setAccount(user);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [fetchSession]);

  // If the sign-out request fails, keep the account shown, since the session is still valid.
  const signOut = useCallback(async () => {
    const res = await fetch("/api/auth/session", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setAccount(null);
      return true;
    }
    // Re-check: the server may have ended the session even though the reply was lost.
    const user = await fetchSession();
    if (user !== undefined) setAccount(user);
    return user === null;
  }, [fetchSession]);

  const value = useMemo(() => ({ account, loading, refresh, signOut }), [account, loading, refresh, signOut]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export const useAccount = () => useContext(AccountContext);

/* ------------------------------ Sign-in form ------------------------------ */

export function SignIn({
  onDone,
  reason,
}: {
  onDone?: () => void;
  reason?: string;
}) {
  const { refresh } = useAccount();
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Shown on screen when no mail transport is configured (demo mode on non-production builds only). */
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  /** Blocks double submits. A ref, so a second Enter in the same frame sees it. */
  const inFlight = useRef(false);
  /**
   * Touch screens skip autofocus so the on-screen keyboard doesn't open unasked. SignIn mounts after hydration, so this is
   * already correct on first render.
   */
  const coarse = useMedia("(pointer: coarse)");

  // Focus the new step's field (or its title on touch screens) so focus stays inside the dialog.
  const shown = useRef(stage);
  useEffect(() => {
    if (shown.current === stage) return;
    shown.current = stage;
    (coarse ? titleRef : stage === "code" ? codeRef : emailRef).current?.focus();
  }, [stage, coarse]);

  /** Requests a code. Resolves true when the code step is showing. */
  async function send(): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const token = await recaptchaToken("sign_in");
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-recaptcha-token": token } : {}) },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      // A code for this address is still pending: go to the code step. On the code step itself, the 429 error is shown.
      if (res.status === 429 && data?.pending && stage === "email") {
        setDemoCode(null);
        setStage("code");
        return true;
      }
      if (!res.ok) throw new Error(data?.error ?? "We couldn’t send your code. Give it a minute and try again.");
      // The email can't be delivered: stay on the email step and show why.
      if (data.undeliverable) {
        setError(data.undeliverable);
        return false;
      }
      setDemoCode(data.demoCode ?? null);
      setStage("code");
      return true;
    } catch (e) {
      setError(shownError(e, "We couldn’t send your code. Give it a minute and try again."));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** Sends a new code to the same address, e.g. after an expired, used or locked-out code. */
  async function resend() {
    setResending(true);
    // Clear the typed digits only if a new code was sent. A refused resend (too soon) keeps them.
    if (await send()) {
      setCode("");
      setResent(true);
    }
    setResending(false);
    if (!coarse) codeRef.current?.focus();
  }

  /** `typed` is passed when the sixth digit auto-submits, before the `code` state has updated. */
  async function verify(typed = code) {
    if (inFlight.current || typed.length !== 6) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Send this browser's searches and their keys so the account takes them over.
        body: JSON.stringify({ email, code: typed, searches: heldSearches() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "That didn’t work");
      await refresh();
      onDone?.();
    } catch (e) {
      setError(shownError(e, "That code didn’t go through. Check it and try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-5">
      {/* In a modal, pad clear of the Close button. */}
      <div className={cx("flex flex-col gap-1.5", onDone && "pr-10")}>
        <p ref={titleRef} tabIndex={-1} className="display text-[28px] leading-tight font-semibold text-ink outline-none">
          {stage === "email" ? "Sign in" : "Check your email"}
        </p>
        {(stage !== "email" || reason) && (
          <p className="text-[14.5px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
            {stage === "email" ? (
              reason
            ) : (
              <>
                Enter the {resent ? "new " : ""}6-digit code we sent to <span className="font-medium text-ink-soft">{email.trim()}</span>. It expires in 10 minutes.
              </>
            )}
          </p>
        )}
      </div>

      {stage === "email" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {/* 16px on touch screens, or iOS zooms in. Kept out of fieldClass because the code field uses it at 20px. */}
          <input
            ref={emailRef}
            autoFocus={!coarse}
            type="email"
            autoComplete="email"
            enterKeyHint="send"
            aria-label="Email address"
            className={cx(fieldClass, "pointer-coarse:text-[16px]")}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              // Clear the error, since it refers to the address before this edit.
              setError(null);
            }}
          />
          {/* aria-disabled while sending, since disabling drops focus out of the dialog. `send` ignores repeat presses. */}
          <Button type="submit" variant="primary" size="md" busy={busy} aria-disabled={busy || undefined} disabled={!email.trim()} className="w-full">
            {busy ? "Sending…" : "Email me a code"}
          </Button>
          <p className="text-center text-[12.5px] leading-snug text-ink-muted">
            Used to sign you in and send the alerts you ask for.{" "}
            <Link href="/privacy" className="whitespace-nowrap underline underline-offset-2 hover:text-ink">
              Privacy
            </Link>
          </p>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <input
            ref={codeRef}
            autoFocus={!coarse}
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="one-time-code"
            aria-label="Six-digit code"
            className={cx(fieldClass, "nums text-center text-[20px] tracking-[0.4em] indent-[0.4em]")}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              const typed = e.target.value.replace(/\D/g, "").slice(0, 6);
              const changed = typed !== code;
              setCode(typed);
              setError(null);
              // Submit as soon as the sixth digit arrives, whether typed, pasted or autofilled.
              if (typed.length === 6 && changed) void verify(typed);
            }}
          />
          <Button type="submit" variant="primary" size="md" busy={busy && !resending} disabled={busy || code.length !== 6} className="w-full">
            {busy && !resending ? "Checking…" : "Sign in"}
          </Button>
          {/* Shorter labels on phones keep both buttons on one row. */}
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="sm" busy={resending} disabled={busy} onClick={() => void resend()} className="max-sm:h-11">
              {resending ? (
                "Sending…"
              ) : (
                <>
                  <span className="sm:hidden">New code</span>
                  <span className="max-sm:hidden">Send a new code</span>
                </>
              )}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="max-sm:h-11"
              onClick={() => {
                setStage("email");
                setCode("");
                setDemoCode(null);
                setError(null);
                setResent(false);
              }}
            >
              <span className="sm:hidden">Change email</span>
              <span className="max-sm:hidden">Use a different email</span>
            </Button>
          </div>
        </form>
      )}

      {demoCode && (
        <p className="rounded-2xl bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">
          <span className="font-semibold">No email is configured, so nothing was sent.</span> Your code is{" "}
          <span className="nums text-[15px] font-bold tracking-[0.2em]">{demoCode}</span>. This only happens in demo
          mode — set <code>RESEND_API_KEY</code> or <code>EMAIL_WEBHOOK_URL</code> and codes go to the inbox.
        </p>
      )}

      {error && (
        <p role="alert" className="step-in flex items-start gap-2.5 rounded-2xl bg-warn-soft px-4 py-3 text-[14px] leading-snug text-warn">
          <CircleAlert className="mt-px h-[17px] w-[17px] shrink-0" strokeWidth={2.2} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
