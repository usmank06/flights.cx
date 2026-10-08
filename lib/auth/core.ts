import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isProductionDeployment } from "@/lib/env";
import { keyOpens } from "@/lib/search/owner";
import { rateLimitFor, refundFor } from "@/lib/abuse/limit";
import { authStore, type User } from "./store";
import { sendMail, emailConfigured } from "@/lib/email";
import { signInEmail } from "@/lib/email/templates";

/**
 * Email sign-in with six-digit codes; no passwords or OAuth. Request-free so it runs outside Next: the cookie helpers need
 * `next/headers` and live in index.ts, which re-exports this module.
 */

const CODE_TTL_MS = 10 * 60_000;
/**
 * Guesses per requesting browser, shared across an address's live codes. A new code resets them only once they're used up, and the
 * inbox rate limit caps how often that can happen.
 */
const MAX_ATTEMPTS = 5;
/** Live codes kept per address, so a new request (even a stranger's) doesn't void the code being typed. */
const LIVE_CODES = 3;
const SESSION_TTL_MS = 60 * 24 * 3600_000;
export const SESSION_COOKIE = "flights_session";
const RESEND_COOLDOWN_MS = 30_000;

/**
 * HMAC key for codes and session tokens. Without AUTH_SECRET it falls back to a random per-process key (sessions die on restart),
 * which fails visibly where a hardcoded default would be a silent hole.
 */
let cachedSecret: string | null = null;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.AUTH_SECRET;
  if (configured && configured.length >= 16) {
    cachedSecret = configured;
    return cachedSecret;
  }
  // Per-instance secrets would make codes fail on any instance that didn't issue them, so production refuses (see lib/env.ts).
  if (isProductionDeployment()) throw new Error("AUTH_SECRET is not set (or is under 16 characters)");
  // Warn on first use instead of at module load, which also runs during `next build`.
  if (process.env.NODE_ENV === "production")
    console.warn(
      "[auth] AUTH_SECRET is not set (or is under 16 characters). Sessions will not survive a restart. Set it."
    );
  cachedSecret = randomBytes(32).toString("hex");
  return cachedSecret;
}

/** HMAC-SHA256 keyed with the auth secret, as hex. */
export const hmac = (value: string): string => createHmac("sha256", secret()).update(value).digest("hex");

/** Constant-time compare, so timing reveals nothing about a guess. */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Trim and lowercase only. Some mail hosts ignore dots and plus tags in the local part and most don't, so folding them could merge
 * two people's accounts.
 */
const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

/** Catches typos; the emailed code is the real check. Also rejects control characters and local parts over 64 characters. */
export const looksLikeEmail = (v: string): boolean =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 && v.indexOf("@") <= 64 && ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** The sign-in cookie as the code store keeps it, keyed so a dump of the store can't be replayed as a cookie. */
export const callerKey = (nonce: string): string => hmac(`caller:${nonce}`).slice(0, 32);

const sixDigits = (): string => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");

export type RequestCodeResult =
  | {
      ok: true;
      /** True only when a transport accepted the mail, which a configured transport can still fail to do. */
      delivered: boolean;
      /** Set only when nothing was delivered. The route decides whether to show it. */
      devCode?: string;
    }
  | { ok: false; reason: "invalid-email" | "inbox-limit"; retryInMs?: number }
  /** `pending`: this caller already holds a live code and can go straight to entering it. */
  | { ok: false; reason: "cooldown"; retryInMs: number; pending: boolean };

/**
 * Sends a sign-in code requested by `caller` (`callerKey` of the browser's sign-in cookie). The result never reveals whether an
 * account exists, and accounts are only created on verify, so a mistyped address leaves nothing behind.
 */
