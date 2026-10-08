import { db, once } from "@/lib/db";
import { dayOf, EMPTY_ROLLUP, foldEvent, rollupKey } from "./types";
import type { DailyRollup, MetricEvent, MetricEventType } from "./types";
import type { MetricsStore } from "./index";

/** Metrics in Postgres: raw events plus a daily rollup upserted with each event, so stats never scan the raw table. */
export async function postgresMetrics(url: string): Promise<MetricsStore> {
  const pool = db(url);

  await once("metrics", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metric_events (
        id         bigserial PRIMARY KEY,
        at         timestamptz NOT NULL,
        type       text NOT NULL,
        -- The search this is about, when there is one. NOT a foreign key: a
        -- metric must outlive the record it describes, and deleting a search
        -- must never delete the evidence that it happened.
        slug       text,
        signed_in  boolean NOT NULL DEFAULT false,
        data       jsonb NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS metric_events_at_idx ON metric_events (at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS metric_events_type_at_idx ON metric_events (type, at DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS metric_daily (
        day                    date NOT NULL,
        haul                   text NOT NULL,
        flexible               boolean NOT NULL,
        open_destination       boolean NOT NULL,
        searches               integer NOT NULL DEFAULT 0,
        completed              integer NOT NULL DEFAULT 0,
        failed                 integer NOT NULL DEFAULT 0,
        -- Searches with BOTH a baseline and a best price. Every sum below that
        -- involves money is over these and only these, so a mean is always
        -- sum / compared and never sum / searches.
        compared               integer NOT NULL DEFAULT 0,
        sum_baseline           bigint  NOT NULL DEFAULT 0,
        sum_best               bigint  NOT NULL DEFAULT 0,
        sum_saved              bigint  NOT NULL DEFAULT 0,
        not_beaten             integer NOT NULL DEFAULT 0,
        -- Positive savings only, in whole US dollars (lib/metrics/usd.ts).
        sum_saved_usd          bigint  NOT NULL DEFAULT 0,
        sum_itineraries        bigint  NOT NULL DEFAULT 0,
        sum_duration_ms        bigint  NOT NULL DEFAULT 0,
        sum_failed_duration_ms bigint  NOT NULL DEFAULT 0,
        sum_queries            bigint  NOT NULL DEFAULT 0,
        sum_rounds             bigint  NOT NULL DEFAULT 0,
        sum_model_cost_usd     numeric(12,6) NOT NULL DEFAULT 0,
        price_ranked_fallbacks integer NOT NULL DEFAULT 0,
        rejected               integer NOT NULL DEFAULT 0,
        book_clicks            integer NOT NULL DEFAULT 0,
        follow_ups             integer NOT NULL DEFAULT 0,
        watches_created        integer NOT NULL DEFAULT 0,
        watch_emails_sent      integer NOT NULL DEFAULT 0,
        sign_ins               integer NOT NULL DEFAULT 0,
        PRIMARY KEY (day, haul, flexible, open_destination)
      )
    `);
    // Adds columns to existing tables, which CREATE TABLE IF NOT EXISTS leaves unchanged.
    await pool.query(`ALTER TABLE metric_daily ADD COLUMN IF NOT EXISTS rejected integer NOT NULL DEFAULT 0`);
    await pool.query(
      `ALTER TABLE metric_daily ADD COLUMN IF NOT EXISTS sum_failed_duration_ms bigint NOT NULL DEFAULT 0`
    );
    await pool.query(`ALTER TABLE metric_daily ADD COLUMN IF NOT EXISTS sum_saved_usd bigint NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE metric_daily ADD COLUMN IF NOT EXISTS sum_itineraries bigint NOT NULL DEFAULT 0`);
  });

  return {
    kind: "postgres",

    async record(event) {
      await pool.query(
        `INSERT INTO metric_events (at, type, slug, signed_in, data) VALUES ($1, $2, $3, $4, $5)`,
        [event.at, event.type, event.slug, event.signedIn, { shape: event.shape, outcome: event.outcome, detail: event.detail }]
      );

      // Compute the delta with the shared fold, so both adapters use the same arithmetic.
      const k = rollupKey(event);
      const day = dayOf(event.at);
      const d = foldEvent(EMPTY_ROLLUP(day, k.haul, k.flexible, k.openDestination), event);

      await pool.query(
        `INSERT INTO metric_daily (
           day, haul, flexible, open_destination,
           searches, completed, failed, compared,
           sum_baseline, sum_best, sum_saved, not_beaten,
           sum_duration_ms, sum_failed_duration_ms, sum_queries, sum_rounds, sum_model_cost_usd,
           price_ranked_fallbacks, rejected, book_clicks, follow_ups,
           watches_created, watch_emails_sent, sign_ins,
           sum_saved_usd, sum_itineraries
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (day, haul, flexible, open_destination) DO UPDATE SET
           searches               = metric_daily.searches               + EXCLUDED.searches,
           completed              = metric_daily.completed              + EXCLUDED.completed,
           failed                 = metric_daily.failed                 + EXCLUDED.failed,
           compared               = metric_daily.compared               + EXCLUDED.compared,
           sum_baseline           = metric_daily.sum_baseline           + EXCLUDED.sum_baseline,
           sum_best               = metric_daily.sum_best               + EXCLUDED.sum_best,
           sum_saved              = metric_daily.sum_saved              + EXCLUDED.sum_saved,
           not_beaten             = metric_daily.not_beaten             + EXCLUDED.not_beaten,
           sum_duration_ms        = metric_daily.sum_duration_ms        + EXCLUDED.sum_duration_ms,
           sum_failed_duration_ms = metric_daily.sum_failed_duration_ms + EXCLUDED.sum_failed_duration_ms,
           sum_queries            = metric_daily.sum_queries            + EXCLUDED.sum_queries,
           sum_rounds             = metric_daily.sum_rounds             + EXCLUDED.sum_rounds,
           sum_model_cost_usd     = metric_daily.sum_model_cost_usd     + EXCLUDED.sum_model_cost_usd,
           price_ranked_fallbacks = metric_daily.price_ranked_fallbacks + EXCLUDED.price_ranked_fallbacks,
           rejected               = metric_daily.rejected               + EXCLUDED.rejected,
           book_clicks            = metric_daily.book_clicks            + EXCLUDED.book_clicks,
           follow_ups             = metric_daily.follow_ups             + EXCLUDED.follow_ups,
           watches_created        = metric_daily.watches_created        + EXCLUDED.watches_created,
           watch_emails_sent      = metric_daily.watch_emails_sent      + EXCLUDED.watch_emails_sent,
           sign_ins               = metric_daily.sign_ins               + EXCLUDED.sign_ins,
           sum_saved_usd          = metric_daily.sum_saved_usd          + EXCLUDED.sum_saved_usd,
           sum_itineraries        = metric_daily.sum_itineraries        + EXCLUDED.sum_itineraries`,
        [
          day, k.haul, k.flexible, k.openDestination,
          d.searches, d.completed, d.failed, d.compared,
          Math.round(d.sumBaseline), Math.round(d.sumBest), Math.round(d.sumSaved), d.notBeaten,
          d.sumDurationMs, d.sumFailedDurationMs, d.sumQueries, d.sumRounds, d.sumModelCostUsd,
          d.priceRankedFallbacks, d.rejected, d.bookClicks, d.followUps,
          d.watchesCreated, d.watchEmailsSent, d.signIns,
          Math.round(d.sumSavedUsd), d.sumItineraries,
        ]
      );
    },

    /** Everything the stats page needs, in one query. */
    async rollups(fromDay, toDay) {
      const { rows } = await pool.query(
        `SELECT * FROM metric_daily WHERE day >= $1::date AND day <= $2::date ORDER BY day ASC, haul ASC`,
        [fromDay, toDay]
      );
      return rows.map(
        (r): DailyRollup => ({
          day: typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10),
          haul: r.haul,
          flexible: r.flexible,
          openDestination: r.open_destination,
          searches: Number(r.searches),
          completed: Number(r.completed),
          failed: Number(r.failed),
          compared: Number(r.compared),
          sumBaseline: Number(r.sum_baseline),
          sumBest: Number(r.sum_best),
          sumSaved: Number(r.sum_saved),
          notBeaten: Number(r.not_beaten),
          sumSavedUsd: Number(r.sum_saved_usd ?? 0),
          sumItineraries: Number(r.sum_itineraries ?? 0),
          sumDurationMs: Number(r.sum_duration_ms),
          sumFailedDurationMs: Number(r.sum_failed_duration_ms ?? 0),
          sumQueries: Number(r.sum_queries),
          sumRounds: Number(r.sum_rounds),
          sumModelCostUsd: Number(r.sum_model_cost_usd),
          priceRankedFallbacks: Number(r.price_ranked_fallbacks),
          rejected: Number(r.rejected ?? 0),
          bookClicks: Number(r.book_clicks),
          followUps: Number(r.follow_ups),
          watchesCreated: Number(r.watches_created),
          watchEmailsSent: Number(r.watch_emails_sent),
          signIns: Number(r.sign_ins),
        })
      );
    },

    async recent(limit, type) {
      const { rows } = await pool.query(
        type
          ? `SELECT at, type, slug, signed_in, data FROM metric_events WHERE type = $2 ORDER BY at DESC LIMIT $1`
          : `SELECT at, type, slug, signed_in, data FROM metric_events ORDER BY at DESC LIMIT $1`,
        type ? [Math.min(1000, limit), type] : [Math.min(1000, limit)]
      );
      return rows.map(
        (r): MetricEvent => ({
          at: new Date(r.at).toISOString(),
          type: r.type as MetricEventType,
          slug: r.slug,
          signedIn: r.signed_in,
          shape: r.data?.shape ?? null,
          outcome: r.data?.outcome ?? null,
          detail: r.data?.detail ?? {},
        })
      );
    },

    async allTime() {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(searches), 0) AS searches, COALESCE(SUM(sum_itineraries), 0) AS flights, COALESCE(SUM(sum_saved_usd), 0) AS saved_usd
         FROM metric_daily`
      );
      return { searches: Number(rows[0].searches), flights: Number(rows[0].flights), savedUsd: Number(rows[0].saved_usd) };
    },
  };
}
