// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for live_counters — a single-row table that tracks the current
// number of active rooms, split by tier (free = weekly, paid = yearly).
// Updated by push from the RoomDO at room creation, tier conversion, and
// expiry so the admin dashboard gets a real number without polling Durable
// Objects. active_rooms is the maintained total (free_active + paid_active).

type Tier = "free" | "paid";

export type ActiveRooms = { total: number; free: number; paid: number };

export async function incrementActiveRooms(db: D1Database, tier: Tier): Promise<void> {
  const now = new Date().toISOString();
  const freeD = tier === "free" ? 1 : 0;
  const paidD = tier === "paid" ? 1 : 0;
  await db
    .prepare(
      "INSERT INTO live_counters (id, active_rooms, free_active, paid_active, updated_at) " +
        "VALUES (1, 1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET active_rooms = active_rooms + 1, " +
        "free_active = free_active + ?, paid_active = paid_active + ?, updated_at = excluded.updated_at",
    )
    .bind(freeD, paidD, now, freeD, paidD)
    .run();
}

export async function decrementActiveRooms(db: D1Database, tier: Tier): Promise<void> {
  const now = new Date().toISOString();
  const freeD = tier === "free" ? 1 : 0;
  const paidD = tier === "paid" ? 1 : 0;
  await db
    .prepare(
      "UPDATE live_counters SET active_rooms = MAX(0, active_rooms - 1), " +
        "free_active = MAX(0, free_active - ?), paid_active = MAX(0, paid_active - ?), " +
        "updated_at = ? WHERE id = 1",
    )
    .bind(freeD, paidD, now)
    .run();
}

/** Moves one active room from the free tier to the paid tier (a free →
 *  paid conversion). The total is unchanged. */
export async function convertActiveToPaid(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE live_counters SET free_active = MAX(0, free_active - 1), " +
        "paid_active = paid_active + 1, updated_at = ? WHERE id = 1",
    )
    .bind(now)
    .run();
}

export async function getActiveRooms(db: D1Database): Promise<ActiveRooms> {
  const row = await db
    .prepare("SELECT active_rooms, free_active, paid_active FROM live_counters WHERE id = 1")
    .first<{ active_rooms: number; free_active: number; paid_active: number }>();
  return {
    total: row?.active_rooms ?? 0,
    free: row?.free_active ?? 0,
    paid: row?.paid_active ?? 0,
  };
}
