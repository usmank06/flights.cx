import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { callerKey, hmac, SESSION_COOKIE } from "./core";
import { authStore, type User } from "./store";

/** Request-bound auth helpers (cookies). `next/headers` only loads inside a Next server, so core.ts stays free of it. */
export * from "./core";

/** `secure` only in production, since browsers won't send a secure cookie over plain HTTP on localhost. */
export function sessionCookieOptions(expiresAt: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}

/**
 * Identifies the browser signing in: a random value in a cookie scoped to /api/auth. Guesses are counted per browser (store.ts).
 * `mint` (requesting a code) creates it if missing and extends it an hour; verifying only reads it.
 */
const CALLER_COOKIE = "flights_signin";

export async function signInCaller(mint: boolean): Promise<string | null> {
  const jar = await cookies();
  let nonce = jar.get(CALLER_COOKIE)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{24}$/.test(nonce)) {
    if (!mint) return null;
    nonce = randomBytes(18).toString("base64url");
  }
  if (mint)
    jar.set(CALLER_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/auth", maxAge: 3600 });
  return callerKey(nonce);
}

/** The signed-in user for this request, or null. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await authStore();
  const session = await s.sessionByHash(hmac(token));
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) {
    await s.deleteSession(session.tokenHash);
    return null;
  }
  return s.userById(session.userId);
}

export const currentUserId = async (): Promise<string | null> => (await currentUser())?.id ?? null;

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const s = await authStore();
    // Delete it server-side too, or a copied token would keep working.
    await s.deleteSession(hmac(token));
  }
  jar.delete(SESSION_COOKIE);
}
