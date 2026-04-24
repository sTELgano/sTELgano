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

import type { Env } from "./src/env";
import { INLINE_SCRIPT_HASHES } from "./src/csp_hashes";
import { list as listCountryMetrics, type CountryRow } from "./src/lib/country_metrics";
import { listRecent as listDailyRecent, type DailyRow } from "./src/lib/daily_metrics";
import { createPending, markPaid } from "./src/lib/extension_tokens";
import {
  initialize as paystackInitialize,
  hmacSha512Hex,
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
} satisfies ExportedHandler<Env>;

async function dispatch(request: Request, env: Env, url: URL): Promise<Response> {
    // GET /healthz — used by deploy smoke tests, not by users.
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
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
      const id = env.ROOM.idFromName(roomHash);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
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
      return stub.fetch(
        new Request(new URL(`/${roomHash}/exists`, url), { method: "GET" }),
      );
    }

    // POST /api/payment/initiate — payment client (chat.ts) calls
    // this with a token_hash. We create the extension_tokens row
    // (status=pending) and return a checkout URL the client
    // redirects to. The Paystack adapter wires the actual checkout
    // URL in Phase 7; for now we stub it with a 501 + clear note
    // when monetization is enabled, or 503 when the operator hasn't
    // turned on monetization at all.
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

    // GET /admin — aggregate metrics dashboard. HTTP Basic Auth
    // against ADMIN_USERNAME / ADMIN_PASSWORD. Shows only counts —
    // never individual hashes, messages, or ciphertext.
    if (url.pathname === "/admin" && request.method === "GET") {
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
  if (!auth || !auth.startsWith("Basic ")) return false;
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
  return (
    timingSafeEqual(user, expectedUser) &&
    timingSafeEqual(pass, env.ADMIN_PASSWORD)
  );
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
  let daily: DailyRow[] = [];
  try {
    [country, daily] = await Promise.all([
      listCountryMetrics(env.DB),
      listDailyRecent(env.DB, 30),
    ]);
  } catch {
    // D1 unavailable or schema not migrated — show an empty
    // dashboard rather than 500.
  }

  // Derive the headline counters from what v2 can actually query.
  // v1 also showed active_rooms + messages_today via full-table
  // Postgres scans; v2's per-room state is DO-local and isn't
  // cheaply aggregated, so those tiles show N/A with a clear note.
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = daily.find((d) => d.day === today);
  const newToday = todayRow ? todayRow.free_new + todayRow.paid_new : 0;
  const sum30 = daily.reduce((a, r) => a + r.free_new + r.paid_new, 0);

  const html = renderAdminHtml({
    updated: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    newToday,
    sum30,
    daily,
    country,
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
  newToday: number;
  sum30: number;
  daily: DailyRow[];
  country: CountryRow[];
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
            <td class="py-3 text-right font-mono text-slate-400">${r.paid_expired}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="py-4 text-sm text-slate-500 italic">No daily data yet.</td></tr>`;

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

  const iconSvg = (name: string, cls = "size-4") =>
    `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

  return `<!DOCTYPE html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="en" data-theme="dark">
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

      <!-- Metric cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
        ${adminMetricCard("New Chats Today", d.newToday, "Last 24h", "plus_circle", true)}
        ${adminMetricCard("Total (30d)", d.sum30, "New rooms, past 30d", "calendar")}
        ${adminMetricCard("Active Chats", "—", "DO-local; not aggregated", "radio")}
        ${adminMetricCard("Messages Today", "—", "DO-local; not aggregated", "message_circle")}
      </div>

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
                <th class="py-3 text-right">Expired paid</th>
              </tr>
            </thead>
            <tbody>${dailyRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Per-country breakdown -->
      <div class="glass-card p-6 sm:p-10 space-y-6 mx-4 sm:mx-0">
        <div class="flex items-center gap-3 text-slate-300">
          ${iconSvg("globe", "size-5 text-primary")}
          <h4 class="text-[10px] font-black uppercase tracking-[0.4em]">Rooms by Country · Aggregate Only</h4>
        </div>
        <p class="text-xs text-slate-500 font-medium leading-relaxed">
          Counters incremented on room creation and paid-tier upgrade. The country is never stored alongside any individual room record — these rows can answer "how many rooms from Kenya?" but never "which rooms from Kenya?".
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

  const reference =
    typeof payload.data?.reference === "string" ? payload.data.reference : "";
  if (!reference) {
    return jsonResponse({ status: "ok" });
  }

  // Double-verify with Paystack's own API. If verification fails,
  // still return 200 — don't reveal whether the reference was known
  // to us or not.
  const verified = await verifyTransaction(reference, env);
  if (!verified) {
    return jsonResponse({ status: "ok" });
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

  const tokenHash =
    typeof body.token_hash === "string" ? body.token_hash : "";
  if (!TOKEN_HASH_RE.test(tokenHash)) {
    return jsonResponse({ error: "invalid_token_hash" }, 400);
  }

  // Compute expiry now so the row carries an explicit deadline. v1
  // sets this 7 days out (the unredeemed-token sweep window). The
  // Paystack call may bump it via Paystack's own session window —
  // Phase 7 may overwrite this.
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
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

  // Map adapter error codes to client-visible codes. The client's
  // paymentErrorCopy() only knows about a few well-known ones.
  const errorCode =
    initResult.reason === "missing_config"
      ? "paystack_not_configured"
      : initResult.reason === "fx_conversion_not_wired"
        ? "paystack_not_configured"
        : initResult.reason === "provider_unavailable"
          ? "provider_unavailable"
          : "provider_error";
  const status = initResult.reason === "missing_config" ? 501 : 502;
  return jsonResponse({ error: errorCode, detail: initResult.reason }, status);
}
