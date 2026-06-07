// SPDX-License-Identifier: AGPL-3.0-only
//
// daily_metrics — the single analytics store. Replaces Analytics Engine.
//
// Write path (optimized for D1):
//   hot path → enqueueMetric()/enqueueMetrics()  ──▶  METRICS_QUEUE
//                                                        │ batch (≤100 / ≤30s)
//                                                        ▼
//                                              queue() consumer in _worker.ts
//                                                        │ coalesce() in memory
//                                                        │ one reused prepared UPSERT
//                                                        ▼
//                                              db.batch([...])  ──▶  daily_metrics
//
// The chat hot path never touches D1 — it only enqueues (fire-and-forget,
// fail-open). The consumer coalesces a whole batch by composite key and
// writes it in a single transactional db.batch(), so D1 write rate is
// batches/sec, not events/sec. Result is exact (no AE sampling) and
// permanent (no 90-day retention cap).
//
// PRIVACY: a metric message and a daily_metrics row carry only a metric
// key, two 2-char country codes, an operator dim (campaign slug or
// distribution bucket), a numeric value, and an emit timestamp used ONLY
// to pick the UTC day bucket (then discarded). No room_hash, access_hash,
// phone, IP, sender_hash, or payment reference ever appears.

// ---------------------------------------------------------------------------
// Conversion-funnel steps (moved here from the removed analytics.ts).
// ---------------------------------------------------------------------------

/** Ordered conversion-funnel stages, top to bottom. The order is the
 *  funnel order — the admin dashboard renders drop-off between
 *  consecutive entries. */
