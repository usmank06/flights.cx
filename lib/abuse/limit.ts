import { createHash, randomBytes } from "node:crypto";
import { databaseUrl, db, once } from "@/lib/db";
import { reportError } from "@/lib/errors";

/**
 * Rate limits: a backstop against abuse, set well above normal use. Keys are stored hashed. Counters live in Postgres when
 * DATABASE_URL is set (serverless instances share no memory), in memory otherwise. A counter that can't be read lets the
 * request through.
 */

export type Rule = { limit: number; windowMs: number };
export type LimitVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** The limits per route: a burst window and a day. Override with RATE_<NAME>="30/600,200/86400" (count/seconds). */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DEFAULTS: Record<string, Rule[]> = {
  search: [
    { limit: 30, windowMs: 10 * MIN },
    { limit: 200, windowMs: DAY },
  ],
  ask: [
    { limit: 60, windowMs: 10 * MIN },
    { limit: 500, windowMs: DAY },
  ],
  more: [{ limit: 150, windowMs: 10 * MIN }],
  grid: [{ limit: 60, windowMs: 10 * MIN }],
  intake: [{ limit: 300, windowMs: 10 * MIN }],
  // Sign-in codes per email address, counted for every caller, so nobody can flood a stranger's inbox.
  inbox: [
    { limit: 3, windowMs: 60 * MIN },
    { limit: 10, windowMs: DAY },
  ],
  watch: [{ limit: 30, windowMs: 60 * MIN }],
  // Book clicks: one global cap, far above real traffic, so a script can't fill the metrics table.
  book: [
    { limit: 1000, windowMs: 10 * MIN },
    { limit: 20000, windowMs: DAY },
  ],
  // The history lists on the home page and Your trips: one read per page load.
  searches: [{ limit: 120, windowMs: 10 * MIN }],
  // Deleting a search from Your trips.
  remove: [{ limit: 60, windowMs: 10 * MIN }],
  // Browser error reports, one global cap. A page sends at most five, and repeats of one error share a row (lib/errors.ts).
  errors: [
    { limit: 300, windowMs: 10 * MIN },
    { limit: 3000, windowMs: DAY },
  ],
};

function rulesFor(name: string): Rule[] {
  const raw = process.env[`RATE_${name.toUpperCase()}`];
  if (raw) {
    const parsed = raw
      .split(",")
      .map((r) => r.trim().match(/^(\d+)\/(\d+)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ limit: Number(m[1]), windowMs: Number(m[2]) * 1000 }));
    if (parsed.length) return parsed;
  }
  return DEFAULTS[name] ?? [];
}

const off = () => process.env.RATE_LIMITS === "off";

/**
 * Salt for the hashed keys, so a stored key can't be matched by hashing every possible address. AUTH_SECRET, else DATABASE_URL (also
 * secret, and the same on every instance sharing the counters), else a per-process value for in-memory counters.
 */
const SALT = process.env.AUTH_SECRET || process.env.DATABASE_URL || randomBytes(16).toString("hex");

const hashed = (id: string): string => createHash("sha256").update(`${SALT}:${id}`).digest("hex").slice(0, 24);

/* --------------------------------- Memory --------------------------------- */

type Bucket = { count: number; resetAt: number };

/**
 * One map per window length. Windows of one length end in insertion order, so ended ones are cleared from the front and the oldest
 * is evicted at MEMORY_CAP, without scanning the map.
 */
const memory = new Map<number, Map<string, Bucket>>();
const MEMORY_CAP = 10_000;

function hitMemory(bucket: string, rule: Rule, now: number): { count: number; retryMs: number } {
  let windows = memory.get(rule.windowMs);
  if (!windows) memory.set(rule.windowMs, (windows = new Map()));
  for (const [k, v] of windows) {
    if (v.resetAt > now) break;
    windows.delete(k);
  }
  const cur = windows.get(bucket);
  if (cur) {
    cur.count++;
    return { count: cur.count, retryMs: cur.resetAt - now };
  }
  windows.set(bucket, { count: 1, resetAt: now + rule.windowMs });
  if (windows.size > MEMORY_CAP) windows.delete(windows.keys().next().value!);
  return { count: 1, retryMs: rule.windowMs };
}

