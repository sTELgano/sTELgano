// SPDX-License-Identifier: AGPL-3.0-only
//
// Cloudflare Workers + Assets — single-file entry.
//
// `main = "./_worker.ts"` in wrangler.toml points here; wrangler
// bundles this module (and everything it imports from src/) on deploy.
// The RoomDO class export at the bottom of the file is how the
// [[durable_objects.bindings]] in wrangler.toml resolves
// `class_name = "RoomDO"`.
//
// `[assets] run_worker_first = true` means every request lands on this
// fetch handler first; env.ASSETS.fetch(request) at the bottom of
// dispatch() is the fall-through to static files in public/. That
// ordering is what lets applySecurityHeaders() wrap static asset
// responses with CSP / HSTS / X-Frame-Options — switch the flag off
// and static assets would bypass the Worker entirely, defeating
// Phase 8.
//
// Historical note: we started on Cloudflare Pages (initially
// file-based functions, then Pages Advanced Mode), then flipped to
// Workers + Assets once it became clear we were using zero
// Pages-specific features. docs/MIGRATION.md → "Why Workers + Assets
// (and not Pages)" captures the reasoning.

import { INLINE_SCRIPT_HASHES } from "./src/csp_hashes";
import type { Env } from "./src/env";
import {
  archiveCampaign,
  type Campaign,
  createCampaign,
  getCampaignBySlug,
  listCampaigns,
  normaliseDestination,
  SLUG_RE,
} from "./src/lib/campaigns";
import { type Bucket, renderFunnelBars, renderHistogram, renderTrendChart } from "./src/lib/charts";
import {
  type BucketRow,
  type CampaignFunnel,
  CONVERSION_BUCKETS,
  type CountryRow,
  type DailyTrendRow,
  type DateRange,
  type DiasporaRow,
  EXTENSION_BUCKETS,
  enqueueMetric,
  FUNNEL_STEPS,
  flushMetricBatch,
  HOURS_OF_DAY,
  isFunnelStep,
  LIFESPAN_BUCKETS,
  type MetricKey,
  type MetricMessage,
  type MetricTotal,
  type PriceRow,
  pageRoute,
  parseDateRange,
  priceLabel,
  queryCfCountryRange,
  queryCountryRange,
  queryDailyTrend,
  queryDiasporaRange,
  queryFunnelRange,
  queryHistogram,
  queryPricing,
  queryRevenueByCountry,
  queryTotals,
  type RevenueCountryRow,
  referrerCategory,
  sumFunnels,
  TTFM_BUCKETS,
  utcDay,
} from "./src/lib/daily_metrics";
import {
  createPending,
  deleteExpired,
  deleteToken,
  findByTokenHash,
  markPaid,
} from "./src/lib/extension_tokens";
import { type ActiveRooms, getActiveRooms } from "./src/lib/live_counters";
import {
  hmacSha512Hex,
  initialize as paystackInitialize,
  timingSafeHexEqual,
  verifyTransaction,
} from "./src/lib/paystack";

export { RoomDO } from "./src/room";

const ROOM_HASH_RE = /^[a-f0-9]{64}$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // WebSocket upgrade responses MUST NOT be mangled with extra
    // headers — Cloudflare's proxy rejects 101 responses that
    // carry non-upgrade headers. So we short-circuit the
    // security-header wrapper for the room WS path before routing.
    if (request.headers.get("upgrade") === "websocket") {
      return dispatch(request, env, url, ctx);
    }
    // Acquisition telemetry for content-page navigations (aggregate only:
    // a fixed route label + a coarse referrer category — never the URL,
    // query string, IP, or UA). waitUntil keeps the send alive past the
    // response; non-content paths skip.
    if (request.method === "GET") {
      const route = pageRoute(url.pathname);
      if (route) {
        enqueueMetric(env.METRICS_QUEUE, "page_view", { dim: route }, ctx);
        const cat = referrerCategory(request.headers.get("referer"), env.HOST);
        if (cat !== "internal") enqueueMetric(env.METRICS_QUEUE, "referrer", { dim: cat }, ctx);
      }
    }
    const response = await dispatch(request, env, url, ctx);
    return applySecurityHeaders(response, url.pathname);
  },

  // Cron handler — fires daily at 03:00 UTC via [triggers] in wrangler.toml.
  // Sweeps extension_tokens past their expires_at.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cutoff = new Date().toISOString();
    const swept = await deleteExpired(env.DB, cutoff);
    // Reliability: one data point per cron run; sum_value = tokens swept.
    enqueueMetric(env.METRICS_QUEUE, "cron_sweep", { value: swept }, ctx);
  },

  // Metrics queue consumer — the ONLY writer to daily_metrics. Coalesces the
  // whole batch by composite key and applies it in one transactional
  // db.batch() UPSERT. Throwing here fails the batch so the runtime retries
  // it (then routes to the DLQ after max_retries) — no metric is silently
  // dropped on a transient D1 error.
  async queue(batch: MessageBatch<MetricMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await flushMetricBatch(
      env.DB,
      batch.messages.map((m) => m.body),
    );
  },
} satisfies ExportedHandler<Env, MetricMessage>;

