import { createHash } from "node:crypto";
import { databaseUrl, db, once } from "@/lib/db";
import { emailConfigured, sendMail } from "@/lib/email";
import { SITE_URL } from "@/lib/site";

/**
 * Error reporting: one row per kind of error in `app_errors`, with a count, plus an hourly digest to ALERT_EMAIL that mails each kind
 * at most once a day. Without a database, errors are only logged.
 */

export type ErrorSource = "server" | "browser" | "search" | "follow-up" | "watch" | "email" | "database";

export type ErrorContext = {
  /** The route, page or function where it happened. */
  where?: string;
  /** The search this happened in, for a link in the digest. */
  slug?: string | null;
  detail?: Record<string, string | number | boolean | null>;
};

const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;

/**
 * Groups repeats of one error: source, location, and the message with its variable parts (numbers, quoted text, parenthesised text,
 * ids) removed, so "3 of 12 requests failed (…)" is one row whatever the counts.
 */
export function fingerprint(source: ErrorSource, where: string, message: string): string {
  const shape = message
    .replace(/\([^)]*\)/g, "()")
    .replace(/["“'‘][^"”'’]*["”'’]/g, "''")
    .replace(/[0-9a-f]{8,}/gi, "#")
    .replace(/\d+/g, "N")
    .slice(0, 300);
  return createHash("sha256").update(`${source}|${where}|${shape}`).digest("hex").slice(0, 24);
}

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? null };
  return { message: typeof error === "string" ? error : JSON.stringify(error) ?? String(error), stack: null };
}

async function table() {
  const pool = db();
  await once("errors", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_errors (
        fingerprint     text PRIMARY KEY,
        source          text NOT NULL,
        location        text NOT NULL,
        message         text NOT NULL,
        stack           text,
        slug            text,
        detail          jsonb,
        count           integer NOT NULL DEFAULT 1,
        first_seen      timestamptz NOT NULL DEFAULT now(),
        last_seen       timestamptz NOT NULL DEFAULT now(),
        -- The count when the last email went out, so the next one can say how many since.
        count_at_notice integer NOT NULL DEFAULT 0,
        notified_at     timestamptz
      )
    `);
  });
  return pool;
}

/** Records an error. Never throws, so reporting a failure can't cause a second one. */
export async function reportError(source: ErrorSource, error: unknown, context: ErrorContext = {}): Promise<void> {
  const { message, stack } = describe(error);
  const where = context.where ?? "";
  console.error(`[${source}]${where ? ` ${where}` : ""}${context.slug ? ` ${context.slug}` : ""}: ${message}`);
  if (!databaseUrl()) return;
  try {
    const pool = await table();
    await pool.query(
      `INSERT INTO app_errors (fingerprint, source, location, message, stack, slug, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = app_errors.count + 1, last_seen = now(),
         message = EXCLUDED.message, stack = COALESCE(EXCLUDED.stack, app_errors.stack),
         slug = COALESCE(EXCLUDED.slug, app_errors.slug), detail = EXCLUDED.detail`,
      [
        fingerprint(source, where, message),
        source,
        where,
        message.slice(0, MAX_MESSAGE),
        stack?.slice(0, MAX_STACK) ?? null,
        context.slug ?? null,
        context.detail ?? null,
      ]
    );
  } catch (e) {
    console.warn(`[errors] could not record it: ${(e as Error).message}`);
  }
}

type Due = {
  fingerprint: string;
  source: string;
  location: string;
  message: string;
  stack: string | null;
  slug: string | null;
  count: number;
  before: number;
  first_seen: Date;
  last_seen: Date;
  was_notified: boolean;
};

/**
 * Hourly digest of error kinds seen since their last email and not mailed in the past 23 hours. Rows are marked in a transaction that
 * commits only after the mail is accepted, so a failed send retries next hour. Also deletes rows unseen for 90 days.
 */
export async function sendErrorDigest(): Promise<{ sent: number; reason?: string }> {
  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) return { sent: 0, reason: "ALERT_EMAIL is not set" };
  if (!databaseUrl()) return { sent: 0, reason: "no database" };
  if (!emailConfigured()) return { sent: 0, reason: "no mail transport" };
  const pool = await table();
  await pool.query(`DELETE FROM app_errors WHERE last_seen < now() - interval '90 days'`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Due>(
      `WITH due AS (
         SELECT fingerprint, count_at_notice AS before, notified_at IS NOT NULL AS was_notified FROM app_errors
         WHERE last_seen > COALESCE(notified_at, '-infinity') AND (notified_at IS NULL OR notified_at < now() - interval '23 hours')
         ORDER BY count - count_at_notice DESC
         LIMIT 25
         FOR UPDATE SKIP LOCKED
       )
       UPDATE app_errors e SET notified_at = now(), count_at_notice = e.count
       FROM due WHERE e.fingerprint = due.fingerprint
       RETURNING e.fingerprint, e.source, e.location, e.message, e.stack, e.slug, e.count, due.before, e.first_seen, e.last_seen, due.was_notified`
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return { sent: 0 };
    }
    rows.sort((a, b) => b.count - b.before - (a.count - a.before));
    const sent = await sendMail({ to, subject: digestSubject(rows), text: digestText(rows) });
    if (!sent.deliverable) {
      await client.query("ROLLBACK");
      return { sent: 0, reason: sent.error ?? sent.transport };
    }
    await client.query("COMMIT");
    return { sent: rows.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function digestSubject(rows: Due[]): string {
  const fresh = rows.filter((r) => !r.was_notified).length;
  const times = rows.reduce((n, r) => n + r.count - r.before, 0);
  const kinds = `${rows.length} kind${rows.length === 1 ? "" : "s"} of error`;
  return `${new URL(SITE_URL).host}: ${kinds}, ${times} time${times === 1 ? "" : "s"}${fresh ? ` (${fresh} new)` : ""}`;
}

function digestText(rows: Due[]): string {
  const site = SITE_URL;
  const blocks = rows.map((r) => {
    const since = r.count - r.before;
    const lines = [
      `${r.was_notified ? "" : "NEW  "}[${r.source}] ${r.location || "(no location)"}`,
      r.message,
      `${since} time${since === 1 ? "" : "s"} since the last email · ${r.count} in all · first ${r.first_seen.toISOString()} · last ${r.last_seen.toISOString()}`,
    ];
    if (r.slug) lines.push(`${site}/s/${r.slug}`);
    if (r.stack) lines.push("", ...r.stack.split("\n").slice(0, 8).map((l) => `    ${l.trim()}`));
    return lines.join("\n");
  });
  return [
    "Errors since the last email. Each kind is emailed at most once a day; the full list is the app_errors table.",
    "",
    blocks.join("\n\n―――\n\n"),
  ].join("\n");
}
