import { reportError } from "@/lib/errors";

/**
 * Invisible reCAPTCHA v3 for the routes that cost money or send email: searches, follow-ups, the date grid, intake and sign-in codes.
 * Anything that prevents a verdict fails open (blocking a real search costs more than letting a scripted one through), except a
 * missing token.
 */

const SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify";

/** True outside production unless NEXT_PUBLIC_RECAPTCHA_LOCAL=1. */
export const recaptchaOffLocally = (): boolean => process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_RECAPTCHA_LOCAL !== "1";

/** Short, because a search waits on it. A slow siteverify fails open. */
const VERIFY_TIMEOUT_MS = 4_000;

/** reCAPTCHA's recommended default. Override with RECAPTCHA_MIN_SCORE. */
const DEFAULT_MIN_SCORE = 0.5;

/**
 * Actions that tokens are minted under. reCAPTCHA scores each action separately, and the server checks the action matches. The
 * client repeats these as literals (components/search/search-client.ts) so this server-only module stays out of the browser bundle.
 */
export const SEARCH_ACTION = "search";

export const SIGN_IN_ACTION = "sign_in";

/** Follow-up questions. */
export const ASK_ACTION = "ask";

/** Flights for one day of the date grid, or for one place. */
export const MORE_ACTION = "more";

/** Building or resizing the date grid. */
export const GRID_ACTION = "grid";

/** Choosing the next intake question. */
export const INTAKE_ACTION = "intake";

/**
 * Shown on every route when the check refuses. It asks for a retry because a reload would lose the intake answers, and each retry
 * mints a new token.
 */
export const REFUSED_SAID = "We couldn't check your browser just now. Try again in a moment.";

/** Header carrying the token. The client repeats it as a literal too. */
export const TOKEN_HEADER = "x-recaptcha-token";

type RecaptchaOutcome = {
  /** Whether the request may proceed. Errors and timeouts allow it. */
  allow: boolean;
  /**
   * For logs and metrics:
   *
   *   off           no keys, or off locally; nothing checked
   *   passed        verified, score at or above the threshold
   *   low-score     verified, but scored as a likely bot
   *   no-token      configured, but the client sent no token
   *   invalid       token rejected (forged, replayed or expired), or minted for another action
   *   unreachable   siteverify didn't answer; allowed
   *   misconfigured siteverify rejected our own key; allowed
   */
  reason: "off" | "passed" | "low-score" | "no-token" | "invalid" | "unreachable" | "misconfigured";
  /** reCAPTCHA's score from 0.0 to 1.0, when there is one. */
  score: number | null;
};

/** Requires both keys. With only the secret set, clients couldn't mint tokens and every request would be refused. */
function recaptchaEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY && process.env.RECAPTCHA_SECRET_KEY);
}

function minScore(): number {
  const raw = Number(process.env.RECAPTCHA_MIN_SCORE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_SCORE;
}

/** The siteverify response. Every field is optional because the shape is outside our control. */
type SiteVerifyResponse = {
  success?: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

/** Error codes that point at our configuration, so a bad secret key fails open instead of refusing everyone. */
const OUR_FAULT = new Set(["missing-input-secret", "invalid-input-secret", "bad-request"]);

function failOpen(why: string): RecaptchaOutcome {
  void reportError("server", `reCAPTCHA could not verify (${why}), so it let the request through`, { where: "recaptcha" });
  return { allow: true, reason: "unreachable", score: null };
}

/** Verifies a token minted for `expected`. Never throws. `remoteIp` goes to reCAPTCHA when known and is never stored. */
export async function verifyRecaptcha(
  token: string | null,
  expected: typeof SEARCH_ACTION | typeof SIGN_IN_ACTION | typeof ASK_ACTION | typeof MORE_ACTION | typeof GRID_ACTION | typeof INTAKE_ACTION,
  remoteIp: string | null = null
): Promise<RecaptchaOutcome> {
  // Off in development: localhost isn't on the site key's domain list. Set NEXT_PUBLIC_RECAPTCHA_LOCAL=1 to test it locally.
  if (recaptchaOffLocally()) return { allow: true, reason: "off", score: null };
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!recaptchaEnabled() || !secret) return { allow: true, reason: "off", score: null };

  if (!token) {
    // A missing token is what a script sends, so this refuses without asking siteverify. The client waits for api.js to load first.
    return { allow: false, reason: "no-token", score: null };
  }

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);

  let data: SiteVerifyResponse;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return failOpen(`siteverify HTTP ${res.status}`);
    data = (await res.json()) as SiteVerifyResponse;
  } catch (e) {
    return failOpen((e as Error).message);
  }

  if (data.success !== true) {
    const codes = data["error-codes"] ?? [];
    if (codes.some((c) => OUR_FAULT.has(c))) {
      void reportError("server", `reCAPTCHA rejected our own key (${codes.join(", ")}), so it let the request through`, { where: "recaptcha" });
      return { allow: true, reason: "misconfigured", score: null };
    }
    return { allow: false, reason: "invalid", score: null };
  }

  // Scores are per action, so a token minted for one action can't be used on another route.
  if (data.action && data.action !== expected) return { allow: false, reason: "invalid", score: null };

  const score = typeof data.score === "number" ? data.score : null;
  // No score means a v2 key. A verified v2 token still proves a human, so it passes.
  if (score == null) return { allow: true, reason: "passed", score: null };

  return score >= minScore()
    ? { allow: true, reason: "passed", score }
    : { allow: false, reason: "low-score", score };
}

/**
 * The client IP. On Vercel the edge sets x-forwarded-for, so its first hop is the real client. Elsewhere a caller can forge that
 * header, so this prefers x-real-ip, then the last hop (the one nearest this server). Null under `next dev`; `remoteip` is optional.
 */
export function callerIp(headers: Headers): string | null {
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (process.env.VERCEL) return hops[0] || headers.get("x-real-ip") || null;
  return headers.get("x-real-ip") || hops.at(-1) || null;
}
