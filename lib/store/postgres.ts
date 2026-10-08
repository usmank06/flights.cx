import { db, once } from "@/lib/db";
import type { FollowUp, SearchRecord, SearchSummary } from "@/lib/types";
import { publicRecord, summarise, type Store } from "./index";

/** Searches in Postgres: a jsonb column, since a record is always read and written in full, plus the columns queries sort on. */
/** Excludes deleted searches, which stay in the table for metrics. Every read but `update` uses it. */
const LIVE = `data->>'deletedAt' IS NULL`;

export async function postgresStore(url: string): Promise<Store> {
  const pool = db(url);

  await once("searches", async () => {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS searches (
      slug       text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      data       jsonb NOT NULL
    )
  `);
    await pool.query(`CREATE INDEX IF NOT EXISTS searches_created_at_idx ON searches (created_at DESC)`);
    // A signed-in traveller's searches. Partial, since most records have no owner.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS searches_user_idx
       ON searches ((data->>'userId'), created_at DESC)
       WHERE data->>'userId' IS NOT NULL`
    );
  });

  return {
    kind: "postgres",
    async create(record) {
      await pool.query(`INSERT INTO searches (slug, created_at, data) VALUES ($1, $2, $3)`, [record.slug, record.createdAt, record]);
    },

    async get(slug) {
      const { rows } = await pool.query<{ data: SearchRecord }>(`SELECT data FROM searches WHERE slug = $1 AND ${LIVE}`, [slug]);
      return rows[0]?.data ?? null;
    },

    async has(slug) {
      const { rowCount } = await pool.query(`SELECT 1 FROM searches WHERE slug = $1 AND ${LIVE}`, [slug]);
      return Boolean(rowCount);
    },

    async getPublic(slug) {
      // Leave out the session and the log: they're most of the record and never sent to clients.
      const { rows } = await pool.query<{ data: SearchRecord }>(`SELECT data - 'session' - 'events' AS data FROM searches WHERE slug = $1 AND ${LIVE}`, [slug]);
      return rows[0]?.data ? publicRecord(rows[0].data) : null;
    },

    async followUp(slug, id) {
      const { rows } = await pool.query<{ f: FollowUp | null }>(
        `SELECT (SELECT f FROM jsonb_array_elements(data->'followUps') f WHERE f->>'id' = $2 LIMIT 1) AS f
           FROM searches WHERE slug = $1 AND ${LIVE}`,
        [slug, id]
      );
      return rows[0]?.f ?? null;
    },

    async update(slug, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ data: SearchRecord }>(`SELECT data FROM searches WHERE slug = $1 FOR UPDATE`, [slug]);
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const next = mutate(rows[0].data);
        await client.query(`UPDATE searches SET data = $2 WHERE slug = $1`, [slug, next]);
        await client.query("COMMIT");
        return next;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    // Lists only need summary fields, so they leave out the session and the log as getPublic does.
    async forUser(userId, limit) {
      const { rows } = await pool.query<{ data: SearchRecord }>(
        `SELECT data - 'session' - 'events' AS data FROM searches WHERE data->>'userId' = $1 AND ${LIVE} ORDER BY created_at DESC LIMIT $2`,
        [userId, Math.max(1, Math.min(200, limit))]
      );
      return rows.map((r) => summarise(r.data));
    },

    async summaries(slugs) {
      if (!slugs.length) return [];
      const { rows } = await pool.query<{ data: SearchRecord }>(
        `SELECT data - 'session' - 'events' AS data FROM searches WHERE slug = ANY($1::text[]) AND ${LIVE} ORDER BY created_at DESC LIMIT 200`,
        [slugs.slice(0, 200)]
      );
      return rows.map((r) => summarise(r.data)) as SearchSummary[];
    },
  };
}
