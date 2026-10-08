import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseUrl } from "@/lib/db";

/**
 * Account storage (users, sign-in codes and sessions): Postgres when DATABASE_URL is set, a JSON file otherwise. Codes and session
 * tokens are stored only as hashes.
 */

export type User = {
  id: string;
  email: string;
  createdAt: string;
  lastSeenAt: string;
};

type SentCode = {
  /** HMAC of the code; the code itself is never stored. */
  codeHash: string;
  expiresAt: string;
  sentAt: string;
};

type NewCode = SentCode & { email: string };

/**
 * All of an address's codes in one row: the newest in the top-level fields and older live ones in `earlier`, so asking again
 * doesn't void a code someone is typing.
 */
type PendingCode = NewCode & {
  /** Total guesses from every browser. Informational; the limit is per browser, in `callers`. */
  attempts: number;
  /** Older codes that may still work, newest first. */
  earlier?: SentCode[];
  /** Guesses per browser that requested a code (keyed by `callerKey`). Only these browsers may guess, each up to MAX_ATTEMPTS. */
  callers?: Record<string, number>;
};

export type CodeLimits = { keep: number; maxAttempts: number };

/** Result of counting a guess: the live hashes to compare against, or why there are none. */
export type Claim = { ok: true; codeHashes: string[]; attempts: number } | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" };

export type Session = {
  /** HMAC of the cookie value. The cookie itself is never stored. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

export interface AuthStore {
  readonly kind: "postgres" | "file";
  upsertUser(email: string): Promise<User>;
  userById(id: string): Promise<User | null>;
  /** Adds a code alongside the address's live ones, requested by `caller` (see `withCode`). */
  putCode(code: NewCode, limits: CodeLimits, caller: string): Promise<void>;
  /** The address's codes, including expired ones, or null. */
  getCode(email: string): Promise<PendingCode | null>;
  /** Atomically counts one of `caller`'s guesses and returns the live hashes (see `claimFor`). */
  claimAttempt(email: string, caller: string | null, max: number): Promise<Claim>;
  /** Removes one code (one the mail provider refused), keeping the others. */
  dropCode(email: string, codeHash: string): Promise<void>;
  /** Removes all of the address's codes, after a successful sign-in. */
  clearCode(email: string): Promise<void>;
  putSession(s: Session): Promise<void>;
  sessionByHash(hash: string): Promise<Session | null>;
  deleteSession(hash: string): Promise<void>;
  /** Deletes expired codes and sessions. Cheap enough to run on every code request. */
  sweep(): Promise<void>;
}

let cached: AuthStore | null = null;

export async function authStore(): Promise<AuthStore> {
  if (cached) return cached;
  cached = databaseUrl() ? await postgresAuth() : fileAuth();
  return cached;
}

/* ------------------------- Codes, for both stores ------------------------- */

/** Every code in the row, newest first. */
const codesOf = (p: PendingCode): SentCode[] => [
  { codeHash: p.codeHash, expiresAt: p.expiresAt, sentAt: p.sentAt },
  ...(p.earlier ?? []),
];
const liveOnly = (codes: SentCode[], now: number) => codes.filter((c) => Date.parse(c.expiresAt) > now);

const liveHashes = (p: PendingCode, now = Date.now()): string[] => liveOnly(codesOf(p), now).map((c) => c.codeHash);

/**
 * The address's codes after sending `next` to `caller`: `next` plus up to `keep - 1` older live codes. The caller's guess count
 * carries over while those codes are live, so asking again doesn't buy fresh guesses. A caller who used them all starts over.
 */
export function withCode(prev: PendingCode | null, next: NewCode, { keep, maxAttempts }: CodeLimits, caller: string, now = Date.now()): PendingCode {
  const kept = prev ? liveOnly(codesOf(prev), now).slice(0, keep - 1) : [];
  const callers = kept.length ? { ...prev?.callers } : {};
  if (callers[caller] == null || callers[caller] >= maxAttempts) callers[caller] = 0;
  return { ...next, attempts: prev && kept.length ? prev.attempts : 0, earlier: kept, callers };
}

/**
 * Counts one guess by `caller` and returns the live hashes to check. A browser that never asked gets "no-code", so a guess can't
 * reveal whether a code is pending. Only a browser that reached `max` is locked out.
 */
