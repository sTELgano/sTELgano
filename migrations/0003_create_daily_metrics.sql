-- SPDX-License-Identifier: AGPL-3.0-only
--
-- D1 (SQLite) port of v1's daily_metrics table.
-- Original: elixir/priv/repo/migrations/20260418165541_create_daily_metrics.exs
--
-- One row per UTC calendar day with four monotonic counters:
--   - free_new: free-tier rooms created that day
--   - paid_new: paid-tier upgrades that day
--   - free_expired: free-tier rooms that TTL-expired that day
--   - paid_expired: paid-tier rooms that TTL-expired that day
--
-- WHY NO COUNTRY DIMENSION (preserved from v1): expiry events fire
-- without per-room country knowledge. The DO holds no country_code
-- field (deliberately — that would undo server-blindness for the
-- country axis). Rather than making "new" events per-country and
-- "expired" events global (asymmetric), all four counters are global
-- here. Country-scoped lifetime totals live in country_metrics.
--
-- "day" stored as TEXT in YYYY-MM-DD form. SQLite has no DATE type but
-- ISO 8601 dates sort lexically and parse trivially in JS.

CREATE TABLE daily_metrics (
  day TEXT PRIMARY KEY NOT NULL,
  free_new INTEGER NOT NULL DEFAULT 0,
  paid_new INTEGER NOT NULL DEFAULT 0,
  free_expired INTEGER NOT NULL DEFAULT 0,
  paid_expired INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
