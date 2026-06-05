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
  type CampaignFunnel,
  type CFCountryRow,
  type CountryRow,
  checkAeAccess,
  type DailyRow,
  type DiasporaRow,
  FUNNEL_STEPS,
  isFunnelStep,
  queryCFCountryMetrics,
  queryCountryMetrics,
  queryDailyMetrics,
  queryDiasporaMetrics,
  queryFunnelMetrics,
  sumFunnels,
  writeFunnelEvent,
} from "./src/lib/analytics";
import {
  archiveCampaign,
  type Campaign,
  createCampaign,
  getCampaignBySlug,
  listCampaigns,
  normaliseDestination,
  SLUG_RE,
} from "./src/lib/campaigns";
import {
  createPending,
  deleteExpired,
  deleteToken,
  findByTokenHash,
  markPaid,
} from "./src/lib/extension_tokens";
import { getActiveRooms } from "./src/lib/live_counters";
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // WebSocket upgrade responses MUST NOT be mangled with extra
    // headers — Cloudflare's proxy rejects 101 responses that
    // carry non-upgrade headers. So we short-circuit the
    // security-header wrapper for the room WS path before routing.
    if (request.headers.get("upgrade") === "websocket") {
      return dispatch(request, env, url);
    }
    const response = await dispatch(request, env, url);
    return applySecurityHeaders(response, url.pathname);
  },

  // Cron handler — fires daily at 03:00 UTC via [triggers] in wrangler.toml.
  // Sweeps extension_tokens past their expires_at.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cutoff = new Date().toISOString();
    await deleteExpired(env.DB, cutoff);
  },
} satisfies ExportedHandler<Env>;

