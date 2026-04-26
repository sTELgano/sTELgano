// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for live_counters — a single-row table that tracks the
// current number of active rooms. Updated by push from the RoomDO
// at room creation and expiry so the admin dashboard gets a real
// number without polling Durable Objects.

export async function incrementActiveRooms(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO live_counters (id, active_rooms, updated_at) VALUES (1, 1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET active_rooms = active_rooms + 1, updated_at = excluded.updated_at",
    )
    .bind(now)
    .run();
}

export async function decrementActiveRooms(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE live_counters SET active_rooms = MAX(0, active_rooms - 1), updated_at = ? WHERE id = 1",
    )
    .bind(now)
    .run();
}

export async function getActiveRooms(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT active_rooms FROM live_counters WHERE id = 1")
    .first<{ active_rooms: number }>();
  return row?.active_rooms ?? 0;
}