export function claimFor(prev: PendingCode | null, caller: string | null, max: number, now = Date.now()): { next: PendingCode | null; out: Claim } {
  const tries = caller ? prev?.callers?.[caller] : undefined;
  if (!prev || !caller || tries == null) return { next: prev, out: { ok: false, reason: "no-code" } };
  if (tries >= max) return { next: prev, out: { ok: false, reason: "too-many-attempts" } };
  const codeHashes = liveHashes(prev, now);
  if (!codeHashes.length) return { next: prev, out: { ok: false, reason: "expired" } };
  return { next: { ...prev, attempts: prev.attempts + 1, callers: { ...prev.callers, [caller]: tries + 1 } }, out: { ok: true, codeHashes, attempts: tries + 1 } };
}

/** Removes `codeHash`, or returns null if no code is left. The next newest code moves up, and its `sentAt` sets the cooldown. */
function withoutCode(prev: PendingCode, codeHash: string, now = Date.now()): PendingCode | null {
  const [newest, ...earlier] = liveOnly(codesOf(prev), now).filter((c) => c.codeHash !== codeHash);
  return newest ? { email: prev.email, ...newest, attempts: prev.attempts, earlier, callers: prev.callers } : null;
}

/* ------------------------------- Postgres -------------------------------- */

async function postgresAuth(): Promise<AuthStore> {
  const { db, once } = await import("@/lib/db");
  const pool = db();

  await once("auth", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           text PRIMARY KEY,
        email        text UNIQUE NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_codes (
        email      text PRIMARY KEY,
        code_hash  text NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts   integer NOT NULL DEFAULT 0,
        sent_at    timestamptz NOT NULL DEFAULT now(),
        earlier    jsonb NOT NULL DEFAULT '[]'::jsonb,
        callers    jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    // Adds columns to existing tables, which CREATE TABLE IF NOT EXISTS leaves unchanged. A row without `callers` allows no guesses
    // until a code is requested again.
    await pool.query(`ALTER TABLE auth_codes ADD COLUMN IF NOT EXISTS earlier jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE auth_codes ADD COLUMN IF NOT EXISTS callers jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash text PRIMARY KEY,
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at)`);
  });

  const toUser = (r: Record<string, unknown>): User => ({
    id: r.id as string,
    email: r.email as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
  });

  const toCode = (r: Record<string, unknown>): PendingCode => ({
    email: r.email as string,
    codeHash: r.code_hash as string,
    expiresAt: new Date(r.expires_at as string).toISOString(),
    attempts: Number(r.attempts),
    sentAt: new Date(r.sent_at as string).toISOString(),
    earlier: Array.isArray(r.earlier) ? (r.earlier as SentCode[]) : [],
    callers: r.callers && typeof r.callers === "object" ? (r.callers as Record<string, number>) : {},
  });

  /**
   * Read-modify-write of one address's codes in a transaction. The advisory lock serialises sends to an address with no row yet,
   * and FOR UPDATE serialises concurrent guesses. Returning the same row writes nothing.
   */
  const changeCodes = async <T>(email: string, change: (prev: PendingCode | null) => { next: PendingCode | null; out: T }): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('auth_codes:' || $1))`, [email]);
      const { rows } = await client.query(`SELECT * FROM auth_codes WHERE email = $1 FOR UPDATE`, [email]);
      const prev = rows[0] ? toCode(rows[0]) : null;
      const { next, out } = change(prev);
      if (next && next !== prev)
        await client.query(
          `INSERT INTO auth_codes (email, code_hash, expires_at, attempts, sent_at, earlier, callers)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
           ON CONFLICT (email) DO UPDATE SET
             code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
             attempts = EXCLUDED.attempts, sent_at = EXCLUDED.sent_at, earlier = EXCLUDED.earlier, callers = EXCLUDED.callers`,
          [next.email, next.codeHash, next.expiresAt, next.attempts, next.sentAt, JSON.stringify(next.earlier ?? []), JSON.stringify(next.callers ?? {})]
        );
      else if (!next && prev) await client.query(`DELETE FROM auth_codes WHERE email = $1`, [email]);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  return {
    kind: "postgres",

    async upsertUser(email) {
      // Upsert, so two tabs verifying at once don't hit a duplicate-key error.
      const { rows } = await pool.query(
        `INSERT INTO users (id, email) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
         RETURNING *`,
        [newId("usr"), email]
      );
      return toUser(rows[0]);
    },

    async userById(id) {
      const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },

    async putCode(code, limits, caller) {
      await changeCodes(code.email, (prev) => ({ next: withCode(prev, code, limits, caller), out: undefined }));
    },

    async getCode(email) {
      const { rows } = await pool.query(`SELECT * FROM auth_codes WHERE email = $1`, [email]);
      return rows[0] ? toCode(rows[0]) : null;
    },

    // Runs under the row locks, so concurrent guesses are counted in turn.
    claimAttempt: (email, caller, max) => changeCodes(email, (prev) => claimFor(prev, caller, max)),

    async dropCode(email, codeHash) {
      await changeCodes(email, (prev) => ({ next: prev ? withoutCode(prev, codeHash) : null, out: undefined }));
    },

    async clearCode(email) {
      await pool.query(`DELETE FROM auth_codes WHERE email = $1`, [email]);
    },

    async putSession(s) {
      await pool.query(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (token_hash) DO NOTHING`,
        [s.tokenHash, s.userId, s.createdAt, s.expiresAt]
      );
    },

    async sessionByHash(hash) {
      const { rows } = await pool.query(`SELECT * FROM sessions WHERE token_hash = $1`, [hash]);
      const r = rows[0];
      return r
        ? {
            tokenHash: r.token_hash,
            userId: r.user_id,
            createdAt: new Date(r.created_at).toISOString(),
            expiresAt: new Date(r.expires_at).toISOString(),
          }
        : null;
    },

    async deleteSession(hash) {
      await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hash]);
    },

    async sweep() {
      await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
      await pool.query(`DELETE FROM auth_codes WHERE expires_at < now()`);
    },
  };
}

