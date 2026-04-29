// SPDX-License-Identifier: AGPL-3.0-only
//
// Analytics Engine — write and read helpers for sTELgano metrics.
//
// Write schema per data point:
//   blob1 = EventType  (e.g. "room_free", "room_rejoin", "message_sent")
//   blob2 = steg-number ISO-3166 alpha-2 (client-derived via libphonenumber-js), or ""
//   blob3 = CF-IPCountry alpha-2 (server-side IP geolocation), or "" when unavailable
//   doubles[0] = 1
//
// Two country dimensions per event:
//   blob2 answers "which country's phone format was this steg number from?"
//   blob3 answers "where is this user physically connecting from?"
// They differ for diaspora users, travellers, and VPN users.
// queryDiasporaMetrics() groups by both simultaneously to surface those differences.
//
// Reads use the CF Analytics Engine SQL API
// (POST /client/v4/accounts/{id}/analytics_engine/sql) rather than GraphQL —
// the GraphQL generic field workersAnalyticsEngineAdaptiveGroups does not expose
// blob1/blob2/blob3 as dimension fields; the SQL API supports them directly.
//
// Production dataset: "stelgano_events"
// Staging dataset:    "stelgano_events_staging"
// (set per-env via CF_AE_DATASET in wrangler.toml)
//
// PRIVACY: no room_hash, no access_hash, no phone digits ever appear in
// any data point. blob2 and blob3 each carry a 2-char ISO code — neither
// is stored alongside any individual room or access record.

const AE_SQL_BASE = "https://api.cloudflare.com/client/v4/accounts";

export type EventType =
  | "room_free"
  | "room_paid"
  | "room_rejoin"
  | "room_expired_free"
  | "room_expired_paid"
  | "message_sent";

export type CountryRow = {
  country_code: string;
  free_rooms: number;
  paid_rooms: number;
};

export type CFCountryRow = {
  country_code: string;
  free_rooms: number;
  paid_rooms: number;
};

export type DiasporaRow = {
  steg_country: string;
  cf_country: string;
  free_rooms: number;
  paid_rooms: number;
};

export type DailyRow = {
  day: string;
  free_new: number;
  paid_new: number;
  free_expired: number;
  paid_expired: number;
  messages_sent: number;
};

/** Fire-and-forget: write one Analytics Engine data point.
 *  blob1 = event type, blob2 = steg-number country (or ""),
 *  blob3 = CF-IPCountry (or "").
 *  No-op when analytics is undefined (tests run without this binding). */
export function writeEvent(
  analytics: AnalyticsEngineDataset | undefined,
  type: EventType,
  countryIso = "",
  cfCountry = "",
): void {
  analytics?.writeDataPoint({ blobs: [type, countryIso, cfCountry], doubles: [1] });
}

// ---------------------------------------------------------------------------
// SQL API read helpers — used by the admin dashboard.
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;
type SqlResult = { data: SqlRow[]; error?: string };

async function sqlQuery(accountId: string, apiToken: string, sql: string): Promise<SqlResult> {
  let resp: Response;
  try {
    resp = await fetch(`${AE_SQL_BASE}/${accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${apiToken}` },
      body: sql,
    });
  } catch {
    return { data: [], error: "AE endpoint unreachable" };
  }
  if (!resp.ok) return { data: [], error: `AE HTTP ${resp.status}` };
  const json = (await resp.json()) as { data?: SqlRow[] };
  return { data: json.data ?? [] };
}

/** ISO date string 30 days ago, formatted for toDateTime(). */
function since30(): string {
  return `${new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)} 00:00:00`;
}

/** Free/paid room creation counts grouped by steg-number country over the
 *  last 30 days, sorted by total descending. */
export async function queryCountryMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<CountryRow[]> {
  const { data } = await sqlQuery(
    accountId,
    apiToken,
    `SELECT blob1, blob2, count() AS cnt
     FROM ${dataset}
     WHERE timestamp >= toDateTime('${since30()}')
       AND blob1 IN ('room_free', 'room_paid')
     GROUP BY blob1, blob2
     ORDER BY cnt DESC
     LIMIT 10000`,
  ).catch((): SqlResult => ({ data: [] }));

  const map = new Map<string, { free: number; paid: number }>();
  for (const row of data) {
    const iso = row.blob2 as string;
    if (!iso) continue;
    const cnt = Number(row.cnt ?? 0);
    const r = map.get(iso) ?? { free: 0, paid: 0 };
    if (row.blob1 === "room_free") r.free += cnt;
    else if (row.blob1 === "room_paid") r.paid += cnt;
    map.set(iso, r);
  }

  return [...map.entries()]
    .map(([country_code, { free, paid }]) => ({
      country_code,
      free_rooms: free,
      paid_rooms: paid,
    }))
    .sort((a, b) => b.free_rooms + b.paid_rooms - (a.free_rooms + a.paid_rooms));
}

