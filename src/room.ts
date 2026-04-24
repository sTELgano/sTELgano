// SPDX-License-Identifier: AGPL-3.0-only
//
// RoomDO — Durable Object for a single sTELgano room.
//
// One instance per room_hash. Single-threaded execution enforces the N=1
// invariant by construction (replaces the v1 Postgres UNIQUE index on
// messages.room_id + delete-then-insert transaction in
// lib/stelgano/rooms.ex:send_message/4).
//
// Phase 1: skeleton only. Subsequent phases add:
//   - WebSocket join/send/read/edit/delete/typing/expire handlers
//   - Access-hash + lockout state
//   - DO Storage persistence (currentMessage, ttlExpiresAt, lockout)
//   - DO Alarm for TTL expiry
//   - Hibernatable WebSocket attachment
//
// See lib/stelgano_web/channels/anon_room_channel.ex for the v1 reference
// behaviour we are porting.

import type { Env } from "./index.ts";

export class RoomDO {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade — accept and hibernate. Phase 1 only opens the
    // connection; message handling lands in Phase 2.
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(`room stub: ${url.pathname}`, { status: 200 });
  }

  // Hibernatable WebSocket handlers — runtime calls these on incoming
  // frames even after the DO has hibernated. Phase 2 wires real protocol
  // events here (send_message, read_receipt, etc.).
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    void ws;
    void message;
    // no-op in Phase 1
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    void ws;
    void reason;
    void wasClean;
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  // Alarm handler — runs at ttlExpiresAt. Phase 2 adds the self-destruct
  // logic (delete state, broadcast :expire_room, close sockets).
  async alarm(): Promise<void> {
    // no-op in Phase 1
  }
}
