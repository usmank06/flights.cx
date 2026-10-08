import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { databaseUrl } from "@/lib/db";
import type { NewWatch, PriceWatch } from "./types";

/** Watch storage (Postgres or file). Data lives in jsonb, with real columns only for the owner and the next run time. */
export interface WatchStore {
  readonly kind: "postgres" | "file";
  create(watch: NewWatch): Promise<PriceWatch>;
  get(id: string): Promise<PriceWatch | null>;
  /** Active watches whose next run is in the past, oldest first. */
  due(now: string, limit: number): Promise<PriceWatch[]>;
  /** Active watches with a re-run outstanding, so the tick can collect results. */
  pending(limit: number): Promise<PriceWatch[]>;
  forUser(userId: string): Promise<PriceWatch[]>;
  update(id: string, mutate: (w: PriceWatch) => PriceWatch): Promise<PriceWatch | null>;
  /** Claims a watch unless a live tick holds it, else null. A compare-and-set inside one `update`, so it's atomic. */
  claim(id: string, holder: string, lockMs: number): Promise<PriceWatch | null>;
  /** Releases the claim, applying `patch` in the same write. */
  release(id: string, holder: string, patch?: (w: PriceWatch) => PriceWatch): Promise<PriceWatch | null>;
  remove(id: string): Promise<void>;
}

let cached: WatchStore | null = null;

export async function watchStore(): Promise<WatchStore> {
  if (cached) return cached;
  cached = databaseUrl() ? await postgresWatches() : fileWatches();
  return cached;
}

type Update = WatchStore["update"];

/** Claim and release built on an adapter's `update`, which both serialise (a row lock in Postgres, an in-process chain for files). */
function claimHelpers(update: Update): Pick<WatchStore, "claim" | "release"> {
  return {
    async claim(id, holder, lockMs) {
      const cutoff = Date.now() - lockMs;
      let took = false;
      const next = await update(id, (w) => {
        if (w.lockedAt && Date.parse(w.lockedAt) > cutoff) return w; // a live tick holds it
        took = true;
        return { ...w, lockedBy: holder, lockedAt: new Date().toISOString() };
      });
      // Check `took`: comparing holders alone would return the watch to a tick that already holds it.
      return took && next?.lockedBy === holder ? next : null;
    },

    async release(id, holder, patch) {
      return update(id, (w) => {
        // Only the holder may release. A run whose lock expired must not clear another run's lock or overwrite its work, even after
        // that run has released.
        if (w.lockedBy !== holder) return w;
        const next = patch ? patch(w) : w;
        return { ...next, lockedBy: null, lockedAt: null };
      });
    },
  };
}

function newWatch(input: NewWatch): PriceWatch {
  const now = new Date().toISOString();
  return {
    id: `wch_${randomBytes(9).toString("hex")}`,
    ...input,
    createdAt: now,
    // First run is one interval out, so it doesn't repeat the search the traveller just saw.
    nextRunAt: new Date(Date.now() + input.everyHours * 3600_000).toISOString(),
    lastRunAt: null,
    pendingSlug: null,
    lastNotifiedPrice: null,
    lastNotifiedAt: null,
    notifications: 0,
    lockedBy: null,
    lockedAt: null,
    status: "active",
  };
}

/* ------------------------------- Postgres -------------------------------- */

async function postgresWatches(): Promise<WatchStore> {
  const { db, once } = await import("@/lib/db");
  const pool = db();

  await once("watches", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS watches (
        id           text PRIMARY KEY,
        user_id      text NOT NULL,
        next_run_at  timestamptz NOT NULL,
        data         jsonb NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS watches_user_idx ON watches (user_id)`);
    // For the scheduler's due query. Partial, since only active watches are ever due.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS watches_due_idx ON watches (next_run_at)
         WHERE data->>'status' = 'active'`
    );
  });

  const toWatch = (r: { data: PriceWatch }) => r.data;

  const update: Update = async (id, mutate) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ data: PriceWatch }>(
        `SELECT data FROM watches WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const next = mutate(rows[0].data);
      await client.query(`UPDATE watches SET data = $2, next_run_at = $3 WHERE id = $1`, [
        id,
        next,
        next.nextRunAt,
      ]);
      await client.query("COMMIT");
      return next;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  return {
    kind: "postgres",

    async create(input) {
      const w = newWatch(input);
      await pool.query(`INSERT INTO watches (id, user_id, next_run_at, data) VALUES ($1,$2,$3,$4)`, [
        w.id,
        w.userId,
        w.nextRunAt,
        w,
      ]);
      return w;
    },

    async get(id) {
      const { rows } = await pool.query<{ data: PriceWatch }>(`SELECT data FROM watches WHERE id = $1`, [id]);
      return rows[0] ? toWatch(rows[0]) : null;
    },

    async due(now, limit) {
      const { rows } = await pool.query<{ data: PriceWatch }>(
        `SELECT data FROM watches
          WHERE data->>'status' = 'active'
            AND next_run_at <= $1
            AND data->>'pendingSlug' IS NULL
          ORDER BY next_run_at ASC LIMIT $2`,
        [now, Math.max(1, Math.min(200, limit))]
      );
      return rows.map(toWatch);
    },

    async pending(limit) {
      const { rows } = await pool.query<{ data: PriceWatch }>(
        `SELECT data FROM watches
          WHERE data->>'status' = 'active' AND data->>'pendingSlug' IS NOT NULL
          ORDER BY next_run_at ASC LIMIT $1`,
        [Math.max(1, Math.min(200, limit))]
      );
      return rows.map(toWatch);
    },

    async forUser(userId) {
      const { rows } = await pool.query<{ data: PriceWatch }>(
        `SELECT data FROM watches WHERE user_id = $1 ORDER BY next_run_at ASC LIMIT 200`,
        [userId]
      );
      return rows.map(toWatch);
    },

    update,

    async remove(id) {
      await pool.query(`DELETE FROM watches WHERE id = $1`, [id]);
    },

    ...claimHelpers(update),
  };
}

/* --------------------------------- File ---------------------------------- */

function fileWatches(): WatchStore {
  const dir = join(process.cwd(), ".data");
  const path = join(dir, "watches.json");
  let chain: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<PriceWatch[]> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as PriceWatch[];
    } catch {
      return [];
    }
  };
  const mutate = <T>(fn: (d: PriceWatch[]) => T): Promise<T> => {
    const next = chain.then(async () => {
      const d = await read();
      const out = fn(d);
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(d, null, 2), "utf8");
      await rename(tmp, path);
      return out;
    });
    chain = next.catch(() => {});
    return next;
  };

  const update: Update = (id, fn) =>
    mutate((d) => {
      const i = d.findIndex((w) => w.id === id);
      if (i < 0) return null;
      d[i] = fn(d[i]);
      return d[i];
    });

  return {
    kind: "file",
    create: (input) =>
      mutate((d) => {
        const w = newWatch(input);
        d.push(w);
        return w;
      }),
    get: async (id) => (await read()).find((w) => w.id === id) ?? null,
    due: async (now, limit) =>
      (await read())
        .filter((w) => w.status === "active" && !w.pendingSlug && w.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
        .slice(0, limit),
    pending: async (limit) =>
      (await read()).filter((w) => w.status === "active" && w.pendingSlug).slice(0, limit),
    forUser: async (userId) =>
      (await read()).filter((w) => w.userId === userId).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)),
    update,
    remove: (id) =>
      mutate((d) => {
        const i = d.findIndex((w) => w.id === id);
        if (i >= 0) d.splice(i, 1);
      }),

    ...claimHelpers(update),
  };
}
