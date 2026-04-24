-- SPDX-License-Identifier: AGPL-3.0-only
--
-- D1 (SQLite) port of v1's country_metrics table.
-- Original: elixir/priv/repo/migrations/20260418164047_create_country_metrics.exs
--
-- PRIVACY MODEL (preserved from v1): one row per ISO-3166 alpha-2 country
-- code, two monotonic counters (free_rooms, paid_rooms). No row links to
-- a specific room_hash, token_hash, or phone. A DB dump answers "how
-- many rooms from Kenya?" but never "which rooms from Kenya?".
--
-- Country code is stored uppercased; the TS access module enforces this
-- at insert time. SQLite's type is TEXT (no native CHAR(2)).
--
-- Counters are lifetime-cumulative — incremented on free room creation
-- (via increment_free) and on paid upgrade (via increment_paid), never
-- decremented. The single-statement UPSERT pattern in the access module
-- avoids read-modify-write races.

CREATE TABLE country_metrics (
  country_code TEXT PRIMARY KEY NOT NULL,
  free_rooms INTEGER NOT NULL DEFAULT 0,
  paid_rooms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
