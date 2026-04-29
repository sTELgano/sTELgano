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
// One data point per event covers both per-country and per-day aggregates —
// they are computed at query time with no row locking and no contention.
//
// All custom AE datasets are queried via the generic field
// "workersAnalyticsEngineAdaptiveGroups" with a dataset filter.
// Production uses "stelgano_events"; staging uses "stelgano_events_staging"
// (set via CF_AE_DATASET in wrangler.toml) to keep their data separate.
//
// PRIVACY: no room_hash, no access_hash, no phone digits ever appear in
// any data point. blob2 and blob3 each carry a 2-char ISO code — neither
// is stored alongside any individual room or access record.

const AE_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
// All custom AE datasets are queried through this single generic field,
// filtered by dataset name — individual <dataset>AdaptiveGroups fields
// do not exist in the CF GraphQL schema.
const AE_FIELD = "workersAnalyticsEngineAdaptiveGroups";
export const DEFAULT_DATASET = "stelgano_events";

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
// GraphQL read helpers — used by the admin dashboard.
// Return empty arrays when credentials are missing or the query fails.
// ---------------------------------------------------------------------------

type AeGroup = {
  count: number;
  dimensions: { blob1?: string; blob2?: string; blob3?: string; date?: string };
};

type AeResponse = {
  data?: {
    viewer?: {
      accounts?: Array<Record<string, AeGroup[] | undefined>>;
    };
  };
  errors?: unknown[];
};

function extractGroups(body: AeResponse): AeGroup[] {
  try {
    return (body.data?.viewer?.accounts?.[0]?.[AE_FIELD] as AeGroup[]) ?? [];
  } catch {
    return [];
  }
}

async function graphqlQuery(
  _accountId: string,
  apiToken: string,
  query: string,
): Promise<AeResponse> {
  const resp = await fetch(AE_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) return {};
  return (await resp.json()) as AeResponse;
}

/** Sanitises a string for safe embedding inside a GraphQL string literal. */
function escQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** All-time free/paid room creation counts grouped by country, sorted by
 *  total descending. */
