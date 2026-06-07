-- SPDX-License-Identifier: AGPL-3.0-only
--
-- daily_metrics — the single, exact, permanent analytics store. Replaces
-- Cloudflare Analytics Engine entirely (see the Telemetry section of
-- CLAUDE.md). Every product/security signal is rolled up to one row per
-- (day × metric × steg_country × cf_country × dim) and incremented through
-- a Cloudflare Queue consumer (one batched, coalesced UPSERT per batch) so
-- the chat hot path never touches D1. Unlike AE this is exact (no sampling)
-- and never expires (no 90-day retention cap).
--
-- PRIVACY (preserved from the AE design and the no-room_id rule on
-- extension_tokens): this table holds NO room_hash, access_hash, phone,
-- IP, sender_hash, payment reference, or per-event timestamp. The only
-- dimensions are a UTC day, a metric key, two 2-char ISO country codes,
-- and an operator-defined `dim` (campaign slug for funnel rows, or a
-- coarse distribution bucket label). Nothing here links to an individual
-- room or person.
--
-- Column semantics:
--   day          — 'YYYY-MM-DD' UTC, bucketed from each event's emit time
--   metric       — MetricKey from src/lib/daily_metrics.ts (incl. funnel_<step>)
--   steg_country — ISO-3166 alpha-2 of the steg number, or '' (global events)
--   cf_country   — CF-IPCountry alpha-2, or '' (global events)
--   dim          — extra dimension: campaign slug | distribution bucket | ''
--   count        — number of events
--   sum_value    — summed numeric payload (seconds / hours) for distributions;
--                  avg = sum_value / count. 0 for pure counters.
--
-- SQLite type notes (mirror 0005_create_campaigns.sql):
--   - day/metric/country/dim: TEXT
--   - count: INTEGER, sum_value: REAL (distributions carry fractional values)

CREATE TABLE daily_metrics (
  day          TEXT NOT NULL,
  metric       TEXT NOT NULL,
  steg_country TEXT NOT NULL DEFAULT '',
  cf_country   TEXT NOT NULL DEFAULT '',
  dim          TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 0,
  sum_value    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, steg_country, cf_country, dim)
);

-- Read indexes for the admin dashboard. The PK already serves the UPSERT
-- conflict lookup; these two cover the dashboard's range scans without
-- over-indexing a write table.
CREATE INDEX daily_metrics_metric_day_idx ON daily_metrics(metric, day);
CREATE INDEX daily_metrics_day_idx ON daily_metrics(day);
