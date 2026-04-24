// SPDX-License-Identifier: AGPL-3.0-only
//
// sTELgano v2 — Worker entry point.
//
// Routes are split between three handlers:
//   - Static assets and the chat shell: served by the [assets] binding
//     (configured in wrangler.toml). The Worker only sees requests that
//     don't match a static file.
//   - HTTP routes: routed through Hono. Includes /admin, /payment/*, and
//     /api/webhooks/*. All other routes fall through to ASSETS.
//   - WebSocket upgrades to /room/:room_hash/ws: forwarded to the room's
//     Durable Object. The DO holds the per-room state and the open
//     channel sockets.
//
// Phase 1 ships only the skeleton — health check + DO stub + asset
// fallthrough. Subsequent phases fill in the routes referenced below.

import { Hono } from "hono";

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  PHX_HOST: string;
  PAYMENT_CURRENCY: string;
  PRICE_CENTS: string;
  FREE_TTL_DAYS: string;
  PAID_TTL_DAYS: string;
  MONETIZATION_ENABLED: string;
  // Secrets (set via `wrangler secret put`):
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_CALLBACK_URL?: string;
  PAYSTACK_RECEIPT_EMAIL_DOMAIN?: string;
  PAYSTACK_SETTLEMENT_CURRENCY?: string;
  PAYSTACK_FX_BUFFER_PCT?: string;
  PAYMENT_FX_FALLBACK_RATE?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Health check — used by deploy smoke tests, not by users.
app.get("/healthz", (c) => c.text("ok"));

// WebSocket upgrade — routed to the per-room Durable Object.
// The room_hash is validated as 64-char lowercase hex (the SHA-256 of the
// normalised phone + ROOM_SALT, exactly as in v1's anon_socket.ex).
const ROOM_HASH_RE = /^[a-f0-9]{64}$/;

app.get("/room/:roomHash/ws", async (c) => {
  const roomHash = c.req.param("roomHash");
  if (!ROOM_HASH_RE.test(roomHash)) {
    return c.text("invalid room hash", 400);
  }

  const upgrade = c.req.header("upgrade");
  if (upgrade !== "websocket") {
    return c.text("expected websocket upgrade", 426);
  }

  const id = c.env.ROOM.idFromName(roomHash);
  const stub = c.env.ROOM.get(id);
  return stub.fetch(c.req.raw);
});

// Everything else falls through to the static assets binding (chat shell,
// public pages, fonts, bundled JS/CSS). Workers Assets handles 404s for
// missing files via the [assets].not_found_handling setting.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Re-export the Durable Object class so the Workers runtime can find it.
export { RoomDO } from "./room.ts";

export default app;