export async function requestCode(rawEmail: string, caller: string): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  if (!looksLikeEmail(email)) return { ok: false, reason: "invalid-email" };

  const s = await authStore();
  await s.sweep();

  const existing = await s.getCode(email);
  if (existing) {
    const since = Date.now() - Date.parse(existing.sentAt);
    if (since < RESEND_COOLDOWN_MS)
      return { ok: false, reason: "cooldown", retryInMs: RESEND_COOLDOWN_MS - since, pending: existing.callers?.[caller] != null };
  }
  // Caps codes per inbox, whoever asks (lib/abuse/limit.ts).
  const inbox = await rateLimitFor("inbox", email);
  if (!inbox.ok) return { ok: false, reason: "inbox-limit", retryInMs: inbox.retryAfterS * 1000 };

  const code = sixDigits();
  const codeHash = hmac(`${email}:${code}`);
  const now = Date.now();
  // Added alongside earlier codes, so one already in the inbox keeps working.
  await s.putCode(
    { email, codeHash, expiresAt: new Date(now + CODE_TTL_MS).toISOString(), sentAt: new Date(now).toISOString() },
    { keep: LIVE_CODES, maxAttempts: MAX_ATTEMPTS },
    caller
  );

  const mail = signInEmail(code);
  const result = await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  // Undelivered codes don't count against the inbox limit, so a mail outage can't lock someone out afterwards.
  if (!result.deliverable) await refundFor("inbox", email);
  // Drop a refused code so the cooldown doesn't block a retry; earlier codes still work. The console transport keeps it outside
  // production, where the route may show it.
  if (!result.deliverable && (result.transport !== "console" || process.env.NODE_ENV === "production")) await s.dropCode(email, codeHash);

  // Undelivered codes go back to the caller. Only app/api/auth/request/route.ts may show one, and only in demo mode.
  return result.deliverable ? { ok: true, delivered: true } : { ok: true, delivered: false, devCode: code };
}

export type VerifyResult =
  | { ok: true; user: User; token: string; expiresAt: string }
  | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" | "wrong-code" };

/**
 * Messages for refused codes. "no-code" reads like a wrong code, so a guess never reveals whether a code is pending. Only the browser
 * that asked hears that it expired or ran out of tries.
 */
export const VERIFY_SAID: Record<Extract<VerifyResult, { ok: false }>["reason"], string> = {
  "no-code": "That code isn’t right.",
  "wrong-code": "That code isn’t right.",
  expired: "That code has expired.",
  "too-many-attempts": "Too many wrong tries.",
};

/**
 * Checks a code against the address's live codes and mints a session, clearing all codes. Only a browser that requested a code may
 * guess, so a stranger's wrong guesses can't use up the owner's.
 */
export async function verifyCode(rawEmail: string, rawCode: string, caller: string | null): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const code = rawCode.replace(/\D/g, "");
  const s = await authStore();

  // Count the guess atomically before comparing, so parallel guesses can't all see zero attempts.
  const claim = await s.claimAttempt(email, caller, MAX_ATTEMPTS);
  if (!claim.ok) return { ok: false, reason: claim.reason };

  const guess = hmac(`${email}:${code}`);
  if (!claim.codeHashes.some((h) => sameHash(h, guess))) {
    // The final wrong guess reports "too many attempts" up front, so the user isn't invited to try again.
    return { ok: false, reason: claim.attempts >= MAX_ATTEMPTS ? "too-many-attempts" : "wrong-code" };
  }

  // Clear every code before minting, so a replay or another live code can't create a second session.
  await s.clearCode(email);
  const user = await s.upsertUser(email);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await s.putSession({ tokenHash: hmac(token), userId: user.id, createdAt: new Date().toISOString(), expiresAt });
  return { ok: true, user, token, expiresAt };
}


/**
 * Assigns this browser's searches (from `localStorage`) to the signed-in user. Only unowned records with a matching owner key are
 * adopted (lib/search/owner.ts). Anyone with a share link has the slug, so the slug alone doesn't prove ownership.
 */
export async function adoptSearches(userId: string, held: { slug: string; key: string }[]): Promise<number> {
  const { store } = await import("@/lib/store");
  const s = await store();
  let adopted = 0;
  for (const { slug, key } of held.slice(0, 200)) {
    // A record that fails to update is skipped.
    const next = await s.update(slug, (r) => (r.userId || !keyOpens(key, r.ownerKeyHash) ? r : { ...r, userId })).catch(() => null);
    if (next?.userId === userId) adopted++;
  }
  return adopted;
}

export { emailConfigured };
export type { User };