/** Free/paid room creation counts grouped by CF-IPCountry over the last
 *  30 days, sorted by total descending. */
export async function queryCFCountryMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<CFCountryRow[]> {
  const { data } = await sqlQuery(
    accountId,
    apiToken,
    `SELECT blob1, blob3, count() AS cnt
     FROM ${dataset}
     WHERE timestamp >= toDateTime('${since30()}')
       AND blob1 IN ('room_free', 'room_paid')
     GROUP BY blob1, blob3
     ORDER BY cnt DESC
     LIMIT 10000`,
  ).catch((): SqlResult => ({ data: [] }));

  const map = new Map<string, { free: number; paid: number }>();
  for (const row of data) {
    const iso = row.blob3 as string;
    if (!iso) continue;
    const cnt = Number(row.cnt ?? 0);
    const r = map.get(iso) ?? { free: 0, paid: 0 };
    if (row.blob1 === "room_free") r.free += cnt;
    else if (row.blob1 === "room_paid") r.paid += cnt;
    map.set(iso, r);
  }

  return [...map.entries()]
    .map(([country_code, { free, paid }]) => ({
      country_code,
      free_rooms: free,
      paid_rooms: paid,
    }))
    .sort((a, b) => b.free_rooms + b.paid_rooms - (a.free_rooms + a.paid_rooms));
}

/** (steg-number country, CF-IPCountry) pairs for room_free and room_paid
 *  events over the last 30 days, sorted by total descending.
 *  Rows where steg_country !== cf_country are diaspora signals. */
export async function queryDiasporaMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<DiasporaRow[]> {
  const { data } = await sqlQuery(
    accountId,
    apiToken,
    `SELECT blob1, blob2, blob3, count() AS cnt
     FROM ${dataset}
     WHERE timestamp >= toDateTime('${since30()}')
       AND blob1 IN ('room_free', 'room_paid')
     GROUP BY blob1, blob2, blob3
     ORDER BY cnt DESC
     LIMIT 10000`,
  ).catch((): SqlResult => ({ data: [] }));

  const map = new Map<string, { free: number; paid: number }>();
  for (const row of data) {
    const steg = (row.blob2 as string) ?? "";
    const cf = (row.blob3 as string) ?? "";
    if (!steg || !cf) continue;
    const key = `${steg}:${cf}`;
    const cnt = Number(row.cnt ?? 0);
    const r = map.get(key) ?? { free: 0, paid: 0 };
    if (row.blob1 === "room_free") r.free += cnt;
    else if (row.blob1 === "room_paid") r.paid += cnt;
    map.set(key, r);
  }

  return [...map.entries()]
    .map(([key, { free, paid }]) => {
      const [steg_country, cf_country] = key.split(":");
      return {
        steg_country: steg_country ?? "",
        cf_country: cf_country ?? "",
        free_rooms: free,
        paid_rooms: paid,
      };
    })
    .sort((a, b) => b.free_rooms + b.paid_rooms - (a.free_rooms + a.paid_rooms));
}

/** Validates AE access with a minimal query.
 *  Returns an error string on failure, or null on success. */
export async function checkAeAccess(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<string | null> {
  const { error } = await sqlQuery(
    accountId,
    apiToken,
    `SELECT 1 FROM ${dataset} WHERE timestamp >= toDateTime('${since30()}') LIMIT 1`,
  );
  return error ?? null;
}

/** Per-day event counts over the last `days` days, sorted newest first. */
export async function queryDailyMetrics(
  accountId: string,
  apiToken: string,
  days: number,
  dataset: string,
): Promise<DailyRow[]> {
  const since = `${new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)} 00:00:00`;

  const { data } = await sqlQuery(
    accountId,
    apiToken,
    `SELECT blob1, toDate(timestamp) AS day, count() AS cnt
     FROM ${dataset}
     WHERE timestamp >= toDateTime('${since}')
     GROUP BY blob1, day
     ORDER BY day DESC
     LIMIT 10000`,
  ).catch((): SqlResult => ({ data: [] }));

  const map = new Map<string, DailyRow>();
  for (const row of data) {
    const day = row.day as string;
    if (!day) continue;
    const cnt = Number(row.cnt ?? 0);
    const r = map.get(day) ?? {
      day,
      free_new: 0,
      paid_new: 0,
      free_expired: 0,
      paid_expired: 0,
      messages_sent: 0,
    };
    switch (row.blob1) {
      case "room_free":
        r.free_new += cnt;
        break;
      case "room_paid":
        r.paid_new += cnt;
        break;
      case "room_expired_free":
        r.free_expired += cnt;
        break;
      case "room_expired_paid":
        r.paid_expired += cnt;
        break;
      case "message_sent":
        r.messages_sent += cnt;
        break;
    }
    map.set(day, r);
  }

  return [...map.values()].sort((a, b) => b.day.localeCompare(a.day));
}
