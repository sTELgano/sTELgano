// SPDX-License-Identifier: AGPL-3.0-only
//
// TEMPORARY — one-time backfill of historical analytics from Analytics
// Engine into the new daily_metrics D1 table. Triggered by the "Restore
// from Analytics Engine" button on /admin. AE was the previous analytics
// store; its data survives for ~90 days after each write, so this recovers
// the pre-cutover history the dashboard would otherwise have lost.
//
// DELETE THIS FILE (and its route + button in _worker.ts, plus the
// CF_ACCOUNT_ID / CF_AE_DATASET vars in wrangler.toml and CF_AE_API_TOKEN in
// src/env.ts) once the backfill has been run and verified.
//
// Queries the AE SQL API directly (account id + read token + dataset) — it
// does NOT reintroduce the [[analytics_engine_datasets]] binding (that tripped
// an esbuild deadlock in the test pool).
//
// Old AE write schema (from the removed src/lib/analytics.ts):
//   room/message events: blob1 = metric, blob2 = steg country, blob3 = cf country
//   funnel events:       blob1 = "funnel", blob2 = step, blob3 = cf country, blob4 = campaign
//   _sample_interval     = AE's sampling weight; SUM() de-biases the count.

import type { Env } from "../env";
import { isFunnelStep } from "./daily_metrics";

const AE_SQL_BASE = "https://api.cloudflare.com/client/v4/accounts";
// A day outside any dashboard range, used as an idempotency marker so a
// second click doesn't double-count.
const SENTINEL_DAY = "1970-01-01";
const SENTINEL_METRIC = "_ae_migrated";

const ROOM_METRICS = [
  "room_free",
  "room_paid",
  "room_extended",
  "room_rejoin",
  "room_expired_free",
  "room_expired_paid",
  "message_sent",
];

export type BackfillResult = {
  ok: boolean;
  alreadyDone?: boolean;
  rows: number;
  events: number;
  error?: string;
};

type AeRow = Record<string, unknown>;

async function aeQuery(accountId: string, token: string, sql: string): Promise<AeRow[]> {
  const resp = await fetch(`${AE_SQL_BASE}/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: sql,
  });
  if (!resp.ok) throw new Error(`AE SQL HTTP ${resp.status}`);
  const json = (await resp.json()) as { data?: AeRow[] };
  return json.data ?? [];
}

const day10 = (v: unknown): string => String(v ?? "").slice(0, 10);
const int = (v: unknown): number => Math.round(Number(v ?? 0));

/** Backfills AE's last ~90 days of aggregates into daily_metrics. Idempotent
 *  via a sentinel row unless `force` is set. Returns a summary for the UI. */
export async function backfillFromAE(env: Env, force = false): Promise<BackfillResult> {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_AE_API_TOKEN;
  const dataset = env.CF_AE_DATASET;
  if (!accountId || !token || !dataset) {
    return {
      ok: false,
      rows: 0,
      events: 0,
      error: "AE not configured (account id / token / dataset missing)",
    };
  }
  const db = env.DB;

  if (!force) {
    const done = await db
      .prepare("SELECT 1 FROM daily_metrics WHERE metric = ? LIMIT 1")
      .bind(SENTINEL_METRIC)
      .first();
    if (done) return { ok: true, alreadyDone: true, rows: 0, events: 0 };
  }

  let roomRows: AeRow[];
  let funnelRows: AeRow[];
  try {
    const inList = ROOM_METRICS.map((m) => `'${m}'`).join(",");
    roomRows = await aeQuery(
      accountId,
      token,
      `SELECT blob1 AS metric, blob2 AS steg, blob3 AS cf, toDate(timestamp) AS day,
              SUM(_sample_interval) AS cnt
       FROM ${dataset}
       WHERE blob1 IN (${inList})
       GROUP BY metric, steg, cf, day
       LIMIT 100000`,
    );
    funnelRows = await aeQuery(
      accountId,
      token,
      `SELECT blob2 AS step, blob3 AS cf, blob4 AS campaign, toDate(timestamp) AS day,
              SUM(_sample_interval) AS cnt
       FROM ${dataset}
       WHERE blob1 = 'funnel'
       GROUP BY step, cf, campaign, day
       LIMIT 100000`,
    );
  } catch (e) {
    return { ok: false, rows: 0, events: 0, error: (e as Error).message };
  }

  const stmt = db.prepare(
    `INSERT INTO daily_metrics (day, metric, steg_country, cf_country, dim, count, sum_value)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(day, metric, steg_country, cf_country, dim)
     DO UPDATE SET count = count + excluded.count`,
  );

  const stmts: D1PreparedStatement[] = [];
  let events = 0;

  for (const r of roomRows) {
    const day = day10(r.day);
    const metric = String(r.metric ?? "");
    const cnt = int(r.cnt);
    if (!day || !ROOM_METRICS.includes(metric) || cnt <= 0) continue;
    stmts.push(stmt.bind(day, metric, String(r.steg ?? ""), String(r.cf ?? ""), "", cnt));
    events += cnt;
  }
  for (const r of funnelRows) {
    const step = String(r.step ?? "");
    if (!isFunnelStep(step)) continue;
    const day = day10(r.day);
    const cnt = int(r.cnt);
    if (!day || cnt <= 0) continue;
    const campaign = String(r.campaign ?? "").trim() || "direct";
    stmts.push(stmt.bind(day, `funnel_${step}`, "", String(r.cf ?? ""), campaign, cnt));
    events += cnt;
  }

  const dataRows = stmts.length;
  // Idempotency sentinel (also re-affirmed on a forced re-run; harmless).
  stmts.push(stmt.bind(SENTINEL_DAY, SENTINEL_METRIC, "", "", "", 1));

  // Apply in chunks to stay well within D1 batch limits.
  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await db.batch(stmts.slice(i, i + CHUNK));
  }

  return { ok: true, rows: dataRows, events };
}
