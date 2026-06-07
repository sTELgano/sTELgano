-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Split the live active-room snapshot by tier so the admin dashboard can
-- show how many *weekly (free)* vs *yearly (paid)* numbers are live right
-- now, not just a single total.
--
--   free_active — active rooms currently on the free (weekly) tier
--   paid_active — active rooms currently on the paid (yearly) tier
--
-- active_rooms stays the maintained total (free_active + paid_active). The
-- RoomDO moves a count from free_active to paid_active when a free number
-- is extended to paid, and decrements the appropriate tier on expiry. As
-- with active_rooms, MAX(0, …) guards against a counter underflowing if a
-- DO expires before its init push committed.
--
-- PRIVACY: still a single global row of counts — no per-room data.

ALTER TABLE live_counters ADD COLUMN free_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_counters ADD COLUMN paid_active INTEGER NOT NULL DEFAULT 0;