async function dispatch(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  // GET /healthz — used by deploy smoke tests, not by users.
  if (url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  // /.well-known/* — serve from public/wellknown/ via the ASSETS
  // binding. The real files live under a non-dotted directory
  // because Cloudflare's Workers + Assets runtime (and miniflare
  // under vitest-pool-workers) historically skipped dotfile
  // directories when bundling. Deployment stays stable, and RFC-
  // compliant clients still get the expected /.well-known/ URL.
  if (url.pathname.startsWith("/.well-known/")) {
    const rewritten = url.pathname.replace(/^\/\.well-known\//, "/wellknown/");
    return env.ASSETS.fetch(new Request(new URL(rewritten, url.origin), request));
  }

  // GET /x — panic route. Redirects to /?p=1; the root layout's
  // inline bootstrap detects the flag, calls sessionStorage.clear(),
  // and strips the flag from the URL via history.replaceState before
  // the user sees the address bar. Must be a single discoverable
  // URL per CLAUDE.md's Passcode Test — a suspicious partner should
  // not see anything worth investigating here.
  if (url.pathname === "/x") {
    return new Response(null, {
      status: 302,
      headers: { location: "/?p=1", "cache-control": "no-store" },
    });
  }

  // GET /room/:roomHash/ws — WebSocket upgrade routed to the room's DO.
  // The room_hash is validated as 64-char lowercase hex (the SHA-256
  // hex of the normalised phone + ROOM_SALT, exactly as in v1's
  // anon_socket.ex).
  const roomMatch = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
  if (roomMatch) {
    const roomHash = roomMatch[1] ?? "";
    if (!ROOM_HASH_RE.test(roomHash)) {
      return new Response("invalid room hash", { status: 400 });
    }
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const wsRl = await env.RATE_LIMITER_WS.limit({ key: ip }).catch(() => ({ success: true }));
    if (!wsRl.success) {
      enqueueMetric(env.METRICS_QUEUE, "ws_rate_limited", {}, ctx);
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    const id = env.ROOM.idFromName(roomHash);
    const stub = env.ROOM.get(id);
    // Inject the client IP so the RoomDO can enforce per-IP rate limits
    // on room creation. Headers are immutable on Request, so we copy them.
    const withIp = new Headers(request.headers);
    withIp.set("X-Client-IP", ip);
    // Forward CF-IPCountry so the RoomDO can include it in AE telemetry
    // as blob3 (complement to the client-derived steg-number country).
    withIp.set("X-CF-Country", (request.cf?.country ?? "") as string);
    return stub.fetch(new Request(request, { headers: withIp }));
  }

  // GET /c/:slug — campaign tracking link. Records a `landing` funnel
  // event attributed to the campaign, then 302-redirects to the
  // campaign's destination with ?c=<slug> so the homepage bootstrap can
  // persist the attribution for the rest of the funnel. Unknown or
  // archived slugs redirect to "/" with no event (no existence leak).
  const trackMatch = url.pathname.match(/^\/c\/([^/]+)$/);
  if (trackMatch && request.method === "GET") {
    return handleCampaignLink(trackMatch[1] ?? "", request, env, ctx);
  }

  // POST /api/funnel — lightweight, unauthenticated funnel beacon fired
  // by the client (navigator.sendBeacon) at each conversion step. Body
  // is { step, campaign }. The server adds CF-IPCountry and writes one
  // Analytics Engine data point. No stored state, no user data.
  if (url.pathname === "/api/funnel" && request.method === "POST") {
    return handleFunnelBeacon(request, env, ctx);
  }

  // POST /api/admin/campaigns — create a campaign (Basic-Auth gated).
  // Plain HTML form submission from the admin dashboard; redirects back.
  if (url.pathname === "/api/admin/campaigns" && request.method === "POST") {
    return handleCampaignCreate(request, env);
  }

  // POST /api/admin/campaigns/:id/archive — soft-delete a campaign.
  const archiveMatch = url.pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/archive$/);
  if (archiveMatch && request.method === "POST") {
    return handleCampaignArchive(archiveMatch[1] ?? "", request, env);
  }

  // GET /api/room/:roomHash/exists — probe whether a room has
  // been initialised. Client uses this before full join to
  // route first-time numbers through new_channel (tier
  // selection) vs. straight into connect. No auth — the
  // room_hash is already a SHA-256 hash of (phone + salt); if
  // the caller knows one, they already know the phone number
  // and ROOM_SALT.
  const existsMatch = url.pathname.match(/^\/api\/room\/([^/]+)\/exists$/);
  if (existsMatch && request.method === "GET") {
    const roomHash = existsMatch[1] ?? "";
    if (!ROOM_HASH_RE.test(roomHash)) {
      return jsonResponse({ error: "invalid_room_hash" }, 400);
    }
    const id = env.ROOM.idFromName(roomHash);
    const stub = env.ROOM.get(id);
    // Synthesise a request to the DO with a path that ends in
    // /exists. The DO inspects the pathname to distinguish this
    // from a WebSocket upgrade.
    return stub.fetch(new Request(new URL(`/${roomHash}/exists`, url), { method: "GET" }));
  }

  // POST /api/payment/initiate — payment client (chat.ts) calls
  // this with a token_hash. Creates the extension_tokens row
  // (status=pending) and returns a Paystack checkout URL the
  // client redirects to. Returns 503 when monetization is off.
  if (url.pathname === "/api/payment/initiate" && request.method === "POST") {
    return handlePaymentInitiate(request, env, ctx);
  }

  // POST /api/webhooks/paystack — Paystack hits this after a
  // successful charge. HMAC-SHA512 verifies the payload, then
  // we double-verify with Paystack's /transaction/verify, then
  // markPaid in D1. Returns 200 for all non-signature failures
  // so the response doesn't leak which references exist.
  if (url.pathname === "/api/webhooks/paystack" && request.method === "POST") {
    return handlePaystackWebhook(request, env, ctx);
  }

  // GET /api/config — exposes monetization/TTL settings to the
  // client. Used by chat.ts to render correct prices/TTL copy and
  // to decide whether to show the new_channel tier-selection screen.
  if (url.pathname === "/api/config" && request.method === "GET") {
    return jsonResponse({
      monetization_enabled: env.MONETIZATION_ENABLED === "true",
      free_ttl_days: parseInt(env.FREE_TTL_DAYS ?? "7", 10) || 7,
      paid_ttl_days: parseInt(env.PAID_TTL_DAYS ?? "365", 10) || 365,
      price_cents: parseInt(env.PRICE_CENTS ?? "200", 10) || 200,
      currency: env.PAYMENT_CURRENCY ?? "USD",
    });
  }

  // GET /admin — aggregate metrics dashboard. HTTP Basic Auth
  // against ADMIN_USERNAME / ADMIN_PASSWORD. Shows only counts —
  // never individual hashes, messages, or ciphertext.
  if (url.pathname === "/admin" && request.method === "GET") {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const adminRl = await env.RATE_LIMITER_ADMIN.limit({ key: ip }).catch(() => ({
      success: true,
    }));
    if (!adminRl.success) {
      enqueueMetric(env.METRICS_QUEUE, "admin_rate_limited", {}, ctx);
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60", "content-type": "text/plain" },
      });
    }
    return handleAdminDashboard(request, env);
  }

  // Static assets fall-through — the ASSETS binding serves files
  // from public/. A missing /foo returns the binding's default 404
  // (not index.html) since wrangler.toml doesn't opt in to
  // not_found_handling = "single-page-application".
  return env.ASSETS.fetch(request);
}

// ---------------------------------------------------------------------------
// Security headers + CSP middleware
//
// Ports elixir/lib/stelgano_web/plugs/security_headers.ex and
// elixir/lib/stelgano_web/plugs/csp_nonce.ex. Two notable
// differences from v1:
//
//  1. CSP uses SHA-256 hashes of every inline <script> body
//     (computed at build time by scripts/build-csp-hashes.mjs
//     and imported from src/csp_hashes.ts), NOT a per-request
//     nonce. v1 could issue a fresh nonce per request because
//     LiveView re-rendered the layout on every request; v2
//     serves static HTML from CF Pages' edge cache and the same
//     bytes ship to every user, so nonce would have to flip
//     dynamically on each request for every HTML — expensive
//     per-request rewriting. Hashes are a static, cacheable
//     allow-list that closes the same XSS hole.
//
//  2. Headers apply to EVERY response via fetch() wrapper — plug
//     equivalent. WebSocket 101 responses are excluded (CF
//     rejects non-upgrade headers on WS responses).
// ---------------------------------------------------------------------------

const SENSITIVE_PATHS = new Set(["/chat", "/admin", "/payment/callback"]);

function buildCsp(): string {
  const hashList = INLINE_SCRIPT_HASHES.map((h) => `'${h}'`).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' ${hashList}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // WebSocket + HTTPS-only for /api/* fetches (same-origin).
    // Paystack iframe isn't embedded — checkout happens via full-
    // page navigation, so no connect-src exception is needed.
    "connect-src 'self' wss: ws:",
    "img-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // form-action limited to same-origin. Paystack navigation is
    // location.href (not form submission), so not restricted here.
    "form-action 'self'",
  ].join("; ");
}

const CSP_HEADER_VALUE = buildCsp();

