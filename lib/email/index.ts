/**
 * Transactional email over a direct HTTP call. Transport: Resend if RESEND_API_KEY is set, else a JSON POST to EMAIL_WEBHOOK_URL,
 * else the console. Console mail isn't deliverable, which lets local sign-in show the code (see app/api/auth/request/route.ts).
 */

export type Mail = {
  to: string;
  subject: string;
  /** Plain-text body, complete on its own. */
  text: string;
  /** Styled HTML version (lib/email/templates.ts). */
  html?: string;
  /** Extra headers, such as an alert's List-Unsubscribe. The console transport ignores them. */
  headers?: Record<string, string>;
};

export type MailResult = {
  /** True when a real transport accepted the message. */
  deliverable: boolean;
  transport: "resend" | "webhook" | "console";
  error?: string;
};

/** Resend's shared test sender, used when EMAIL_FROM is unset. It only delivers to the Resend account's owner. */
const ONBOARDING_FROM = "Flights <onboarding@resend.dev>";
let warnedFrom = false;

/** The From address, read at send time. Warns once in production when EMAIL_FROM is unset. */
export function mailFrom(): string {
  const configured = process.env.EMAIL_FROM?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" && emailTransport() === "resend" && !warnedFrom) {
    warnedFrom = true;
    console.warn(`[email] EMAIL_FROM is not set, so mail goes from ${ONBOARDING_FROM}, which delivers only to the Resend account's owner. Set EMAIL_FROM to an address on a verified domain.`);
  }
  return ONBOARDING_FROM;
}

/** The configured transport, read at call time since env can change between calls. */
export function emailTransport(): MailResult["transport"] {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.EMAIL_WEBHOOK_URL) return "webhook";
  return "console";
}

export const emailConfigured = (): boolean => emailTransport() !== "console";

export async function sendMail(mail: Mail): Promise<MailResult> {
  const transport = emailTransport();
  try {
    if (transport === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: mailFrom(),
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
          ...(mail.headers ? { headers: mail.headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { deliverable: false, transport, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      return { deliverable: true, transport };
    }

    if (transport === "webhook") {
      const res = await fetch(process.env.EMAIL_WEBHOOK_URL!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.EMAIL_WEBHOOK_TOKEN
            ? { authorization: `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ from: mailFrom(), ...mail }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { deliverable: false, transport, error: `HTTP ${res.status}` };
      return { deliverable: true, transport };
    }
  } catch (e) {
    return { deliverable: false, transport, error: (e as Error).message };
  }

  // No transport: log the message for local development.
  console.info(
    `\n[email] No transport configured (set RESEND_API_KEY or EMAIL_WEBHOOK_URL).\n` +
      `[email] To: ${mail.to}\n[email] ${mail.subject}\n${mail.text}\n`
  );
  return { deliverable: false, transport: "console" };
}
