import { Pool } from "pg";

/**
 * One Postgres pool per process, shared by every store, since all serverless instances draw on one connection limit. Kept small
 * with a short idle timeout because Neon closes idle connections.
 */
let pool: Pool | null = null;

/**
 * The database URL, or null to use files under .data/. FLIGHTS_STORE=file overrides DATABASE_URL, since Next.js loads .env locally
 * regardless of the shell and a local run must not touch the production database.
 */
export function databaseUrl(): string | null {
  return process.env.FLIGHTS_STORE === "file" ? null : process.env.DATABASE_URL || null;
}

export function db(url = databaseUrl() ?? undefined): Pool {
  if (!url) throw new Error("No database: DATABASE_URL is not set, or FLIGHTS_STORE=file");
  if (pool) return pool;
  pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 20_000,
    // Fail one call after 10 s instead of holding a search until its route times out.
    connectionTimeoutMillis: 10_000,
    // A local Postgres has no certificate worth verifying; a hosted one is reached over a URL that already pins the host.
    ssl: url.includes("localhost") || url.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false },
  });
  // An unhandled 'error' event crashes the process. The pool replaces failed clients itself, so these only log: the pool listener
  // covers idle clients and the client listener covers checked-out ones. Failed queries are reported by their callers.
  pool.on("error", (e) => console.warn(`[db] an idle connection closed: ${e.message}`));
  pool.on("connect", (client) => client.on("error", (e) => console.warn(`[db] a connection closed: ${e.message}`)));
  return pool;
}

/** Runs each schema setup once per process. Adapters create their own tables on first use, so a new database needs only a URL. */
const done = new Map<string, Promise<void>>();

export function once(key: string, fn: () => Promise<void>): Promise<void> {
  let p = done.get(key);
  if (!p) {
    p = fn().catch((e) => {
      // Don't cache a failure, so the next caller retries.
      done.delete(key);
      throw e;
    });
    done.set(key, p);
  }
  return p;
}