export async function queryCountryMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<CountryRow[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${escQ(accountId)}" }) {
        ${AE_FIELD}(
          filter: { dataset: "${escQ(dataset)}", blob1_in: ["room_free", "room_paid"] }
          limit: 10000
          orderBy: [count_DESC]
        ) {
          count
          dimensions { blob1 blob2 }
        }
      }
    }
  }`;

  const body = await graphqlQuery(accountId, apiToken, query).catch((): AeResponse => ({}));
  const groups = extractGroups(body);

  const map = new Map<string, { free: number; paid: number }>();
  for (const g of groups) {
    const iso = g.dimensions.blob2;
    if (!iso) continue;
    const r = map.get(iso) ?? { free: 0, paid: 0 };
    if (g.dimensions.blob1 === "room_free") r.free += g.count;
    else if (g.dimensions.blob1 === "room_paid") r.paid += g.count;
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

/** All-time free/paid room creation counts grouped by CF-IPCountry, sorted
 *  by total descending. Complements queryCountryMetrics (steg-number country)
 *  — the two datasets differ for diaspora users, travellers, and VPN users. */
export async function queryCFCountryMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<CFCountryRow[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${escQ(accountId)}" }) {
        ${AE_FIELD}(
          filter: { dataset: "${escQ(dataset)}", blob1_in: ["room_free", "room_paid"] }
          limit: 10000
          orderBy: [count_DESC]
        ) {
          count
          dimensions { blob1 blob3 }
        }
      }
    }
  }`;

  const body = await graphqlQuery(accountId, apiToken, query).catch((): AeResponse => ({}));
  const groups = extractGroups(body);

  const map = new Map<string, { free: number; paid: number }>();
  for (const g of groups) {
    const iso = g.dimensions.blob3;
    if (!iso) continue;
    const r = map.get(iso) ?? { free: 0, paid: 0 };
    if (g.dimensions.blob1 === "room_free") r.free += g.count;
    else if (g.dimensions.blob1 === "room_paid") r.paid += g.count;
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

/** Cross-dimension query: (steg-number country, CF-IPCountry) pairs for
 *  room_free and room_paid events, sorted by total descending.
 *  Rows where steg_country !== cf_country are diaspora signals — users
 *  whose phone number originates in a different country than their
 *  current connection location. */
export async function queryDiasporaMetrics(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<DiasporaRow[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${escQ(accountId)}" }) {
        ${AE_FIELD}(
          filter: { dataset: "${escQ(dataset)}", blob1_in: ["room_free", "room_paid"] }
          limit: 10000
          orderBy: [count_DESC]
        ) {
          count
          dimensions { blob1 blob2 blob3 }
        }
      }
    }
  }`;

  const body = await graphqlQuery(accountId, apiToken, query).catch((): AeResponse => ({}));
  const groups = extractGroups(body);

  const map = new Map<string, { free: number; paid: number }>();
  for (const g of groups) {
    const steg = g.dimensions.blob2 ?? "";
    const cf = g.dimensions.blob3 ?? "";
    if (!steg || !cf) continue;
    const key = `${steg}:${cf}`;
    const r = map.get(key) ?? { free: 0, paid: 0 };
    if (g.dimensions.blob1 === "room_free") r.free += g.count;
    else if (g.dimensions.blob1 === "room_paid") r.paid += g.count;
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

/** Validates AE access by running a minimal 1-row query.
 *  Returns the first GraphQL error message, or null on success. */
export async function checkAeAccess(
  accountId: string,
  apiToken: string,
  dataset: string,
): Promise<string | null> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${escQ(accountId)}" }) {
        ${AE_FIELD}(limit: 1 filter: { dataset: "${escQ(dataset)}" }) { count }
      }
    }
  }`;
  let body: AeResponse;
  try {
    const resp = await fetch(AE_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return `AE HTTP ${resp.status}`;
    body = (await resp.json()) as AeResponse;
  } catch {
    return "AE endpoint unreachable";
  }
  if (body.errors?.length) {
    const first = (body.errors[0] as { message?: string })?.message;
    return first ?? "AE returned errors";
  }
  return null;
}

/** Per-day event counts over the last `days` days, sorted newest first. */
export async function queryDailyMetrics(
  accountId: string,
  apiToken: string,
  days: number,
  dataset: string,
): Promise<DailyRow[]> {
  const sinceMs = Date.now() - (days - 1) * 86_400_000;
  const since = new Date(sinceMs).toISOString().slice(0, 10);

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${escQ(accountId)}" }) {
        ${AE_FIELD}(
          filter: { dataset: "${escQ(dataset)}", datetime_geq: "${since}T00:00:00Z" }
          limit: 10000
          orderBy: [date_DESC]
        ) {
          count
          dimensions { blob1 date }
        }
      }
    }
  }`;

  const body = await graphqlQuery(accountId, apiToken, query).catch((): AeResponse => ({}));
  const groups = extractGroups(body);

  const map = new Map<string, DailyRow>();
  for (const g of groups) {
    const day = g.dimensions.date;
    if (!day) continue;
    const r = map.get(day) ?? {
      day,
      free_new: 0,
      paid_new: 0,
      free_expired: 0,
      paid_expired: 0,
      messages_sent: 0,
    };
    switch (g.dimensions.blob1) {
      case "room_free":
        r.free_new += g.count;
        break;
      case "room_paid":
        r.paid_new += g.count;
        break;
      case "room_expired_free":
        r.free_expired += g.count;
        break;
      case "room_expired_paid":
        r.paid_expired += g.count;
        break;
      case "message_sent":
        r.messages_sent += g.count;
        break;
    }
    map.set(day, r);
  }

  return [...map.values()].sort((a, b) => b.day.localeCompare(a.day));
}
