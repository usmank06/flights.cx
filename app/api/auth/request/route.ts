import type { NextRequest } from "next/server";
import { reportError } from "@/lib/errors";
import { notJson } from "@/lib/abuse/json-only";
import { waitWords } from "@/lib/abuse/limit";
import { callerIp, REFUSED_SAID, SIGN_IN_ACTION, TOKEN_HEADER, verifyRecaptcha } from "@/lib/abuse/recaptcha";
import { emailConfigured, requestCode, signInCaller } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Sending the email is one HTTP call. */
export const maxDuration = 20;

/**
 * Requests a sign-in code. Answers the same whether or not the address has an account, so it can't reveal who has one.
 * The caller isn't signed in, so the limit is per inbox (lib/auth/core.ts).
 */
export async function POST(req: NextRequest) {
  const refused = notJson(req.headers);
  if (refused) return refused;
  // reCAPTCHA first, so a script can't flood someone's inbox with codes.
  const verdict = await verifyRecaptcha(req.headers.get(TOKEN_HEADER), SIGN_IN_ACTION, callerIp(req.headers));
  if (!verdict.allow) return Response.json({ error: REFUSED_SAID }, { status: 403 });
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : "";

  // Identifies this browser, so code guesses are counted per browser (lib/auth/index.ts).
  const caller = (await signInCaller(true))!;
  const result = await requestCode(email, caller);

  if (!result.ok && result.reason === "invalid-email")
    return Response.json({ error: "That doesn’t look like an email address." }, { status: 400 });

  if (!result.ok && result.reason === "cooldown")
    return Response.json(
      {
        error: `We just sent you a code. You can ask for another in ${Math.ceil((result.retryInMs ?? 0) / 1000)} seconds.`,
        // Failed sends drop their code (lib/auth/core.ts), so with a real transport the pending code is in the inbox.
        // Offer the code screen only if this browser requested it, since no other browser can use that code.
        pending: emailConfigured() && result.pending,
      },
      { status: 429 }
    );

  // Same message whether or not the address has an account. It only reports codes already sent.
  if (!result.ok && result.reason === "inbox-limit") {
    const wait = Math.ceil((result.retryInMs ?? 0) / 1000);
    // Only the daily cap waits over an hour, so longer waits say "today".
    const error =
      wait > 20 * 3600
        ? "We’ve sent a few codes to that address today. Try again tomorrow."
        : `We’ve sent a few codes to that address ${wait > 3600 ? "today" : "already"}. Give it ${waitWords(wait)} and try again.`;
    return Response.json({ error }, { status: 429 });
  }

  // Every failure reason has returned above; this narrows the type.
  if (!result.ok) return Response.json({ error: "That didn’t work." }, { status: 400 });

  // Demo mode: with no mail transport and outside production, the code is returned in the response.
  // The production check has no override, since that would let anyone sign in as anyone.
  const demoCode =
    !result.delivered &&
    result.devCode &&
    !emailConfigured() &&
    process.env.NODE_ENV !== "production"
      ? result.devCode
      : undefined;

  if (!result.delivered && !demoCode)
    await reportError("email", emailConfigured() ? "the mail provider refused a sign-in code" : "no mail transport: set RESEND_API_KEY or EMAIL_WEBHOOK_URL, or sign-in codes cannot be delivered", { where: "sign-in code" });

  return Response.json({
    ok: true,
    sent: result.delivered,
    ...(demoCode ? { demoCode } : {}),
    // Shown when no code was sent or returned. Setup details for the operator go to the error report above.
    ...(!result.delivered && !demoCode
      ? {
          undeliverable: emailConfigured()
            ? "We couldn’t send your code. Give it a minute and try again."
            : "Signing in isn’t working right now.",
        }
      : {}),
  });
}
