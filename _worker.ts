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
export { RoomDO } from "./src/room";

const ROOM_HASH_RE = /^[a-f0-9]{64}$/;

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

    // Static assets fallthrough — Pages' ASSETS binding handles 404s
    // for missing files automatically (single-page-application mode is
    // off, so a missing /foo gets a normal 404 page rather than
    // index.html).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