export const FUNNEL_STEPS = [
  "landing",
  "chat_view",
  "steg_generated",
  "channel_opened",
  "extend_started",
  "extend_completed",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export function isFunnelStep(v: unknown): v is FunnelStep {
  return typeof v === "string" && (FUNNEL_STEPS as readonly string[]).includes(v);
}

/** Per-campaign funnel counts, one entry per `campaign` slug (plus
 *  "direct"). `steps` holds the count reaching each FunnelStep. */
export type CampaignFunnel = {
  campaign: string;
  steps: Record<FunnelStep, number>;
};

/** Collapses per-campaign funnels into one platform-wide funnel by summing
 *  each step across every campaign (including "direct"). */
export function sumFunnels(funnels: CampaignFunnel[]): Record<FunnelStep, number> {
  const total = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>;
  for (const f of funnels) {
    for (const s of FUNNEL_STEPS) total[s] += f.steps[s] ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Metric keys & queue message shape.
// ---------------------------------------------------------------------------

/** Room/message/monetization/security metric keys. */
export type CoreMetric =
  // Channel lifecycle (a number starts free = weekly TTL; paying extends it
  // to paid = yearly TTL).
  | "room_free"
  | "room_paid"
  | "room_extended"
  | "room_rejoin"
  | "room_expired_free"
  | "room_expired_paid"
  | "room_expired_empty" // expired having never carried a message
  | "room_expired_solo" // expired having never gained a second party
  | "room_lifespan" // sum_value = hours; dim = lifespan bucket
  // Engagement.
  | "message_sent"
  | "message_edited"
  | "message_deleted"
  | "message_read"
  | "second_party_joined"
  | "time_to_first_message" // sum_value = seconds; dim = ttfm bucket
  | "activity_hour" // dim = UTC hour "00".."23" (global): intra-day activity
  // Monetization.
  | "extension" // dim = ordinal bucket (x1, x2, …): the Nth paid extension
  | "paid_sale" // dim = price label; sum_value = amount in minor units (revenue)
  | "time_to_paid" // sum_value = hours; dim = conversion bucket: free→paid latency
  | "payment_initiated" // dim = price label (server-side payment funnel: top)
  | "payment_paid" // dim = price label (webhook confirmed: mid)
  | "redeem_failed" // dim = reason
  // Acquisition.
  | "page_view" // dim = normalized route
  | "referrer" // dim = source category (search | social | other | direct)
  // Security / abuse / reliability.
  | "access_failed"
  | "access_lockout"
  | "join_rate_limited" // dim = "create" | "slot"
  | "ws_rate_limited" // WebSocket-upgrade rate-limit rejection (edge)
  | "admin_rate_limited" // /admin rate-limit rejection
  | "cron_sweep"; // count = cron runs; sum_value = expired tokens deleted

/** All metric keys, including one per funnel step (dim = campaign slug). */
export type MetricKey = CoreMetric | `funnel_${FunnelStep}`;

/** A single queued metric event. `ts` (emit Date.now()) is used only to
 *  bucket into the correct UTC day, then discarded. */
export type MetricMessage = {
  metric: MetricKey;
  stegCountry?: string;
  cfCountry?: string;
  dim?: string;
  value?: number;
  ts: number;
};

export type EnqueueOpts = {
  stegCountry?: string;
  cfCountry?: string;
  dim?: string;
  value?: number;
  /** Injectable clock for tests; defaults to Date.now(). */
  nowMs?: number;
};

function toMessage(metric: MetricKey, opts: EnqueueOpts = {}): MetricMessage {
  return {
    metric,
    stegCountry: opts.stegCountry || "",
    cfCountry: opts.cfCountry || "",
    dim: opts.dim || "",
    value: opts.value ?? 0,
    ts: opts.nowMs ?? Date.now(),
  };
}

/** Minimal slice of ExecutionContext — just what we need to keep a
 *  fire-and-forget send alive past a request handler's response. */
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** Fire-and-forget enqueue of one metric event. No-op when the queue
 *  binding is absent (tests). Fail-open: a send rejection is swallowed so
 *  a queue outage never blocks or errors a chat event. Pass `ctx` from a
 *  request/cron handler so the send is registered with waitUntil and isn't
 *  dropped when the response returns (the DO keeps its own context alive,
 *  so it omits ctx). */
export function enqueueMetric(
  queue: Queue<MetricMessage> | undefined,
  metric: MetricKey,
  opts: EnqueueOpts = {},
  ctx?: WaitUntil,
): void {
  if (!queue) return;
  const p = queue.send(toMessage(metric, opts)).catch(() => {});
  ctx?.waitUntil(p);
}

/** Fire-and-forget enqueue of several metric events in one sendBatch —
 *  used by handlers that emit multiple metrics at once (e.g. expiry). */
export function enqueueMetrics(
  queue: Queue<MetricMessage> | undefined,
  items: Array<{ metric: MetricKey } & Omit<EnqueueOpts, "nowMs">>,
  nowMs?: number,
  ctx?: WaitUntil,
): void {
  if (!queue || items.length === 0) return;
  const batch = items.map((it) => ({ body: toMessage(it.metric, { ...it, nowMs }) }));
  const p = queue.sendBatch(batch).catch(() => {});
  ctx?.waitUntil(p);
}

// ---------------------------------------------------------------------------
// Day bucketing & distribution buckets (pure).
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' in UTC for an epoch-ms timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const LIFESPAN_BUCKETS = ["<1h", "1-24h", "1-7d", "7-30d", "30-90d", "90d+"] as const;
export const TTFM_BUCKETS = ["<1m", "1-10m", "10-60m", "1-24h", "1d+"] as const;

/** Coarse bucket label for a channel lifespan in hours. */
export function lifespanBucket(hours: number): (typeof LIFESPAN_BUCKETS)[number] {
  if (hours < 1) return "<1h";
  if (hours < 24) return "1-24h";
  if (hours < 24 * 7) return "1-7d";
  if (hours < 24 * 30) return "7-30d";
  if (hours < 24 * 90) return "30-90d";
  return "90d+";
}

/** Coarse bucket label for a time-to-first-message in seconds. */
export function ttfmBucket(seconds: number): (typeof TTFM_BUCKETS)[number] {
  if (seconds < 60) return "<1m";
  if (seconds < 600) return "1-10m";
  if (seconds < 3600) return "10-60m";
  if (seconds < 86_400) return "1-24h";
  return "1d+";
}

export const EXTENSION_BUCKETS = [
  "x1",
  "x2",
  "x3",
  "x4",
  "x5",
  "x6",
  "x7",
  "x8",
  "x9",
  "x10+",
] as const;

/** Ordinal bucket for the Nth paid extension of a single number (1-based),
 *  capped at x10+. The DO tracks its own extension count in room state (never
 *  by hash), so this is a population distribution, not a per-number trail. */
export function extensionBucket(n: number): (typeof EXTENSION_BUCKETS)[number] {
  if (n <= 1) return "x1";
  if (n >= 10) return "x10+";
  return `x${n}` as (typeof EXTENSION_BUCKETS)[number];
}

/** Stable price-point label for the `dim` of monetization metrics, e.g.
 *  "USD_200". Currency is uppercased; cents kept as an integer string. */
export function priceLabel(currency: string, amountCents: number): string {
  return `${(currency || "USD").toUpperCase()}_${Math.max(0, Math.round(amountCents))}`;
}

export const CONVERSION_BUCKETS = ["<1h", "1-24h", "1-3d", "3-7d", "7d+"] as const;

/** Coarse bucket for free→paid conversion latency, in hours. */
export function conversionBucket(hours: number): (typeof CONVERSION_BUCKETS)[number] {
  if (hours < 1) return "<1h";
  if (hours < 24) return "1-24h";
  if (hours < 24 * 3) return "1-3d";
  if (hours < 24 * 7) return "3-7d";
  return "7d+";
}

/** UTC hour-of-day as a zero-padded "00".."23" label, for activity_hour. */
export function utcHour(ms: number): string {
  return String(new Date(ms).getUTCHours()).padStart(2, "0");
}

/** Ordered "00".."23" labels for rendering the hour-of-day histogram. */
export const HOURS_OF_DAY = Array.from({ length: 24 }, (_, h) =>
  String(h).padStart(2, "0"),
) as readonly string[];

// ---------------------------------------------------------------------------
// Acquisition classifiers (pure) — normalize a request into a coarse route
// and referrer-source category. No full URL, query string, or host is ever
// stored: page_view keeps only a fixed route label, referrer only a category.
// ---------------------------------------------------------------------------

const PAGE_ROUTES = new Set([
  "/",
  "/blog",
  "/spec",
  "/security",
  "/privacy",
  "/terms",
  "/about",
  "/pricing",
  "/chat",
]);

/** Normalizes a pathname to a stable content-page route label, or null for
 *  anything that isn't an operator-facing content page (assets, API, admin,
 *  room WS, payment, campaign links, etc. are skipped). */
export function pageRoute(pathname: string): string | null {
  if (PAGE_ROUTES.has(pathname)) return pathname;
  if (/^\/blog\/[^/]+$/.test(pathname)) return "/blog/:slug";
  return null;
}

const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "baidu.", "yandex."];
const SOCIAL_HOSTS = [
  "t.co",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "linkedin.com",
  "lnkd.in",
  "youtube.com",
  "tiktok.com",
  "t.me",
];

/** Buckets a Referer header into a coarse source category. Same-host
 *  (internal) navigation returns "internal" — callers skip emitting those,
 *  so only external/direct acquisition is counted. */
export function referrerCategory(referer: string | null, selfHost: string): string {
  if (!referer) return "direct";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (
    selfHost &&
    (host === selfHost.toLowerCase() || host.endsWith(`.${selfHost.toLowerCase()}`))
  ) {
    return "internal";
  }
  if (SEARCH_HOSTS.some((h) => host.includes(h))) return "search";
  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "social";
  return "other";
}

// ---------------------------------------------------------------------------
// Consumer side — coalesce + batched UPSERT.
// ---------------------------------------------------------------------------

export type AggRow = {
  day: string;
  metric: string;
  stegCountry: string;
  cfCountry: string;
  dim: string;
  count: number;
  sumValue: number;
};

/** Group a batch of messages by composite key, summing count and value.
 *  Pure — drives both flushMetricBatch and the unit tests. */
export function coalesce(msgs: MetricMessage[]): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const m of msgs) {
    const day = utcDay(m.ts);
    const steg = m.stegCountry ?? "";
    const cf = m.cfCountry ?? "";
    const dim = m.dim ?? "";
    // \x1f (unit separator) cannot appear in a metric/country/dim, so the
    // composite key is unambiguous.
    const key = `${day}\x1f${m.metric}\x1f${steg}\x1f${cf}\x1f${dim}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.sumValue += m.value ?? 0;
    } else {
      map.set(key, {
        day,
        metric: m.metric,
        stegCountry: steg,
        cfCountry: cf,
        dim,
        count: 1,
        sumValue: m.value ?? 0,
      });
    }
  }
  return [...map.values()];
}

const UPSERT_SQL = `INSERT INTO daily_metrics (day, metric, steg_country, cf_country, dim, count, sum_value)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, metric, steg_country, cf_country, dim)
DO UPDATE SET count = count + excluded.count, sum_value = sum_value + excluded.sum_value`;

/** Coalesce a batch and apply it in a single transactional db.batch() using
 *  one reused prepared statement. Throwing here lets the queue consumer
 *  fail the batch so the runtime retries it (then routes to the DLQ). */
export async function flushMetricBatch(db: D1Database, msgs: MetricMessage[]): Promise<void> {
  const rows = coalesce(msgs);
  if (rows.length === 0) return;
  const stmt = db.prepare(UPSERT_SQL);
  const batch = rows.map((r) =>
    stmt.bind(r.day, r.metric, r.stegCountry, r.cfCountry, r.dim, r.count, r.sumValue),
  );
  await db.batch(batch);
}

// ---------------------------------------------------------------------------
// Date-range parsing (dashboard input safety) — pure.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 366;

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
function addDays(day: string, n: number): string {
  return utcDay(dayToMs(day) + n * 86_400_000);
}
function dayDiff(from: string, to: string): number {
  return Math.round((dayToMs(to) - dayToMs(from)) / 86_400_000);
}

export type DateRange = { from: string; to: string; days: number; label: string };

/** Parse ?from=&to= or ?days=N from the admin URL. Validates format, swaps
 *  reversed ranges, clamps the span to <=366 days, and falls back to the
 *  last 30 days on anything invalid. Never throws. All days are UTC. */
export function parseDateRange(params: URLSearchParams, todayMs: number): DateRange {
  const today = utcDay(todayMs);
  const fromRaw = params.get("from");
  const toRaw = params.get("to");

  if (fromRaw && toRaw && DATE_RE.test(fromRaw) && DATE_RE.test(toRaw)) {
    let from = fromRaw;
    let to = toRaw;
    if (from > to) [from, to] = [to, from];
    if (dayDiff(from, to) > MAX_SPAN_DAYS - 1) from = addDays(to, -(MAX_SPAN_DAYS - 1));
    return { from, to, days: dayDiff(from, to) + 1, label: `${from} → ${to} (UTC)` };
  }

  let days = 30;
  const daysRaw = params.get("days");
  if (daysRaw) {
    const n = Number.parseInt(daysRaw, 10);
    if (Number.isFinite(n)) days = Math.min(MAX_SPAN_DAYS, Math.max(1, n));
  }
  return { from: addDays(today, -(days - 1)), to: today, days, label: `last ${days} days (UTC)` };
}

// ---------------------------------------------------------------------------
// Read helpers — all parameterized with .bind() (never string-interpolated).
//
// Reads could be wrapped in db.withSession() once D1 read replication is
// enabled on the instance; left on the primary by default for simplicity.
// ---------------------------------------------------------------------------

export type MetricTotal = { metric: string; count: number; sumValue: number };
export type DailyTrendRow = { day: string; metric: string; count: number };
export type CountryRow = { country_code: string; free_rooms: number; paid_rooms: number };
export type DiasporaRow = {
  steg_country: string;
  cf_country: string;
  free_rooms: number;
  paid_rooms: number;
};
export type BucketRow = { bucket: string; count: number };
export type DailyMetricRow = AggRow;

/** SUM(count)/SUM(sum_value) per metric over [from, to] (inclusive). */
export async function queryTotals(
  db: D1Database,
  from: string,
  to: string,
): Promise<MetricTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT metric, SUM(count) AS count, SUM(sum_value) AS sum_value
       FROM daily_metrics WHERE day >= ? AND day <= ? GROUP BY metric`,
    )
    .bind(from, to)
    .all<{ metric: string; count: number; sum_value: number }>();
  return (results ?? []).map((r) => ({
    metric: r.metric,
    count: Number(r.count ?? 0),
    sumValue: Number(r.sum_value ?? 0),
  }));
}