/* --------------------------------- File ---------------------------------- */

type FileShape = { users: User[]; codes: PendingCode[]; sessions: Session[] };

function fileAuth(): AuthStore {
  const dir = join(process.cwd(), ".data");
  const path = join(dir, "auth.json");
  // One in-process lock for the file, since account writes are rare.
  let chain: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<FileShape> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as FileShape;
    } catch {
      return { users: [], codes: [], sessions: [] };
    }
  };
  const write = async (data: FileShape) => {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
  };
  const mutate = <T>(fn: (d: FileShape) => Promise<T> | T): Promise<T> => {
    const next = chain.then(async () => {
      const d = await read();
      const out = await fn(d);
      await write(d);
      return out;
    });
    chain = next.catch(() => {});
    return next;
  };

  return {
    kind: "file",

    upsertUser: (email) =>
      mutate((d) => {
        const now = new Date().toISOString();
        let u = d.users.find((x) => x.email === email);
        if (u) u.lastSeenAt = now;
        else {
          u = { id: newId("usr"), email, createdAt: now, lastSeenAt: now };
          d.users.push(u);
        }
        return u;
      }),

    userById: async (id) => (await read()).users.find((u) => u.id === id) ?? null,

    putCode: (code, limits, caller) =>
      mutate((d) => {
        const prev = d.codes.find((c) => c.email === code.email) ?? null;
        d.codes = d.codes.filter((c) => c.email !== code.email);
        d.codes.push(withCode(prev, code, limits, caller));
      }),

    getCode: async (email) => (await read()).codes.find((c) => c.email === email) ?? null,

    claimAttempt: (email, caller, max) =>
      mutate((d) => {
        const prev = d.codes.find((x) => x.email === email) ?? null;
        const { next, out } = claimFor(prev, caller, max);
        if (next && next !== prev) d.codes = d.codes.map((c) => (c === prev ? next : c));
        return out;
      }),

    dropCode: (email, codeHash) =>
      mutate((d) => {
        const prev = d.codes.find((c) => c.email === email);
        d.codes = d.codes.filter((c) => c.email !== email);
        const next = prev ? withoutCode(prev, codeHash) : null;
        if (next) d.codes.push(next);
      }),

    clearCode: (email) =>
      mutate((d) => {
        d.codes = d.codes.filter((c) => c.email !== email);
      }),

    putSession: (s) =>
      mutate((d) => {
        if (!d.sessions.some((x) => x.tokenHash === s.tokenHash)) d.sessions.push(s);
      }),

    sessionByHash: async (hash) => (await read()).sessions.find((s) => s.tokenHash === hash) ?? null,

    deleteSession: (hash) =>
      mutate((d) => {
        d.sessions = d.sessions.filter((s) => s.tokenHash !== hash);
      }),

    sweep: () =>
      mutate((d) => {
        const now = new Date().toISOString();
        d.sessions = d.sessions.filter((s) => s.expiresAt > now);
        d.codes = d.codes.filter((c) => c.expiresAt > now);
      }),
  };
}

function newId(prefix: string): string {
  // Shorter than a UUID, for readability in logs and URLs.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