async function dispatch(request: Request, env: Env, url: URL): Promise<Response> {
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
    return handleCampaignLink(trackMatch[1] ?? "", request, env);
  }

  // POST /api/funnel — lightweight, unauthenticated funnel beacon fired
  // by the client (navigator.sendBeacon) at each conversion step. Body
  // is { step, campaign }. The server adds CF-IPCountry and writes one
  // Analytics Engine data point. No stored state, no user data.
  if (url.pathname === "/api/funnel" && request.method === "POST") {
    return handleFunnelBeacon(request, env);
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
    return handlePaymentInitiate(request, env);
  }

  // POST /api/webhooks/paystack — Paystack hits this after a
  // successful charge. HMAC-SHA512 verifies the payload, then
  // we double-verify with Paystack's /transaction/verify, then
  // markPaid in D1. Returns 200 for all non-signature failures
  // so the response doesn't leak which references exist.
  if (url.pathname === "/api/webhooks/paystack" && request.method === "POST") {
    return handlePaystackWebhook(request, env);
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

async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
  if (!checkBasicAuth(request, env)) return basicAuthChallenge();

  let country: CountryRow[] = [];
  let cfCountry: CFCountryRow[] = [];
  let daily: DailyRow[] = [];
  let diaspora: DiasporaRow[] = [];
  let funnels: CampaignFunnel[] = [];
  let campaigns: Campaign[] = [];
  let activeRooms = 0;
  let aeError: string | null = null;
  const aeReady = Boolean(env.CF_ACCOUNT_ID && env.CF_AE_API_TOKEN);
  const aeDataset = env.CF_AE_DATASET;
  try {
    [country, cfCountry, daily, diaspora, funnels, campaigns, activeRooms] = await Promise.all([
      aeReady
        ? queryCountryMetrics(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, aeDataset)
        : Promise.resolve([] as CountryRow[]),
      aeReady
        ? queryCFCountryMetrics(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, aeDataset)
        : Promise.resolve([] as CFCountryRow[]),
      aeReady
        ? queryDailyMetrics(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, 30, aeDataset)
        : Promise.resolve([] as DailyRow[]),
      aeReady
        ? queryDiasporaMetrics(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, aeDataset)
        : Promise.resolve([] as DiasporaRow[]),
      aeReady
        ? queryFunnelMetrics(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, aeDataset)
        : Promise.resolve([] as CampaignFunnel[]),
      listCampaigns(env.DB).catch(() => [] as Campaign[]),
      getActiveRooms(env.DB),
    ]);
  } catch {
    // AE unavailable — show an empty dashboard rather than 500.
  }

  // Run a cheap validation query to surface token/permission errors distinctly
  // from "no data yet". Only runs when aeReady and no data came back.
  if (aeReady && daily.length === 0 && country.length === 0) {
    aeError = await checkAeAccess(env.CF_ACCOUNT_ID!, env.CF_AE_API_TOKEN!, aeDataset).catch(
      () => "AE check failed",
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = daily.find((d) => d.day === today);
  const newToday = todayRow ? todayRow.free_new + todayRow.paid_new : 0;
  const sum90 = daily.reduce((a, r) => a + r.free_new + r.paid_new, 0);
  const messagesThisDay = todayRow?.messages_sent ?? 0;
  // Per-day table shows last 30 days for readability.
  const dailyTable = daily.slice(0, 30);

  const html = renderAdminHtml({
    updated: `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    origin: new URL(request.url).origin,
    aeReady,
    aeError,
    newToday,
    sum90,
    activeRooms,
    messagesThisDay,
    daily: dailyTable,
    country,
    cfCountry,
    diaspora,
    campaigns,
    funnels,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderAdminHtml(d: {
  updated: string;
  origin: string;
  aeReady: boolean;
  aeError: string | null;
  newToday: number;
  sum90: number;
  activeRooms: number;
  messagesThisDay: number;
  daily: DailyRow[];
  country: CountryRow[];
  cfCountry: CFCountryRow[];
  diaspora: DiasporaRow[];
  campaigns: Campaign[];
  funnels: CampaignFunnel[];
}): string {
  const dailyRows = d.daily.length
    ? d.daily
        .map(
          (r) => `
          <tr class="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
            <td class="py-3 pr-8 font-mono text-white">${escapeAttr(r.day)}</td>
            <td class="py-3 pr-8 text-right font-mono text-slate-300">${r.free_new}</td>
            <td class="py-3 pr-8 text-right font-mono text-primary">${r.paid_new}</td>
            <td class="py-3 pr-8 text-right font-mono text-slate-400">${r.free_expired}</td>
            <td class="py-3 pr-8 text-right font-mono text-slate-400">${r.paid_expired}</td>
            <td class="py-3 text-right font-mono text-slate-300">${r.messages_sent ?? 0}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="py-4 text-sm text-slate-500 italic">No daily data yet.</td></tr>`;

  const countryRows = d.country.length
    ? d.country
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
    : `<tr><td colspan="4" class="py-4 text-sm text-slate-500 italic">No country data yet.</td></tr>`;

  const cfCountryRows = d.cfCountry.length
    ? d.cfCountry
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
    : `<tr><td colspan="4" class="py-4 text-sm text-slate-500 italic">No IP-country data yet.</td></tr>`;

  const diasporaRows = d.diaspora.length
    ? d.diaspora
        .map((r) => {
          const isDiaspora = r.steg_country !== r.cf_country;
          const indicator = isDiaspora
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
    : `<tr><td colspan="5" class="py-4 text-sm text-slate-500 italic">No diaspora data yet.</td></tr>`;

  const iconSvg = (name: string, cls = "size-4") =>
    `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

  const campaignsSection = renderCampaignsSection(
    d.campaigns,
    d.funnels,
    d.origin,
    d.aeReady,
    iconSvg,
  );

  return `<!DOCTYPE html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="refresh" content="30">
  <title>Admin — sTELgano</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="antialiased">
  <div class="bg-grid-container">
    <div class="bg-grid"></div>
    <div class="noise-overlay"></div>
  </div>

  <main class="min-h-dvh w-full overflow-y-auto">
    <div class="max-w-4xl mx-auto space-y-12 py-12 animate-in lg:pb-40">
      <!-- Header -->
      <div class="flex flex-col md:flex-row items-center justify-between gap-8 pb-8 border-b border-white/5 px-4">
        <div class="text-center md:text-left space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-[0.3em] mb-2">
            ${iconSvg("terminal", "size-3")} System Status
          </div>
          <h1 class="text-4xl sm:text-6xl font-extrabold text-white font-display tracking-tighter uppercase leading-[0.9] sm:leading-none">
            Admin <span class="text-gradient">Dashboard.</span>
          </h1>
          <p class="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-widest sm:tracking-[0.5em] leading-relaxed">
            Total Stats Only · No Private Data ·
            <span class="text-primary italic">Updated ${escapeAttr(d.updated)}</span>
          </p>
        </div>

        <form method="get" action="/admin">
          <button type="submit" class="w-full sm:w-auto btn-primary py-4 px-10 text-sm flex items-center justify-center gap-3 group">
            ${iconSvg("refresh_cw", "size-5 group-hover:rotate-180 transition-transform duration-700")}
            Refresh Stats
          </button>
        </form>
      </div>

      ${
        d.aeError
          ? `<div class="mx-4 sm:mx-0 flex items-start gap-3 px-5 py-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-sm">
               ${iconSvg("alert_triangle", "size-5 shrink-0 mt-0.5 text-amber-400")}
               <div>
                 <p class="font-semibold">Analytics Engine query error</p>
                 <p class="mt-1 text-amber-400/80 font-mono text-xs break-all">${escapeAttr(d.aeError)}</p>
                 <p class="mt-2 text-amber-400/60 text-xs">Check that CF_AE_API_TOKEN has <strong>Account Analytics: Read</strong> permission and the account ID matches.</p>
               </div>
             </div>`
          : ""
      }

      <!-- Metric cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
        ${adminMetricCard("Active Channels", d.activeRooms, "Live count, pushed by DO", "radio", true)}
        ${adminMetricCard("New Channels Today", d.aeReady ? d.newToday : "—", "Last 24h", "plus_circle")}
        ${adminMetricCard("Messages Today", d.aeReady ? d.messagesThisDay : "—", "Encrypted, current UTC day", "message_circle")}
        ${adminMetricCard("Total (30d)", d.aeReady ? d.sum90 : "—", "New rooms, past 30 days", "calendar")}
      </div>

      <!-- Campaigns + conversion funnel -->
      ${campaignsSection}

      <!-- Per-day breakdown -->
      <div class="glass-card p-6 sm:p-10 space-y-6 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("calendar", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Daily Breakdown · Last 30 Days</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          New free / new paid / expired free / expired paid counters per UTC day, across all countries. Expiries are not country-scoped because individual room records do not carry country metadata (by design).
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Day (UTC)</th>
                <th class="py-3 pr-8 text-right">New free</th>
                <th class="py-3 pr-8 text-right">New paid</th>
                <th class="py-3 pr-8 text-right">Expired free</th>
                <th class="py-3 pr-8 text-right">Expired paid</th>
                <th class="py-3 text-right">Messages</th>
              </tr>
            </thead>
            <tbody>${dailyRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Per-country breakdown (steg-number country) -->
      <div class="glass-card p-6 sm:p-10 space-y-6 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("globe", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Rooms by Steg-Number Country · Aggregate Only</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Country derived client-side from the E.164 steg number via libphonenumber-js. Answers "which country's phone format was adopted?" — a proxy for the user's social identity. Never stored alongside any individual room record.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Country</th>
                <th class="py-3 pr-8 text-right">Free rooms</th>
                <th class="py-3 pr-8 text-right">Paid rooms</th>
                <th class="py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>${countryRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Per-country breakdown (CF-IPCountry) -->
      <div class="glass-card p-6 sm:p-10 space-y-6 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("map_pin", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Rooms by IP Location (CF-IPCountry) · Aggregate Only</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Country derived server-side from the connecting IP via Cloudflare's geolocation. Answers "where are users physically connecting from?" — differs from the steg-number country for diaspora users, travellers, and VPN users.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Country</th>
                <th class="py-3 pr-8 text-right">Free rooms</th>
                <th class="py-3 pr-8 text-right">Paid rooms</th>
                <th class="py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>${cfCountryRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Diaspora breakdown (steg country vs IP country) -->
      <div class="glass-card p-6 sm:p-10 space-y-6 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("users", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Diaspora Breakdown · Steg vs IP Country</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Rows where Steg Country ≠ CF Country (marked <span class="inline-block size-1.5 rounded-full bg-primary mb-0.5"></span>) reveal diaspora usage — users whose steg number is from one country but who connect from another.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 border-b border-white/5">
                <th class="py-3 pr-8">Steg Country</th>
                <th class="py-3 pr-8">CF Country</th>
                <th class="py-3 pr-8 text-right">Free rooms</th>
                <th class="py-3 pr-8 text-right">Paid rooms</th>
                <th class="py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>${diasporaRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Admin notes -->
      <div class="glass-card p-6 sm:p-10 space-y-8 border-white/5 bg-slate-950/40 relative overflow-hidden group mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300 relative z-10">
          ${iconSvg("help_circle", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Admin Information</h4>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6 relative z-10">
          ${[
            "All values are counts derived from server data.",
            "No private chat contents, keys, or IDs are shown.",
            "Active rooms and message counts are DO-local in v2 and not cheaply aggregable. Tiles show —.",
            "Country and daily counters are incremented on room creation / paid upgrade / expiry.",
            "Refreshing the page hits GET /admin again — no client-side polling.",
            "Access gated by ADMIN_USERNAME / ADMIN_PASSWORD env vars on Cloudflare Pages.",
          ]
            .map(
              (note) => `
              <div class="flex items-start gap-4">
                <div class="size-1 rounded-full bg-primary/40 mt-1.5"></div>
                <span class="text-xs text-slate-500 font-medium leading-relaxed">${escapeAttr(note)}</span>
              </div>`,
            )
            .join("")}
        </div>
      </div>
    </div>
  </main>
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
    ? '<div class="size-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_var(--color-primary)]"></div>'
    : "";
  return `
    <div class="glass-card-premium p-6 sm:p-10 space-y-8 group hover:border-primary/50 transition-all duration-500 mx-4 sm:mx-0">
      <div class="flex items-center justify-between">
        <div class="size-12 sm:size-14 rounded-2xl bg-primary/5 flex items-center justify-center border border-primary/20 group-hover:border-primary/40 group-hover:bg-primary/10 transition-all">
          <svg class="size-6 sm:size-7 text-primary/40 group-hover:text-primary transition-colors" aria-hidden="true"><use href="/icons.svg#${icon}"/></svg>
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-slate-600">${escapeAttr(note)}</span>
          ${activeDot}
        </div>
      </div>
      <div class="space-y-3">
        <div class="text-4xl sm:text-6xl font-mono font-black text-white group-hover:scale-110 transition-transform origin-left tracking-tighter">
          ${escapeAttr(String(value))}
        </div>
        <div class="text-[10px] sm:text-[11px] font-black uppercase tracking-[0.3em] sm:tracking-[0.4em] text-slate-500 group-hover:text-slate-400 transition-colors">
          ${escapeAttr(label)}
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
  aeReady: boolean,
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

  const aeNote = aeReady
    ? ""
    : `<p class="text-xs text-amber-400/80 font-medium">Analytics Engine is not configured — funnel counts read 0. Campaigns can still be created and their tracking links shared.</p>`;

  return `
      <div class="glass-card p-6 sm:p-10 space-y-8 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("bar_chart_3", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Conversion Funnel</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Every session flows through the funnel — Landing → /chat → number generated → channel opened → extend started → extended. The step with the steepest drop-off is flagged <span class="text-amber-400 font-bold uppercase">friction</span>. Counts are per-session over the last 30 days; aggregate only, no user data. <span class="text-slate-400">Activation</span> = reached an open channel; <span class="text-slate-400">paid</span> = extended a number (both relative to landings).
        </p>
        ${aeNote}

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

async function handlePaystackWebhook(request: Request, env: Env): Promise<Response> {
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
    await markPaid(env.DB, reference, reference);
  } catch {
    // Even a DB failure returns 200 — Paystack retries on non-2xx,
    // so we'd rather absorb a transient blip and let the client
    // re-redeem on return. Alternative (return 500) risks a loop
    // of retries against a durable failure.
  }
  return jsonResponse({ status: "ok" });
}

async function handlePaymentInitiate(request: Request, env: Env): Promise<Response> {
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
async function handleCampaignLink(slug: string, request: Request, env: Env): Promise<Response> {
  // Bad slug or unknown/archived campaign → silent redirect home; we
  // never reveal which slugs exist, and never count a phantom landing.
  if (!SLUG_RE.test(slug)) return redirect("/");
  const campaign = await getCampaignBySlug(env.DB, slug).catch(() => null);
  if (!campaign) return redirect("/");

  const cfCountry = (request.cf?.country ?? "") as string;
  writeFunnelEvent(env.ANALYTICS, "landing", slug, cfCountry);

  // Re-normalise on read as well as write — belt-and-braces against an
  // unsafe destination ever reaching the Location header (open-redirect
  // guard). Carry the slug forward so the layout bootstrap can persist
  // it for the downstream funnel steps.
  const destination = normaliseDestination(campaign.destination);
  const sep = destination.includes("?") ? "&" : "?";
  return redirect(`${destination}${sep}c=${slug}`);
}

/** POST /api/funnel — client beacon for a single funnel step. */
async function handleFunnelBeacon(request: Request, env: Env): Promise<Response> {
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
  writeFunnelEvent(env.ANALYTICS, body.step, campaign, cfCountry);
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