function applySecurityHeaders(response: Response, pathname: string): Response {
  const h = new Headers(response.headers);

  // Always-on headers.
  h.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  h.set("content-security-policy", CSP_HEADER_VALUE);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  // Locks down powerful features we never use so a compromised
  // dependency can't silently request them. Matches the no-PWA,
  // no-multimedia stance in CLAUDE.md.
  h.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), gyroscope=(), accelerometer=(), magnetometer=()",
  );
  // Bar cross-origin resource loading of our pages — can't be
  // embedded anywhere, consistent with frame-ancestors 'none'.
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");

  // Sensitive-path conditional headers.
  if (SENSITIVE_PATHS.has(pathname)) {
    // /chat, /admin, /payment/callback must never be indexed — a
    // search engine crawling the chat entry screen leaks the URL
    // and the app's intent. (Passcode Test: if the attacker reads
    // the URL from history, they should learn nothing.)
    h.set("x-robots-tag", "noindex, nofollow");
    // No caching — a stale /chat in the disk cache could be found
    // via Ctrl+H or browser cache inspection.
    h.set("cache-control", "no-store, no-cache, must-revalidate, private");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// ---------------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------------

/** Constant-time-ish string compare to avoid leaking the expected
 *  password length via response-time differences. Not cryptographic —
 *  just defence in depth against trivial timing oracles. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function checkBasicAuth(request: Request, env: Env): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  const expectedUser = env.ADMIN_USERNAME || "admin";
  return timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, env.ADMIN_PASSWORD);
}

function basicAuthChallenge(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="stelgano admin", charset="UTF-8"',
      "cache-control": "no-store",
    },
  });
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Trend series shown on the overview chart, with display colours.
const TREND_METRICS: Array<{ metric: MetricKey; label: string; color: string }> = [
  { metric: "room_free", label: "New free", color: "#64748b" },
  { metric: "room_paid", label: "New paid", color: "#10B981" },
  { metric: "message_sent", label: "Messages", color: "#38bdf8" },
];

async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
  if (!checkBasicAuth(request, env)) return basicAuthChallenge();

  const url = new URL(request.url);
  const range = parseDateRange(url.searchParams, Date.now());
  const { from, to } = range;

  let totals: MetricTotal[] = [];
  let trend: DailyTrendRow[] = [];
  let country: CountryRow[] = [];
  let cfCountry: CountryRow[] = [];
  let diaspora: DiasporaRow[] = [];
  let funnels: CampaignFunnel[] = [];
  let lifespanHist: BucketRow[] = [];
  let ttfmHist: BucketRow[] = [];
  let extensionHist: BucketRow[] = [];
  let conversionHist: BucketRow[] = [];
  let activityHourHist: BucketRow[] = [];
  let pageViews: BucketRow[] = [];
  let referrers: BucketRow[] = [];
  let pricing: PriceRow[] = [];
  let revenueByCountry: RevenueCountryRow[] = [];
  let campaigns: Campaign[] = [];
  let activeRooms: ActiveRooms = { total: 0, free: 0, paid: 0 };
  try {
    [
      totals,
      trend,
      country,
      cfCountry,
      diaspora,
      funnels,
      lifespanHist,
      ttfmHist,
      extensionHist,
      conversionHist,
      activityHourHist,
      pageViews,
      referrers,
      pricing,
      revenueByCountry,
      campaigns,
      activeRooms,
    ] = await Promise.all([
      queryTotals(env.DB, from, to),
      queryDailyTrend(
        env.DB,
        from,
        to,
        TREND_METRICS.map((t) => t.metric),
      ),
      queryCountryRange(env.DB, from, to),
      queryCfCountryRange(env.DB, from, to),
      queryDiasporaRange(env.DB, from, to),
      queryFunnelRange(env.DB, from, to),
      queryHistogram(env.DB, from, to, "room_lifespan"),
      queryHistogram(env.DB, from, to, "time_to_first_message"),
      queryHistogram(env.DB, from, to, "extension"),
      queryHistogram(env.DB, from, to, "time_to_paid"),
      queryHistogram(env.DB, from, to, "activity_hour"),
      queryHistogram(env.DB, from, to, "page_view"),
      queryHistogram(env.DB, from, to, "referrer"),
      queryPricing(env.DB, from, to),
      queryRevenueByCountry(env.DB, from, to),
      listCampaigns(env.DB).catch(() => [] as Campaign[]),
      getActiveRooms(env.DB),
    ]);
  } catch {
    // D1 unavailable — render an empty dashboard rather than 500.
  }

  const html = renderAdminHtml({
    updated: `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    origin: url.origin,
    range,
    totals,
    trend,
    country,
    cfCountry,
    diaspora,
    funnels,
    lifespanHist,
    ttfmHist,
    extensionHist,
    conversionHist,
    activityHourHist,
    pageViews,
    referrers,
    pricing,
    revenueByCountry,
    campaigns,
    activeRooms,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Total count for a metric over the range (0 when absent). */
function metricCount(totals: MetricTotal[], metric: MetricKey): number {
  return totals.find((t) => t.metric === metric)?.count ?? 0;
}
/** Summed numeric payload for a distribution metric (0 when absent). */
function metricSum(totals: MetricTotal[], metric: MetricKey): number {
  return totals.find((t) => t.metric === metric)?.sumValue ?? 0;
}

/** Inclusive list of 'YYYY-MM-DD' UTC days across the range (already
 *  clamped to <=366 days upstream). */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) days.push(utcDay(t));
  return days;
}

/** Reorders a histogram into canonical bucket order, zero-filling gaps. */
function orderedBuckets(hist: BucketRow[], order: readonly string[]): Bucket[] {
  const m = new Map(hist.map((h) => [h.bucket, h.count]));
  return order.map((label) => ({ label, count: m.get(label) ?? 0 }));
}

