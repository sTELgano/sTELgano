// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for country_metrics. Ports
// elixir/lib/stelgano/country_metrics.ex.
//
// PRIVACY MODEL: aggregate-counters-only. Reads/writes never touch a
// per-room identifier. Callers may safely log "country X bumped" without
// leaking which room caused the bump.

const ISO_RE = /^[A-Z]{2}$/;

export type CountryRow = {
  country_code: string;
  free_rooms: number;
  paid_rooms: number;
};

/** Increments the `free_rooms` counter for the given ISO-3166 alpha-2
 *  country code. No-op on invalid input (matches v1: caller has already
 *  validated more sensitive fields; failing loudly here only produces
 *  noisy telemetry for malformed client requests). */
export async function incrementFree(db: D1Database, countryCode: unknown): Promise<void> {
  await increment(db, "free_rooms", countryCode);
}

/** Increments the `paid_rooms` counter for the given ISO-3166 alpha-2
 *  country code. No-op on invalid input. */
export async function incrementPaid(db: D1Database, countryCode: unknown): Promise<void> {
  await increment(db, "paid_rooms", countryCode);
}

/** Returns all rows sorted by total (free + paid) descending. Used by
 *  the admin dashboard. */
export async function list(db: D1Database): Promise<CountryRow[]> {
  const result = await db
    .prepare(
      "SELECT country_code, free_rooms, paid_rooms FROM country_metrics " +
        "ORDER BY (free_rooms + paid_rooms) DESC",
    )
    .all<CountryRow>();
  return result.results;
}

async function increment(
  db: D1Database,
  column: "free_rooms" | "paid_rooms",
  raw: unknown,
): Promise<void> {
  const code = normalise(raw);
  if (code === null) return;

  const now = new Date().toISOString();

  // UPSERT: insert with the bump if the row is new, otherwise add 1 to
  // the targeted column. Single-statement so no read-modify-write race.
  // The other column defaults to 0 on INSERT and is left alone on UPDATE.
  const sql =
    column === "free_rooms"
      ? `INSERT INTO country_metrics (country_code, free_rooms, paid_rooms, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(country_code) DO UPDATE SET
           free_rooms = free_rooms + 1,
           updated_at = excluded.updated_at`
      : `INSERT INTO country_metrics (country_code, free_rooms, paid_rooms, updated_at)
         VALUES (?, 0, 1, ?)
         ON CONFLICT(country_code) DO UPDATE SET
           paid_rooms = paid_rooms + 1,
           updated_at = excluded.updated_at`;

  await db.prepare(sql).bind(code, now).run();
}

function normalise(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase();
  return ISO_RE.test(upper) ? upper : null;
}
