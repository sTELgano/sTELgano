-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Adds two pushed metrics so the admin dashboard can show real numbers
-- without polling Durable Objects:
--
--   live_counters.active_rooms   — global snapshot, +1 on room init,
--                                  -1 on room expiry (alarm or manual).
--                                  MAX(0, …) guards against any counter
--                                  going negative if a DO expires before
--                                  its init push was committed.
--
--   daily_metrics.messages_sent  — per-day count, +1 on every successful
--                                  send_message stored in the DO. Follows
--                                  the same UPSERT pattern as free_new
--                                  etc. so it is safe to increment from
--                                  many DO instances concurrently.
--
-- Both columns are fired-and-forgotten (void) in the DO hot path so they
-- never block a chat event.

CREATE TABLE IF NOT EXISTS live_counters (
  -- Enforce single-row constraint at the schema level.
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_rooms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the single row so UPDATE statements always find a target.
INSERT OR IGNORE INTO live_counters (id, active_rooms, updated_at)
  VALUES (1, 0, datetime('now'));

ALTER TABLE daily_metrics ADD COLUMN messages_sent INTEGER NOT NULL DEFAULT 0;