/** Per-day counts for a set of metrics over [from, to], oldest first. */
export async function queryDailyTrend(
  db: D1Database,
  from: string,
  to: string,
  metrics: MetricKey[],
): Promise<DailyTrendRow[]> {
  if (metrics.length === 0) return [];
  const placeholders = metrics.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT day, metric, SUM(count) AS count FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric IN (${placeholders})
       GROUP BY day, metric ORDER BY day ASC`,
    )
    .bind(from, to, ...metrics)
    .all<{ day: string; metric: string; count: number }>();
  return (results ?? []).map((r) => ({
    day: r.day,
    metric: r.metric,
    count: Number(r.count ?? 0),
  }));
}

function assembleCountryRows(
  rows: Array<{ code: string; metric: string; cnt: number }>,
): CountryRow[] {
  const map = new Map<string, { free: number; paid: number }>();
  for (const r of rows) {
    if (!r.code) continue;
    const e = map.get(r.code) ?? { free: 0, paid: 0 };
    if (r.metric === "room_free") e.free += Number(r.cnt ?? 0);
    else if (r.metric === "room_paid") e.paid += Number(r.cnt ?? 0);
    map.set(r.code, e);
  }
  return [...map.entries()]
    .map(([country_code, v]) => ({ country_code, free_rooms: v.free, paid_rooms: v.paid }))
    .sort((a, b) => b.free_rooms + b.paid_rooms - (a.free_rooms + a.paid_rooms));
}

/** room_free/room_paid grouped by steg-number country over [from, to]. */
export async function queryCountryRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<CountryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT steg_country AS code, metric, SUM(count) AS cnt FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric IN ('room_free','room_paid') AND steg_country <> ''
       GROUP BY steg_country, metric`,
    )
    .bind(from, to)
    .all<{ code: string; metric: string; cnt: number }>();
  return assembleCountryRows(results ?? []);
}

