import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { adoptSearches, sessionCookieOptions, SESSION_COOKIE, signInCaller, VERIFY_SAID, verifyCode } from "@/lib/auth";
import { notJson } from "@/lib/abuse/json-only";
import { recordMetric, simpleEvent } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Checks the code, sets the session cookie, and assigns this browser's unowned searches to the account so its history carries over.
 * Guessing is limited to a few attempts per code for the browser that requested it (lib/auth/store.ts).
 */
export async function POST(req: NextRequest) {
  // JSON only, so another site can't post a form that signs the visitor into a different account.
  const refused = notJson(req.headers);
  if (refused) return refused;
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : "";
  const code = typeof body?.code === "string" ? body.code : "";
  // Searches this browser started, each with the owner key that proves it.
  const held: { slug: string; key: string }[] = Array.isArray(body?.searches)
    ? body.searches
        .filter((h: unknown): h is { slug: string; key: string } => {
          const { slug, key } = (h ?? {}) as Record<string, unknown>;
          return typeof slug === "string" && slug.length < 40 && typeof key === "string" && key.length <= 64;
        })
        .slice(0, 200)
    : [];

  const result = await verifyCode(email, code, await signInCaller(false));
  if (!result.ok) return Response.json({ error: VERIFY_SAID[result.reason] }, { status: 401 });

  // Set through cookies() so the cookie options stay in one place, next to the session TTL.
  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));

  // Sign-in has already succeeded, so failing to adopt searches only logs a warning.
  const adopted = held.length
    ? await adoptSearches(result.user.id, held).catch((e) => {
        console.warn(`[auth] could not adopt this browser's searches: ${(e as Error).message}`);
        return 0;
      })
    : 0;

  await recordMetric(
    simpleEvent("sign_in", { signedIn: true, detail: { adopted, returning: result.user.createdAt !== result.user.lastSeenAt } })
  );

  return Response.json({ ok: true, email: result.user.email, adopted });
}
