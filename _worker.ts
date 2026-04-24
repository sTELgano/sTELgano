// SPDX-License-Identifier: AGPL-3.0-only
//
// Cloudflare Pages — Advanced Mode entry.
//
// Why Advanced Mode and not file-based functions/:
//
// We initially used functions/_middleware.ts + functions/room/[roomHash]/ws.ts
// (Pages' file-based routing). The DO class (RoomDO) was re-exported from
// the middleware so the [[durable_objects.bindings]] in wrangler.toml could
// resolve `class_name = "RoomDO"`. That path failed: Pages' bundler does
// not reliably hoist named exports from individual function files to the
// bundled `functionsWorker` entry, and `wrangler pages dev` died with
//   "Your Worker depends on the following Durable Objects, which are not
//    exported in your entrypoint file: RoomDO."
//
// Advanced Mode collapses everything into this single file: DO export +
// fetch handler + asset fallthrough live together, so the bundler can't
// lose the export. Trade-off is the loss of file-based routing — fine
// for our small route surface (~10 routes total). Pages still serves
// public/ as static assets via env.ASSETS; only dynamic dispatch
// changes.
//
// docs/MIGRATION.md captures this decision under "Why Pages and not
// Workers + Assets" → revised after the empirical failure of file-based
// routing with DOs.

import type { Env } from "./src/env";
import { createPending } from "./src/lib/extension_tokens";
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

    // Static assets fallthrough — Pages' ASSETS binding handles 404s
    // for missing files automatically (single-page-application mode is
    // off, so a missing /foo gets a normal 404 page rather than
    // index.html).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

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

  // Phase 7 wires the actual Paystack initialize call here:
  //   const checkoutUrl = await Paystack.initialize(tokenHash, env);
  //   return jsonResponse({ checkout_url: checkoutUrl });
  return jsonResponse(
    {
      error: "paystack_not_configured",
      detail:
        "The Paystack adapter ports in Phase 7. Token row was created in D1, but no checkout URL is available.",
    },
    501,
  );
}