/* -------------------------------- Postgres -------------------------------- */

/** Uses the database's clock to set and check a window's end, so clock drift between app servers can't distort windows. */
async function hitPostgres(bucket: string, rule: Rule): Promise<{ count: number; retryMs: number }> {
  const pool = db();
  await once("rate_limits", async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS rate_limits (bucket text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL)`);
  });
  const { rows } = await pool.query<{ count: number; retry_ms: number }>(
    `INSERT INTO rate_limits (bucket, count, reset_at) VALUES ($1, 1, now() + $2::float8 * interval '1 millisecond')
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
     RETURNING count, (extract(epoch FROM reset_at - now()) * 1000)::float8 AS retry_ms`,
    [bucket, rule.windowMs]
  );
  // Occasionally prune ended windows so the table stays small.
  if (Math.random() < 0.02) void pool.query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`).catch(() => {});
  return { count: rows[0].count, retryMs: rows[0].retry_ms };
}

/**
 * Counts a request against every rule for `name`, per account. Signed-out requests pass uncounted, since reCAPTCHA covers them.
 * Behind Cloudflare, visitors share a handful of addresses, so per-IP limits would block real travellers.
 */
export function rateLimit(name: string, account: string | null): Promise<LimitVerdict> {
  return account ? rateLimitFor(name, `account:${account}`) : Promise.resolve({ ok: true });
}

/** One shared counter for all callers, for routes a script could use to fill the database. */
export const rateLimitEveryone = (name: string): Promise<LimitVerdict> => rateLimitFor(name, "everyone");

/**
 * Counts a request against every rule for `name`, keyed by `id` (stored hashed). Every rule is counted even when an earlier one is
 * already over, so a caller who keeps retrying stays blocked.
 */
export async function rateLimitFor(name: string, id: string): Promise<LimitVerdict> {
  if (off()) return { ok: true };
  const rules = rulesFor(name);
  if (!rules.length) return { ok: true };
  const who = hashed(id);
  const now = Date.now();
  let retry = 0;
  for (const rule of rules) {
    const bucket = `${name}:${rule.windowMs}:${who}`;
    try {
      const hit = databaseUrl() ? await hitPostgres(bucket, rule) : hitMemory(bucket, rule, now);
      if (hit.count > rule.limit) retry = Math.max(retry, Math.max(1, Math.ceil(hit.retryMs / 1000)));
    } catch (e) {
      void reportError("database", e, { where: `rate limit ${name}: could not count, so it let the request through` });
    }
  }
  return retry > 0 ? { ok: false, retryAfterS: retry } : { ok: true };
}

/** Undoes a `rateLimitFor` count for a request that had no effect, such as a sign-in code the mail provider refused. */
export async function refundFor(name: string, id: string): Promise<void> {
  if (off()) return;
  const who = hashed(id);
  const now = Date.now();
  for (const rule of rulesFor(name)) {
    const bucket = `${name}:${rule.windowMs}:${who}`;
    try {
      if (databaseUrl())
        await db().query(`UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE bucket = $1 AND reset_at > now()`, [bucket]);
      else {
        const cur = memory.get(rule.windowMs)?.get(bucket);
        if (cur && cur.resetAt > now) cur.count = Math.max(0, cur.count - 1);
      }
    } catch (e) {
      console.warn(`[limit] could not refund ${name} (${(e as Error).message})`);
    }
  }
}

/** A wait in words: "40 seconds", "12 minutes", "about 3 hours". */
export function waitWords(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} minutes`;
  if (mins < 90) return "about an hour";
  return `about ${Math.round(mins / 60)} hours`;
}

/** The 429 response every rate-limited route returns. */
export function tooMany(v: { retryAfterS: number }): Response {
  // Only day-long rules wait over an hour, so longer waits get the "one day" wording.
  const error =
    v.retryAfterS > 20 * 3600
      ? "That's a lot for one day. Try again tomorrow."
      : v.retryAfterS > 3600
        ? `That's a lot for one day. Give it ${waitWords(v.retryAfterS)} and try again.`
        : `That's a lot in a short time. Give it ${waitWords(v.retryAfterS)} and try again.`;
  return Response.json({ error }, { status: 429, headers: { "retry-after": String(v.retryAfterS) } });
}