/** Human-readable average of summed seconds across `count` events. */
function avgDurationFromSeconds(sumSeconds: number, count: number): string {
  if (count <= 0) return "—";
  const s = sumSeconds / count;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** Human-readable average of summed hours across `count` events. */
function avgDurationFromHours(sumHours: number, count: number): string {
  if (count <= 0) return "—";
  const h = sumHours / count;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Integer percentage of n/total (0 when total is 0). */
function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/** Renders a price-point label ("USD_200") as "USD 2.00", and a revenue
 *  amount in minor units as a major-unit decimal. */
function formatPriceLabel(label: string): string {
  const [cur, cents] = label.split("_");
  const n = Number(cents);
  if (!cur || !Number.isFinite(n)) return label;
  return `${cur} ${(n / 100).toFixed(2)}`;
}
function formatMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function renderAdminHtml(d: {
  updated: string;
  origin: string;
  range: DateRange;
  totals: MetricTotal[];
  trend: DailyTrendRow[];
  country: CountryRow[];
  cfCountry: CountryRow[];
  diaspora: DiasporaRow[];
  funnels: CampaignFunnel[];
  lifespanHist: BucketRow[];
  ttfmHist: BucketRow[];
  extensionHist: BucketRow[];
  conversionHist: BucketRow[];
  activityHourHist: BucketRow[];
  pageViews: BucketRow[];
  referrers: BucketRow[];
  pricing: PriceRow[];
  revenueByCountry: RevenueCountryRow[];
  campaigns: Campaign[];
  activeRooms: ActiveRooms;
}): string {
  // `shrink-0` is essential: without it an inline SVG inside a flex row
  // shrinks toward zero width when space is tight (small screens), so the
  // icon visually disappears and collides with adjacent text.
  const iconSvg = (name: string, cls = "size-4") =>
    `<svg class="${cls} shrink-0" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

  // --- Derived headline figures over the selected range ---
  // Every channel is created on the free tier; room_paid is a *conversion* of
  // an existing free channel (via redeem_extension), never an independent
  // creation. So the count of distinct channels created is room_free alone —
  // adding paid would double-count every channel that later converted. The
  // free/paid split below is therefore a subset breakdown that sums to created.
  const free = metricCount(d.totals, "room_free");
  const paid = metricCount(d.totals, "room_paid");
  const created = free;
  const stillFree = Math.max(0, free - paid);
  const messages = metricCount(d.totals, "message_sent");
  const secondParty = metricCount(d.totals, "second_party_joined");
  const extended = metricCount(d.totals, "room_extended");
  const expiredFree = metricCount(d.totals, "room_expired_free");
  const expiredPaid = metricCount(d.totals, "room_expired_paid");
  const expiredEmpty = metricCount(d.totals, "room_expired_empty");
  const accessFailed = metricCount(d.totals, "access_failed");
  const lockouts = metricCount(d.totals, "access_lockout");

  // --- Trend chart series (zero-filled across every day in range) ---
  const days = eachDay(d.range.from, d.range.to);
  const trendLookup = new Map<string, number>();
  for (const r of d.trend) trendLookup.set(`${r.metric}${r.day}`, r.count);
  const trendChart = renderTrendChart(
    TREND_METRICS.map((t) => ({
      label: t.label,
      color: t.color,
      points: days.map((day) => trendLookup.get(`${t.metric}${day}`) ?? 0),
    })),
    days,
  );

  // --- Signups-by-day table (exact per-date counts; peak day flagged) ---
  // The trend chart shows shape but not readable numbers; this answers
  // "which UTC day had the most signups?" directly. Built from the same
  // d.trend rows, most-recent first, days with zero signups omitted.
  const signupByDay = new Map<string, { free: number; paid: number }>();
  for (const r of d.trend) {
    if (r.metric !== "room_free" && r.metric !== "room_paid") continue;
    const e = signupByDay.get(r.day) ?? { free: 0, paid: 0 };
    if (r.metric === "room_free") e.free += r.count;
    else e.paid += r.count;
    signupByDay.set(r.day, e);
  }
  const signupRows = [...signupByDay.entries()]
    .map(([day, v]) => ({ day, free: v.free, paid: v.paid, total: v.free + v.paid }))
    .filter((r) => r.total > 0)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  const peakTotal = Math.max(0, ...signupRows.map((r) => r.total));
  const signupsByDayTable =
    signupRows.length === 0
      ? `<tr><td colspan="4" class="py-6 text-sm text-slate-500 italic">No signups in this range. Widen the date range to see older history.</td></tr>`
      : signupRows
          .map((r) => {
            const peak = peakTotal > 0 && r.total === peakTotal;
            return `<tr class="border-b border-white/5 ${peak ? "bg-primary/10" : ""}">
              <td class="py-2.5 pr-8 font-mono ${peak ? "text-primary font-bold" : "text-white"}">${escapeAttr(r.day)}${peak ? ' <span class="text-[10px] uppercase tracking-widest">peak</span>' : ""}</td>
              <td class="py-2.5 pr-8 text-right font-mono text-slate-300">${r.free}</td>
              <td class="py-2.5 pr-8 text-right font-mono text-slate-300">${r.paid}</td>
              <td class="py-2.5 text-right font-mono ${peak ? "text-primary font-bold" : "text-white"}">${r.total}</td>
            </tr>`;
          })
          .join("");

  // --- Engagement distributions ---
  const ttfmAvg = avgDurationFromSeconds(
    metricSum(d.totals, "time_to_first_message"),
    metricCount(d.totals, "time_to_first_message"),
  );
  const lifespanAvg = avgDurationFromHours(
    metricSum(d.totals, "room_lifespan"),
    metricCount(d.totals, "room_lifespan"),
  );
  const ttfmHistHtml = renderHistogram(orderedBuckets(d.ttfmHist, TTFM_BUCKETS));
  const lifespanHistHtml = renderHistogram(orderedBuckets(d.lifespanHist, LIFESPAN_BUCKETS));
  const expiredSolo = metricCount(d.totals, "room_expired_solo");

  // --- Activity: hour-of-day histogram + weekday distribution (derived) ---
  const activityHourHtml = renderHistogram(orderedBuckets(d.activityHourHist, HOURS_OF_DAY));
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayCounts = new Map<string, number>();
  for (const r of d.trend) {
    const wd = WEEKDAYS[new Date(`${r.day}T00:00:00Z`).getUTCDay()] ?? "";
    weekdayCounts.set(wd, (weekdayCounts.get(wd) ?? 0) + r.count);
  }
  const weekdayHtml = renderHistogram(
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((l) => ({
      label: l,
      count: weekdayCounts.get(l) ?? 0,
    })),
  );

  // --- Acquisition ---
  const pageViewsHtml = renderHistogram(
    [...d.pageViews]
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ label: r.bucket, count: r.count })),
  );
  const referrerHtml = renderHistogram(
    [...d.referrers]
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ label: r.bucket, count: r.count })),
  );
  const edited = metricCount(d.totals, "message_edited");
  const deleted = metricCount(d.totals, "message_deleted");
  const reads = metricCount(d.totals, "message_read");
  const rejoins = metricCount(d.totals, "room_rejoin");

  // --- Monetization ---
  const sales = metricCount(d.totals, "paid_sale");
  const revenueMinor = metricSum(d.totals, "paid_sale");
  const paymentsInitiated = metricCount(d.totals, "payment_initiated");
  const paymentsPaid = metricCount(d.totals, "payment_paid");
  const redeemFailed = metricCount(d.totals, "redeem_failed");
  const extensionHistHtml = renderHistogram(orderedBuckets(d.extensionHist, EXTENSION_BUCKETS));
  const conversionAvg = avgDurationFromHours(
    metricSum(d.totals, "time_to_paid"),
    metricCount(d.totals, "time_to_paid"),
  );
  const conversionHistHtml = renderHistogram(orderedBuckets(d.conversionHist, CONVERSION_BUCKETS));
  const paymentFunnelHtml = renderFunnelBars([
    { label: "Checkout initiated", count: paymentsInitiated },
    { label: "Payment confirmed", count: paymentsPaid },
    { label: "Redeemed (sale)", count: sales },
  ]);
  const pricingRows = d.pricing.length
    ? d.pricing
        .map(
          (r) => `
          <tr class="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(formatPriceLabel(r.price))}</td>
            <td class="py-3 pr-8 text-right font-mono text-primary">${r.units}</td>
            <td class="py-3 text-right font-mono text-slate-300">${formatMinor(r.revenueMinor)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="py-4 text-sm text-slate-500 italic">No sales yet for this range.</td></tr>`;
  const revenueCountryRows = d.revenueByCountry.length
    ? d.revenueByCountry
        .map(
          (r) => `
          <tr class="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(r.country_code)}</td>
            <td class="py-3 pr-8 text-right font-mono text-primary">${r.units}</td>
            <td class="py-3 text-right font-mono text-slate-300">${formatMinor(r.revenueMinor)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="py-4 text-sm text-slate-500 italic">No sales yet for this range.</td></tr>`;

  // --- Geography tables ---
  const countryTable = (rows: CountryRow[], emptyMsg: string) =>
    rows.length
      ? rows
          .map(
            (r) => `
          <tr class="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(r.country_code)}</td>
            <td class="py-3 pr-8 text-right font-mono text-slate-300">${r.free_rooms}</td>
            <td class="py-3 pr-8 text-right font-mono text-primary">${r.paid_rooms}</td>
            <td class="py-3 text-right font-mono text-slate-400">${r.free_rooms + r.paid_rooms}</td>
          </tr>`,
          )
          .join("")
      : `<tr><td colspan="4" class="py-4 text-sm text-slate-500 italic">${escapeAttr(emptyMsg)}</td></tr>`;

  const diasporaRows = d.diaspora.length
    ? d.diaspora
        .map((r) => {
          const indicator =
            r.steg_country !== r.cf_country
              ? `<span class="inline-block size-1.5 rounded-full bg-primary ml-1" title="diaspora"></span>`
              : "";
          return `
          <tr class="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(r.steg_country)}${indicator}</td>
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(r.cf_country)}</td>
            <td class="py-3 pr-8 text-right font-mono text-slate-300">${r.free_rooms}</td>
            <td class="py-3 pr-8 text-right font-mono text-primary">${r.paid_rooms}</td>
            <td class="py-3 text-right font-mono text-slate-400">${r.free_rooms + r.paid_rooms}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="py-4 text-sm text-slate-500 italic">No diaspora data yet for this range.</td></tr>`;

  const campaignsSection = renderCampaignsSection(d.campaigns, d.funnels, d.origin, iconSvg);

  // --- Sidebar + date range controls ---
  const navItems: Array<[string, string, string]> = [
    ["overview", "Overview", "bar_chart_3"],
    ["geography", "Geography", "globe"],
    ["engagement", "Engagement", "users"],
    ["monetization", "Monetization", "sparkles"],
    ["funnel", "Funnel & Campaigns", "list"],
    ["security", "Security", "shield"],
  ];
  const sidebarNav = navItems
    .map(
      ([id, label, icon]) => `
            <a href="#${id}" class="flex items-center gap-3 px-3 py-3 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap">
              ${iconSvg(icon, "size-4 text-primary/70")}
              <span class="text-[11px] font-black uppercase tracking-[0.2em]">${escapeAttr(label)}</span>
            </a>`,
    )
    .join("");

  const quickRanges = [7, 30, 90, 365]
    .map((n) => {
      const active = d.range.days === n;
      const cls = active
        ? "bg-primary/20 border-primary/40 text-primary"
        : "border-white/10 text-slate-400 hover:text-white hover:border-white/20";
      return `<a href="/admin?days=${n}" class="px-3 py-2 rounded-lg border text-[11px] font-mono ${cls} transition-colors">${n}d</a>`;
    })
    .join("");

  const sectionHeader = (icon: string, title: string, blurb: string) => `
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg(icon, "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">${escapeAttr(title)}</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">${blurb}</p>`;

  return `<!DOCTYPE html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="en" data-theme="dark" style="scroll-behavior:smooth">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Admin — sTELgano</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="antialiased">
  <div class="bg-grid-container">
    <div class="bg-grid"></div>
    <div class="noise-overlay"></div>
  </div>

  <div class="flex flex-col md:flex-row min-h-dvh">
    <!-- Sidebar -->
    <aside class="md:w-60 md:shrink-0 md:h-dvh md:sticky md:top-0 border-b md:border-b-0 md:border-r border-white/5 bg-slate-950/40 backdrop-blur-xl z-10">
      <div class="p-5 md:p-6 md:space-y-8">
        <div class="flex items-center gap-2 mb-4 md:mb-0">
          <span class="wordmark text-lg">sTELgano</span>
          <span class="px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px] font-black uppercase tracking-[0.2em]">Admin</span>
        </div>
        <nav class="flex md:flex-col gap-1 overflow-x-auto">${sidebarNav}</nav>
        <div class="hidden md:block pt-6 border-t border-white/5 space-y-1">
          <p class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Range</p>
          <p class="text-[11px] font-mono text-slate-400">${escapeAttr(d.range.label)}</p>
          <p class="text-[10px] text-slate-600 pt-2">All times UTC · Updated ${escapeAttr(d.updated)}</p>
        </div>
      </div>
    </aside>

    <!-- Main -->
    <main class="flex-1 min-w-0 overflow-y-auto">
      <div class="max-w-5xl mx-auto px-4 sm:px-8 py-8 space-y-10 animate-in pb-24">
        <!-- Header + date range -->
        <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6 border-b border-white/5">
          <div class="space-y-2">
            <h1 class="text-3xl sm:text-5xl font-extrabold text-white font-display tracking-tighter uppercase leading-none">
              Admin <span class="text-gradient">Dashboard.</span>
            </h1>
            <p class="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">
              Aggregate stats only · No private data · ${escapeAttr(d.range.label)}
            </p>
          </div>
          <form method="get" action="/admin" class="flex flex-wrap items-end gap-3">
            <div class="space-y-1">
              <label for="from" class="block text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">From</label>
              <input type="date" id="from" name="from" value="${escapeAttr(d.range.from)}" class="glass-input py-2 px-3 text-sm" />
            </div>
            <div class="space-y-1">
              <label for="to" class="block text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">To</label>
              <input type="date" id="to" name="to" value="${escapeAttr(d.range.to)}" class="glass-input py-2 px-3 text-sm" />
            </div>
            <button type="submit" class="btn-primary py-2.5 px-6 text-sm flex items-center gap-2">${iconSvg("refresh_cw", "size-4")} Apply</button>
            <div class="flex items-center gap-1.5">${quickRanges}</div>
          </form>
        </div>

        <!-- Overview -->
        <section id="overview" class="scroll-mt-6 space-y-8">
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            ${adminMetricCard("Active Channels", d.activeRooms.total, `${d.activeRooms.free} free · ${d.activeRooms.paid} paid`, "radio", true)}
            ${adminMetricCard("Channels Created", created, `${stillFree} free · ${paid} paid`, "check_circle")}
            ${adminMetricCard("Messages Sent", messages, "Encrypted, over range", "message_circle")}
            ${adminMetricCard("Activation", `${pct(secondParty, created)}%`, "Two-party channels", "users")}
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            ${adminMetricCard("Paid Conversion", `${pct(paid, created)}%`, "Paid of all created", "sparkles")}
            ${adminMetricCard("Extensions", extended, "Repeat paid renewals", "calendar")}
            ${adminMetricCard("Empty Expiries", `${pct(expiredEmpty, expiredFree + expiredPaid)}%`, "Expired, never messaged", "alert_triangle")}
            ${adminMetricCard("Lockouts", lockouts, `${accessFailed} failed attempts`, "shield")}
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("bar_chart_3", "Daily Trend", "New free / new paid channels and messages per UTC day across the selected range. Exact counts — no sampling.")}
            ${trendChart}
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("calendar", "Signups by Day", "Exact new-channel counts per UTC day, most recent first. Peak day highlighted. Widen the date range (e.g. ?days=90) to include older history.")}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Date (UTC)</th><th class="py-3 pr-8 text-right">Free</th><th class="py-3 pr-8 text-right">Paid</th><th class="py-3 text-right">Total</th>
              </tr></thead><tbody>${signupsByDayTable}</tbody></table></div>
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("radio", "Activity by Hour (UTC)", "When channels are created and messages flow, by UTC hour. Global — no per-event timestamps stored, only an hour bucket.")}
              ${activityHourHtml}
            </div>
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("calendar", "Activity by Weekday (UTC)", "New channels + messages summed per weekday across the range.")}
              ${weekdayHtml}
            </div>
          </div>
        </section>

        <!-- Geography -->
        <section id="geography" class="scroll-mt-6 space-y-8">
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("globe", "Rooms by Steg-Number Country", `Country derived client-side from the E.164 steg number. Answers "which country's phone format was adopted?" — never stored alongside any individual room record.`)}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Country</th><th class="py-3 pr-8 text-right">Free</th><th class="py-3 pr-8 text-right">Paid</th><th class="py-3 text-right">Total</th>
              </tr></thead><tbody>${countryTable(d.country, "No country data yet for this range.")}</tbody></table></div>
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("globe", "Rooms by IP Location (CF-IPCountry)", `Country derived server-side from the connecting IP. Differs from the steg-number country for diaspora users, travellers, and VPN users.`)}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Country</th><th class="py-3 pr-8 text-right">Free</th><th class="py-3 pr-8 text-right">Paid</th><th class="py-3 text-right">Total</th>
              </tr></thead><tbody>${countryTable(d.cfCountry, "No IP-country data yet for this range.")}</tbody></table></div>
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("users", "Diaspora · Steg vs IP Country", `Rows where Steg ≠ CF country (marked <span class="inline-block size-1.5 rounded-full bg-primary mb-0.5"></span>) reveal diaspora usage.`)}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Steg</th><th class="py-3 pr-8">CF</th><th class="py-3 pr-8 text-right">Free</th><th class="py-3 pr-8 text-right">Paid</th><th class="py-3 text-right">Total</th>
              </tr></thead><tbody>${diasporaRows}</tbody></table></div>
          </div>
        </section>

        <!-- Engagement -->
        <section id="engagement" class="scroll-mt-6 space-y-8">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("message_circle", `Time to First Message · avg ${escapeAttr(ttfmAvg)}`, "How long after a channel is created before its first message. Distribution from bucketed counts (no per-message timestamps stored).")}
              ${ttfmHistHtml}
            </div>
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("calendar", `Channel Lifespan · avg ${escapeAttr(lifespanAvg)}`, "Total time from creation to expiry, including extensions. Averages from summed values; medians are not available without per-room data.")}
              ${lifespanHistHtml}
            </div>
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            ${adminMetricCard("Messages Read", reads, "Read receipts fired", "check_circle")}
            ${adminMetricCard("Messages Edited", edited, "Edited before read", "message_circle")}
            ${adminMetricCard("Messages Deleted", deleted, "Deleted before read", "message_circle")}
            ${adminMetricCard("Rejoins", rejoins, "Returning party re-entries", "radio")}
            ${adminMetricCard("Solo Expiries", `${pct(expiredSolo, expiredFree + expiredPaid)}%`, "Expired, never a 2nd party", "users")}
          </div>
        </section>

        <!-- Monetization -->
        <section id="monetization" class="scroll-mt-6 space-y-8">
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            ${adminMetricCard("Sales", sales, "Paid extensions realized", "sparkles")}
            ${adminMetricCard("Revenue", formatMinor(revenueMinor), "Sum over range (minor → major)", "bar_chart_3")}
            ${adminMetricCard("Pay Conversion", `${pct(paymentsPaid, paymentsInitiated)}%`, "Confirmed of initiated", "check_circle")}
            ${adminMetricCard("Redeem Failures", redeemFailed, "Invalid / pending tokens", "alert_triangle")}
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("list", "Payment Funnel", "Server-side: checkout initiated → payment confirmed (webhook) → redeemed in a channel. The gaps are abandonment. Aggregate counts, never linked to a room.")}
              ${paymentFunnelHtml}
            </div>
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("calendar", "Extension Depth", "How many times numbers have been paid for: x1 = first purchase, x2 = first renewal, … A retention distribution, tracked per number in DO state, never by hash.")}
              ${extensionHistHtml}
            </div>
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("calendar", `Time to Paid · avg ${escapeAttr(conversionAvg)}`, "How long a number stays free (weekly) before its first paid extension. Distribution from bucketed counts — your free→paid conversion latency.")}
            ${conversionHistHtml}
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("sparkles", "Sales by Price Point", "Units sold and gross revenue per price, over the range. Revenue is shown in major units; the price label carries the currency.")}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Price</th><th class="py-3 pr-8 text-right">Units</th><th class="py-3 text-right">Revenue</th>
              </tr></thead><tbody>${pricingRows}</tbody></table></div>
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("globe", "Revenue by Steg-Number Country", "Units sold and gross revenue grouped by the steg number's country. Aggregate only — no number, hash, or payment reference is stored.")}
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Country</th><th class="py-3 pr-8 text-right">Units</th><th class="py-3 text-right">Revenue</th>
              </tr></thead><tbody>${revenueCountryRows}</tbody></table></div>
          </div>
        </section>

        <!-- Funnel & Campaigns -->
        <section id="funnel" class="scroll-mt-6 space-y-8">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("globe", "Page Views by Route", "Content-page navigations over the range. Aggregate route labels only — no URL, query string, IP, or UA is stored.")}
              ${pageViewsHtml}
            </div>
            <div class="glass-card p-6 sm:p-10 space-y-6">
              ${sectionHeader("list", "Traffic Source", "Coarse referrer category (search / social / other / direct). The full referrer URL is never stored; internal navigation is not counted.")}
              ${referrerHtml}
            </div>
          </div>
          ${campaignsSection}
        </section>

        <!-- Security -->
        <section id="security" class="scroll-mt-6 space-y-8">
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("shield", "Access & Abuse", "Wrong-PIN attempts, 30-minute lockouts, and per-IP join rate-limit rejections over the range — your signal for credential-stuffing, slot-squatting, or targeted access attempts. Global counts, no country or room linkage.")}
            <div class="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              ${adminMetricCard("Failed Attempts", accessFailed, "Wrong PIN on a full room", "alert_triangle")}
              ${adminMetricCard("Lockouts", lockouts, "10 fails → 30-min lock", "shield")}
              ${adminMetricCard("Rate-Limited Joins", metricCount(d.totals, "join_rate_limited"), "Per-IP create/slot blocks", "shield")}
            </div>
          </div>
          <div class="glass-card p-6 sm:p-10 space-y-6">
            ${sectionHeader("radio", "Edge & Reliability", "WebSocket-upgrade and /admin rate-limit rejections at the edge, and the daily token-sweep cron. Aggregate counts for operational visibility.")}
            <div class="grid grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              ${adminMetricCard("WS Rate-Limited", metricCount(d.totals, "ws_rate_limited"), "Upgrade rejections (30/IP/min)", "shield")}
              ${adminMetricCard("Admin Rate-Limited", metricCount(d.totals, "admin_rate_limited"), "/admin rejections (20/IP/min)", "shield")}
              ${adminMetricCard("Tokens Swept", metricSum(d.totals, "cron_sweep"), `${metricCount(d.totals, "cron_sweep")} cron runs`, "calendar")}
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</body>
</html>
`;
}

function adminMetricCard(
  label: string,
  value: number | string,
  note: string,
  icon: string,
  active = false,
): string {
  const activeDot = active
    ? '<div class="size-2 shrink-0 rounded-full bg-primary animate-pulse shadow-[0_0_8px_var(--color-primary)]"></div>'
    : "";
  // Icon sits alone on the top row (with the optional live dot). The note is
  // a full-width line BELOW the value/label — never crammed beside the icon,
  // which overflowed and overlapped it on narrow 2-column mobile cards.
  return `
    <div class="glass-card-premium p-5 sm:p-8 space-y-4 group hover:border-primary/50 transition-all duration-500">
      <div class="flex items-center justify-between gap-2">
        <div class="size-11 sm:size-14 shrink-0 rounded-2xl bg-primary/5 flex items-center justify-center border border-primary/20 group-hover:border-primary/40 group-hover:bg-primary/10 transition-all">
          <svg class="size-5 sm:size-7 text-primary/40 group-hover:text-primary transition-colors" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>
        </div>
        ${activeDot}
      </div>
      <div class="space-y-1.5">
        <div class="text-3xl sm:text-5xl font-mono font-black text-white tracking-tighter break-words">
          ${escapeAttr(String(value))}
        </div>
        <div class="text-[10px] sm:text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">
          ${escapeAttr(label)}
        </div>
        <div class="text-[9px] sm:text-[10px] font-medium uppercase tracking-wider text-slate-600 leading-snug">
          ${escapeAttr(note)}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Campaigns + conversion-funnel rendering
// ---------------------------------------------------------------------------

const FUNNEL_LABELS: Record<string, string> = {
  landing: "Landing",
  chat_view: "Visited /chat",
  steg_generated: "Generated #",
  channel_opened: "Opened channel",
  extend_started: "Started extend",
  extend_completed: "Extended",
};

function emptyFunnel(): Record<string, number> {
  const z: Record<string, number> = {};
  for (const s of FUNNEL_STEPS) z[s] = 0;
  return z;
}

/** One-line headline for a funnel: top-of-funnel size + the two rates
 *  that matter most — activation (reached an open channel) and paid
 *  (extended a number), both relative to landings. */
function funnelSummary(steps: Record<string, number>): string {
  const landing = steps.landing ?? 0;
  const pct = (n: number) => (landing > 0 ? Math.round((n / landing) * 100) : 0);
  return `${landing} landings · activation ${pct(steps.channel_opened ?? 0)}% · paid ${pct(steps.extend_completed ?? 0)}%`;
}

/** Renders the whole Campaigns dashboard block: the platform-wide
 *  overall funnel, a create form, and one funnel card per campaign
 *  (plus a Direct/organic bucket and read-only archived buckets). */
function renderCampaignsSection(
  campaigns: Campaign[],
  funnels: CampaignFunnel[],
  origin: string,
  iconSvg: (name: string, cls?: string) => string,
): string {
  const byCampaign = new Map<string, Record<string, number>>();
  for (const f of funnels) byCampaign.set(f.campaign, f.steps);

  // Platform-wide funnel: every campaign + direct summed into one. The
  // link-independent view of overall conversion health.
  const overall = sumFunnels(funnels);
  const overallCard = renderFunnelCard({
    title: "Overall platform funnel",
    subtitle: funnelSummary(overall),
    steps: overall,
    highlight: true,
  });

  const cards: string[] = [];

  // Direct / organic bucket — everyone with no campaign attribution.
  cards.push(
    renderFunnelCard({
      title: "Direct / organic",
      subtitle: "Visitors with no campaign link",
      steps: byCampaign.get("direct") ?? emptyFunnel(),
    }),
  );

  // One card per active campaign (from D1).
  const known = new Set<string>(["direct"]);
  for (const c of campaigns) {
    known.add(c.slug);
    cards.push(
      renderFunnelCard({
        title: c.title,
        subtitle: c.description || `→ ${c.destination}`,
        link: `${origin}/c/${c.slug}`,
        archiveId: c.id,
        steps: byCampaign.get(c.slug) ?? emptyFunnel(),
      }),
    );
  }

  // Orphan buckets — funnel data for slugs no longer in the active list
  // (archived/deleted campaigns). Read-only, so historical numbers
  // aren't silently dropped.
  for (const f of funnels) {
    if (known.has(f.campaign)) continue;
    if (!SLUG_RE.test(f.campaign)) continue; // defence-in-depth: ignore malformed slugs
    cards.push(
      renderFunnelCard({
        title: f.campaign,
        subtitle: "Archived or deleted campaign",
        steps: f.steps,
      }),
    );
  }

  return `
      <div class="glass-card p-6 sm:p-10 space-y-8">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("bar_chart_3", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Conversion Funnel</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Every session flows through the funnel — Landing → /chat → number generated → channel opened → extend started → extended. The step with the steepest drop-off is flagged <span class="text-amber-400 font-bold uppercase">friction</span>. Counts are per-session over the selected range; aggregate only, no user data. <span class="text-slate-400">Activation</span> = reached an open channel; <span class="text-slate-400">paid</span> = extended a number (both relative to landings).
        </p>

        <!-- Platform-wide funnel (link-independent) -->
        ${overallCard}

        <!-- Create a campaign -->
        <div class="flex items-center gap-3 text-slate-300 pt-2">
          ${iconSvg("sparkles", "size-4 text-primary")}
          <h5 class="text-[10px] font-black uppercase tracking-[0.4em]">Campaign tracking links</h5>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Create a campaign to get a shareable tracking link (<span class="font-mono text-slate-400">${escapeAttr(origin)}/c/&lt;slug&gt;</span>) and attribute its visitors to their own funnel below.
        </p>
        <form method="post" action="/api/admin/campaigns" class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div class="space-y-2 sm:col-span-2">
            <label class="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500" for="c-title">Campaign title</label>
            <input id="c-title" name="title" required maxlength="120" placeholder="e.g. Instagram launch push" class="glass-input w-full" />
          </div>
          <div class="space-y-2 sm:col-span-2">
            <label class="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500" for="c-desc">Description</label>
            <input id="c-desc" name="description" maxlength="500" placeholder="Optional — for your own reference" class="glass-input w-full" />
          </div>
          <div class="space-y-2">
            <label class="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500" for="c-dest">Destination path</label>
            <input id="c-dest" name="destination" value="/" maxlength="256" placeholder="/" class="glass-input w-full font-mono" />
          </div>
          <div class="flex items-end">
            <button type="submit" class="btn-primary py-4 px-10 text-sm w-full sm:w-auto flex items-center justify-center gap-2">
              ${iconSvg("sparkles", "size-5")} Create campaign
            </button>
          </div>
        </form>

        <div class="flex items-center gap-3 text-slate-300 pt-2">
          ${iconSvg("list", "size-4 text-primary")}
          <h5 class="text-[10px] font-black uppercase tracking-[0.4em]">Funnel by source</h5>
        </div>
        <div class="space-y-6">
          ${cards.join("")}
        </div>
      </div>`;
}

/** Renders one campaign's funnel as a horizontal row of step cells with
 *  step-to-step conversion arrows; flags the steepest drop as friction. */
function renderFunnelCard(opts: {
  title: string;
  subtitle: string;
  steps: Record<string, number>;
  link?: string;
  archiveId?: string;
  highlight?: boolean;
}): string {
  const counts = FUNNEL_STEPS.map((s) => opts.steps[s] ?? 0);
  const top = counts[0] ?? 0;

  // Steepest consecutive percentage drop = the friction point.
  let worstIdx = -1;
  let worstDrop = 0;
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1] ?? 0;
    const cur = counts[i] ?? 0;
    if (prev <= 0) continue;
    const drop = (prev - cur) / prev;
    if (drop > worstDrop) {
      worstDrop = drop;
      worstIdx = i;
    }
  }

  const cells: string[] = [];
  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    const step = FUNNEL_STEPS[i] ?? "";
    const count = counts[i] ?? 0;
    const pctTop = top > 0 ? Math.round((count / top) * 100) : 0;
    cells.push(`
            <div class="shrink-0 w-28 text-center space-y-1">
              <div class="text-2xl font-mono font-black text-white">${count}</div>
              <div class="text-[9px] font-black uppercase tracking-widest text-slate-500 leading-tight">${escapeAttr(FUNNEL_LABELS[step] ?? step)}</div>
              <div class="text-[9px] font-mono text-slate-600">${pctTop}% of top</div>
            </div>`);

    if (i < FUNNEL_STEPS.length - 1) {
      const prev = counts[i] ?? 0;
      const next = counts[i + 1] ?? 0;
      const conv = prev > 0 ? Math.round((next / prev) * 100) : 0;
      const friction = i + 1 === worstIdx && worstDrop > 0;
      const tone = friction ? "text-amber-400" : "text-slate-600";
      cells.push(`
            <div class="shrink-0 flex flex-col items-center justify-center px-1 ${tone}">
              <span class="text-lg leading-none">→</span>
              <span class="text-[9px] font-mono mt-0.5">${conv}%</span>
              ${friction ? `<span class="text-[8px] font-black uppercase tracking-wider mt-0.5">friction</span>` : ""}
            </div>`);
    }
  }

  const linkRow = opts.link
    ? `<div class="flex items-center gap-2 text-[11px] font-mono text-primary/80 break-all">
         <svg class="size-3.5 shrink-0" aria-hidden="true"><use href="/icons.svg#arrow_up_right"/></svg>
         <span>${escapeAttr(opts.link)}</span>
       </div>`
    : "";

  const archiveBtn = opts.archiveId
    ? `<form method="post" action="/api/admin/campaigns/${escapeAttr(opts.archiveId)}/archive">
         <button type="submit" class="btn-ghost py-1.5 px-3 text-[10px] uppercase tracking-widest text-slate-500 hover:text-red-400" title="Archive campaign">Archive</button>
       </form>`
    : "";

  const shell = opts.highlight
    ? "rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:p-6 space-y-4"
    : "rounded-2xl border border-white/5 bg-slate-950/40 p-5 sm:p-6 space-y-4";

  return `
        <div class="${shell}">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1 min-w-0">
              <div class="text-sm font-bold ${opts.highlight ? "text-primary" : "text-white"} truncate">${escapeAttr(opts.title)}</div>
              <div class="text-[11px] text-slate-500 truncate">${escapeAttr(opts.subtitle)}</div>
              ${linkRow}
            </div>
            ${archiveBtn}
          </div>
          <div class="overflow-x-auto">
            <div class="flex items-stretch gap-1 min-w-max py-1">
              ${cells.join("")}
            </div>
          </div>
        </div>`;
}

// ---------------------------------------------------------------------------
// Paystack webhook
// ---------------------------------------------------------------------------
//
// Security:
//   - Verifies the x-paystack-signature HMAC-SHA512 header against the
//     raw request body. No trust of parsed JSON is made before the
//     signature passes.
//   - Double-verifies the transaction via Paystack's /transaction/verify
//     endpoint. Belt and braces — a leaked HMAC secret alone isn't
//     enough to mark a token paid, since the attacker would also have
//     to craft a real transaction on Paystack's side.
//   - Returns 200 for all non-signature failures so the response body
//     doesn't leak which references exist. Bad signature is 401.
//
// Privacy:
//   - Logs carry NO token_hash material (not even a prefix). Request-id
//     metadata is enough to trace a specific webhook through logs
//     without naming the token. Mirrors v1.

async function handlePaystackWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  console.log("Paystack Webhook received");
  if (env.MONETIZATION_ENABLED !== "true") {
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (!env.PAYSTACK_SECRET_KEY) {
    return jsonResponse({ error: "not_configured" }, 503);
  }

  const signature = request.headers.get("x-paystack-signature") ?? "";
  // Read the body as text, NOT JSON — HMAC is over the raw bytes, and
  // re-serialising from a parsed object would change whitespace and
  // break the signature check.
  const rawBody = await request.text();

  const expected = await hmacSha512Hex(env.PAYSTACK_SECRET_KEY, rawBody);
  if (!timingSafeHexEqual(signature.toLowerCase(), expected)) {
    console.error(
      `Paystack webhook signature mismatch. Header: ${signature.slice(0, 8)}..., Expected: ${expected.slice(0, 8)}...`,
    );
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  // From here on, the body is trusted. Parse and dispatch.
  type WebhookPayload = {
    event?: string;
    data?: { reference?: string };
  };
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    // Signed but unparseable — swallow with 200 so operators can't
    // probe for signature-oracle behaviour.
    return jsonResponse({ status: "ok" });
  }

  if (payload.event !== "charge.success") {
    return jsonResponse({ status: "ok" });
  }

  const reference = typeof payload.data?.reference === "string" ? payload.data.reference : "";
  if (!reference) {
    return jsonResponse({ status: "ok" });
  }

  // Double-verify with Paystack's own API. If verification fails,
  // check if we even know this reference.
  const verified = await verifyTransaction(reference, env);
  if (!verified) {
    const token = await findByTokenHash(env.DB, reference);
    if (!token) {
      // Good signature + unknown reference → 200 silent-swallow.
      // This ensures we do not leak which references exist in our DB.
      return jsonResponse({ status: "ok" });
    }
    // Verification failed for a KNOWN reference — likely a race or transient issue.
    // Return 503 so Paystack retries the webhook until it succeeds.
    console.error(`Paystack transaction verification failed for known reference: ${reference}`);
    return jsonResponse({ status: "error", message: "verification_failed" }, 503);
  }

  try {
    // Fetch the token first so payment_paid can carry the price point.
    const token = await findByTokenHash(env.DB, reference);
    const changed = await markPaid(env.DB, reference, reference);
    // Only count a real pending→paid transition, so Paystack's webhook
    // retries don't inflate the funnel. Global (no country): the webhook
    // request originates from Paystack's servers, not the user.
    if (changed > 0 && token) {
      enqueueMetric(
        env.METRICS_QUEUE,
        "payment_paid",
        { dim: priceLabel(token.currency, token.amount_cents) },
        ctx,
      );
    }
  } catch {
    // Even a DB failure returns 200 — Paystack retries on non-2xx,
    // so we'd rather absorb a transient blip and let the client
    // re-redeem on return. Alternative (return 500) risks a loop
    // of retries against a durable failure.
  }
  return jsonResponse({ status: "ok" });
}

async function handlePaymentInitiate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (env.MONETIZATION_ENABLED !== "true") {
    return jsonResponse({ error: "monetization_disabled" }, 503);
  }

  let body: { token_hash?: unknown };
  try {
    body = (await request.json()) as { token_hash?: unknown };
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const tokenHash = typeof body.token_hash === "string" ? body.token_hash : "";
  if (!TOKEN_HASH_RE.test(tokenHash)) {
    return jsonResponse({ error: "invalid_token_hash" }, 400);
  }

  // Compute expiry: 30 days (matching v1's Monetization.create_token/1).
  // Tokens swept by the daily cron if abandoned before this deadline.
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const amountCents = parseInt(env.PRICE_CENTS, 10) || 200;
  const currency = env.PAYMENT_CURRENCY || "USD";

  try {
    await createPending(env.DB, {
      tokenHash,
      amountCents,
      currency,
      expiresAt,
    });
  } catch {
    return jsonResponse({ error: "create_token_failed" }, 500);
  }

  // Hand off to the Paystack adapter for the actual checkout URL.
  // The token_hash IS the transaction reference — when the user
  // completes payment, Paystack webhooks us with this same hash,
  // and we mark the row paid. No room_hash is ever sent to Paystack.
  const initResult = await paystackInitialize(tokenHash, amountCents, env);
  if (initResult.ok) {
    // Top of the server-side payment funnel. cf country is the user's here
    // (they call this from their browser, unlike the webhook).
    enqueueMetric(
      env.METRICS_QUEUE,
      "payment_initiated",
      { dim: priceLabel(currency, amountCents), cfCountry: (request.cf?.country ?? "") as string },
      ctx,
    );
    return jsonResponse({ checkout_url: initResult.checkoutUrl });
  }

  // Paystack init failed — delete the pending token we just created so it
  // doesn't sit as an orphan in D1 for 30 days until the daily sweep.
  void deleteToken(env.DB, tokenHash);

  // Map adapter error codes to client-visible codes. The client's
  // paymentErrorCopy() only knows about a few well-known ones.
  const errorCode =
    initResult.reason === "missing_config"
      ? "paystack_not_configured"
      : initResult.reason === "provider_unavailable"
        ? "provider_unavailable"
        : "provider_error";
  const status = initResult.reason === "missing_config" ? 501 : 502;
  return jsonResponse({ error: errorCode, detail: initResult.reason }, status);
}

// ---------------------------------------------------------------------------
// Campaign conversion-funnel tracking
// ---------------------------------------------------------------------------

function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location, "cache-control": "no-store" },
  });
}

/** GET /c/:slug — records a landing event and redirects into the funnel. */
async function handleCampaignLink(
  slug: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Bad slug or unknown/archived campaign → silent redirect home; we
  // never reveal which slugs exist, and never count a phantom landing.
  if (!SLUG_RE.test(slug)) return redirect("/");
  const campaign = await getCampaignBySlug(env.DB, slug).catch(() => null);
  if (!campaign) return redirect("/");

  const cfCountry = (request.cf?.country ?? "") as string;
  enqueueMetric(env.METRICS_QUEUE, "funnel_landing", { cfCountry, dim: slug }, ctx);

  // Re-normalise on read as well as write — belt-and-braces against an
  // unsafe destination ever reaching the Location header (open-redirect
  // guard). Carry the slug forward so the layout bootstrap can persist
  // it for the downstream funnel steps.
  const destination = normaliseDestination(campaign.destination);
  const sep = destination.includes("?") ? "&" : "?";
  return redirect(`${destination}${sep}c=${slug}`);
}

/** POST /api/funnel — client beacon for a single funnel step. */
async function handleFunnelBeacon(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Tolerant parse: sendBeacon ships text/plain, fetch ships JSON.
  let body: { step?: unknown; campaign?: unknown };
  try {
    body = JSON.parse(await request.text()) as { step?: unknown; campaign?: unknown };
  } catch {
    return new Response(null, { status: 400 });
  }

  if (!isFunnelStep(body.step)) {
    return new Response(null, { status: 400 });
  }
  // campaign: a valid slug, or "direct"/empty for organic traffic.
  const raw = typeof body.campaign === "string" ? body.campaign : "";
  const campaign = raw && SLUG_RE.test(raw) ? raw : "direct";

  const cfCountry = (request.cf?.country ?? "") as string;
  enqueueMetric(env.METRICS_QUEUE, `funnel_${body.step}`, { cfCountry, dim: campaign }, ctx);
  return new Response(null, { status: 204 });
}

/** POST /api/admin/campaigns — Basic-Auth create from the dashboard form. */
async function handleCampaignCreate(request: Request, env: Env): Promise<Response> {
  if (!checkBasicAuth(request, env)) return basicAuthChallenge();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect("/admin", 303);
  }
  const title = String(form.get("title") ?? "").trim();
  if (!title) return redirect("/admin", 303);

  try {
    await createCampaign(env.DB, {
      title,
      description: String(form.get("description") ?? ""),
      destination: String(form.get("destination") ?? "/"),
    });
  } catch {
    // Swallow — the dashboard re-renders the current state on redirect.
  }
  return redirect("/admin", 303);
}

/** POST /api/admin/campaigns/:id/archive — Basic-Auth soft-delete. */
async function handleCampaignArchive(id: string, request: Request, env: Env): Promise<Response> {
  if (!checkBasicAuth(request, env)) return basicAuthChallenge();
  await archiveCampaign(env.DB, id).catch(() => 0);
  return redirect("/admin", 303);
}