/** room_free/room_paid grouped by CF-IPCountry over [from, to]. */
export async function queryCfCountryRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<CountryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT cf_country AS code, metric, SUM(count) AS cnt FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric IN ('room_free','room_paid') AND cf_country <> ''
       GROUP BY cf_country, metric`,
    )
    .bind(from, to)
    .all<{ code: string; metric: string; cnt: number }>();
  return assembleCountryRows(results ?? []);
}

/** (steg, cf) country pairs for room_free/room_paid; rows where the two
 *  differ are diaspora signals. */
export async function queryDiasporaRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<DiasporaRow[]> {
  const { results } = await db
    .prepare(
      `SELECT steg_country, cf_country, metric, SUM(count) AS cnt FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric IN ('room_free','room_paid')
         AND steg_country <> '' AND cf_country <> ''
       GROUP BY steg_country, cf_country, metric`,
    )
    .bind(from, to)
    .all<{ steg_country: string; cf_country: string; metric: string; cnt: number }>();
  const map = new Map<string, { free: number; paid: number }>();
  for (const r of results ?? []) {
    const key = `${r.steg_country} ${r.cf_country}`;
    const e = map.get(key) ?? { free: 0, paid: 0 };
    if (r.metric === "room_free") e.free += Number(r.cnt ?? 0);
    else if (r.metric === "room_paid") e.paid += Number(r.cnt ?? 0);
    map.set(key, e);
  }
  return [...map.entries()]
    .map(([key, v]) => {
      const [steg_country, cf_country] = key.split(" ");
      return {
        steg_country: steg_country ?? "",
        cf_country: cf_country ?? "",
        free_rooms: v.free,
        paid_rooms: v.paid,
      };
    })
    .sort((a, b) => b.free_rooms + b.paid_rooms - (a.free_rooms + a.paid_rooms));
}

/** Bucket histogram for a distribution metric (room_lifespan / time_to_first_message). */
export async function queryHistogram(
  db: D1Database,
  from: string,
  to: string,
  metric: MetricKey,
): Promise<BucketRow[]> {
  const { results } = await db
    .prepare(
      `SELECT dim AS bucket, SUM(count) AS count FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric = ? GROUP BY dim`,
    )
    .bind(from, to, metric)
    .all<{ bucket: string; count: number }>();
  return (results ?? []).map((r) => ({ bucket: r.bucket, count: Number(r.count ?? 0) }));
}

export type PriceRow = { price: string; units: number; revenueMinor: number };
export type RevenueCountryRow = { country_code: string; units: number; revenueMinor: number };

/** Sales grouped by price point over [from, to]: units sold (count) and gross
 *  revenue in minor currency units (sum_value). dim holds the price label. */
export async function queryPricing(db: D1Database, from: string, to: string): Promise<PriceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT dim, SUM(count) AS units, SUM(sum_value) AS revenue FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric = 'paid_sale' GROUP BY dim ORDER BY units DESC`,
    )
    .bind(from, to)
    .all<{ dim: string; units: number; revenue: number }>();
  return (results ?? []).map((r) => ({
    price: r.dim,
    units: Number(r.units ?? 0),
    revenueMinor: Number(r.revenue ?? 0),
  }));
}

