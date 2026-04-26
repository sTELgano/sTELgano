// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for daily_metrics. Ports
// elixir/lib/stelgano/daily_metrics.ex.
//
// Per-day global counters: free_new, paid_new, free_expired, paid_expired.
// No country dimension, no per-room linkage. See the migration header
// for the privacy rationale.

type DailyColumn = "free_new" | "paid_new" | "free_expired" | "paid_expired" | "messages_sent";

export type DailyRow = {
  day: string;
  free_new: number;
  paid_new: number;
  free_expired: number;
  paid_expired: number;
  messages_sent: number;
};

export const incrementFreeNew = (db: D1Database) => bump(db, "free_new", 1);
export const incrementPaidNew = (db: D1Database) => bump(db, "paid_new", 1);
export const incrementFreeExpired = (db: D1Database, count = 1) => bump(db, "free_expired", count);
export const incrementPaidExpired = (db: D1Database, count = 1) => bump(db, "paid_expired", count);
export const incrementMessagesSent = (db: D1Database) => bump(db, "messages_sent", 1);

/** Returns the most recent `days` rows (sorted newest first). Missing
 *  days are NOT zero-padded — the admin UI fills gaps if it wants a
 *  contiguous trend. */
export async function listRecent(db: D1Database, days = 30): Promise<DailyRow[]> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("days must be a positive integer");
  }

  const cutoffMs = Date.now() - (days - 1) * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);

  const result = await db
    .prepare(
      "SELECT day, free_new, paid_new, free_expired, paid_expired, messages_sent " +
        "FROM daily_metrics WHERE day >= ? ORDER BY day DESC",
    )
    .bind(cutoff)
    .all<DailyRow>();

  return result.results;
}

async function bump(db: D1Database, column: DailyColumn, count: number): Promise<void> {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("count must be a non-negative integer");
  }
  if (count === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // UPSERT: same single-statement-no-race pattern as country_metrics.
  // The targeted column initialises to `count` on INSERT and adds
  // `count` on UPDATE.
  const cols: DailyColumn[] = [
    "free_new",
    "paid_new",
    "free_expired",
    "paid_expired",
    "messages_sent",
  ];
  const values = cols.map((c) => (c === column ? count : 0));

  const sql = `
    INSERT INTO daily_metrics (day, free_new, paid_new, free_expired, paid_expired, messages_sent, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      ${column} = ${column} + ?,
      updated_at = excluded.updated_at
  `;

  await db
    .prepare(sql)
    .bind(today, ...values, now, count)
    .run();
}
