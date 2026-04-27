// SPDX-License-Identifier: AGPL-3.0-only
//
// FX rate cache — Workers replacement for the v1 FxRate GenServer.
//
// v1 (Elixir): a long-lived GenServer holds the cached rate in memory,
// refreshes it every 24h via Process.send_after, and answers queries
// from any process without a storage round-trip.
//
// v2 (Workers): no persistent in-memory process exists. The rate is
// stored in KV (RATE_CACHE) with a 25h TTL. A daily Cron Trigger
// (0 6 * * * in wrangler.toml) calls refreshRate() to keep the value
// fresh before the TTL expires. getRate() reads from KV, falling back
// to PAYMENT_FX_FALLBACK_RATE if the key is absent or the binding is
// unavailable.
//
// Source: Fawazahmed0 currency-api — keyless, CDN-served JSON, updated
// daily. Same source as v1's FxRate GenServer.
// URL: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{base}.json
// Response: { "date": "2025-01-01", "{base}": { "{quote}": 0.00076, ... } }

const CURRENCY_API =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies";

function kvKey(base: string, quote: string): string {
  return `fx:${base.toLowerCase()}:${quote.toLowerCase()}`;
}

/** Read the cached exchange rate (base → quote) from KV.
 *  Falls back to the fallback string (e.g. PAYMENT_FX_FALLBACK_RATE env var)
 *  if the KV key is absent or the binding is unavailable.
 *  Returns null when neither source yields a positive finite number. */
export async function getRate(
  kv: KVNamespace | undefined,
  base: string,
  quote: string,
  fallback?: string,
): Promise<number | null> {
  if (kv) {
    const cached = await kv.get(kvKey(base, quote)).catch(() => null);
    if (cached !== null) {
      const n = parseFloat(cached);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (fallback) {
    const n = parseFloat(fallback);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Fetch the live exchange rate (base → quote) from the Fawazahmed0
 *  currency API, write it to KV with a 25h TTL, and return the rate.
 *  Returns null on any network, HTTP, or parse failure so the caller
 *  can fall back gracefully rather than crashing the cron run. */
export async function refreshRate(
  kv: KVNamespace,
  base: string,
  quote: string,
): Promise<number | null> {
  const url = `${CURRENCY_API}/${base.toLowerCase()}.json`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  type ApiResponse = Record<string, unknown>;
  let data: ApiResponse;
  try {
    data = (await resp.json()) as ApiResponse;
  } catch {
    return null;
  }

  const rates = data[base.toLowerCase()] as Record<string, unknown> | undefined;
  const rate = rates?.[quote.toLowerCase()];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;

  // 25h TTL — slightly longer than the 24h cron interval so the cache
  // never goes empty between runs (the old value stays valid until the
  // new cron fires even if the previous run was a few minutes late).
  await kv.put(kvKey(base, quote), String(rate), { expirationTtl: 25 * 3600 });
  return rate;
}