/** Sales grouped by steg-number country over [from, to]: units + revenue. */
export async function queryRevenueByCountry(
  db: D1Database,
  from: string,
  to: string,
): Promise<RevenueCountryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT steg_country, SUM(count) AS units, SUM(sum_value) AS revenue FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric = 'paid_sale' AND steg_country <> ''
       GROUP BY steg_country ORDER BY revenue DESC`,
    )
    .bind(from, to)
    .all<{ steg_country: string; units: number; revenue: number }>();
  return (results ?? []).map((r) => ({
    country_code: r.steg_country,
    units: Number(r.units ?? 0),
    revenueMinor: Number(r.revenue ?? 0),
  }));
}

/** Per-campaign funnel counts over [from, to]. dim holds the campaign slug. */
export async function queryFunnelRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<CampaignFunnel[]> {
  const { results } = await db
    .prepare(
      `SELECT metric, dim, SUM(count) AS cnt FROM daily_metrics
       WHERE day >= ? AND day <= ? AND metric LIKE 'funnel%' GROUP BY metric, dim`,
    )
    .bind(from, to)
    .all<{ metric: string; dim: string; cnt: number }>();
  const zero = (): Record<FunnelStep, number> =>
    Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>;
  const map = new Map<string, Record<FunnelStep, number>>();
  for (const r of results ?? []) {
    const step = r.metric.slice("funnel_".length);
    if (!isFunnelStep(step)) continue;
    const campaign = (r.dim || "direct").trim() || "direct";
    const steps = map.get(campaign) ?? zero();
    steps[step] += Number(r.cnt ?? 0);
    map.set(campaign, steps);
  }
  return [...map.entries()]
    .map(([campaign, steps]) => ({ campaign, steps }))
    .sort((a, b) => b.steps.landing - a.steps.landing);
}

/** Raw rows over [from, to] — used by tests and ad-hoc inspection. */
export async function queryRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<DailyMetricRow[]> {
  const { results } = await db
    .prepare(
      `SELECT day, metric, steg_country, cf_country, dim, count, sum_value FROM daily_metrics
       WHERE day >= ? AND day <= ? ORDER BY day, metric, dim`,
    )
    .bind(from, to)
    .all<{
      day: string;
      metric: string;
      steg_country: string;
      cf_country: string;
      dim: string;
      count: number;
      sum_value: number;
    }>();
  return (results ?? []).map((r) => ({
    day: r.day,
    metric: r.metric,
    stegCountry: r.steg_country,
    cfCountry: r.cf_country,
    dim: r.dim,
    count: Number(r.count ?? 0),
    sumValue: Number(r.sum_value ?? 0),
  }));
}
