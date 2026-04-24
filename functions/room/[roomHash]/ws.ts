// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /room/:roomHash/ws — WebSocket upgrade endpoint. Validates the
// room_hash format and forwards the upgrade request to the room's
// Durable Object.
//
// Re-exports RoomDO so the Pages bundler discovers it and the
// [[durable_objects.bindings]] entry in wrangler.toml can resolve
// `class_name = "RoomDO"`. Without this re-export the Pages build
// would tree-shake the DO class out of the bundle even though it's
// referenced by binding configuration.

import type { Env } from "../../../src/env";
export { RoomDO } from "../../../src/room";

const ROOM_HASH_RE = /^[a-f0-9]{64}$/;

export const onRequestGet: PagesFunction<Env, "roomHash"> = async (context) => {
  const { params, env, request } = context;
  const roomHash = typeof params.roomHash === "string" ? params.roomHash : "";

  if (!ROOM_HASH_RE.test(roomHash)) {
    return new Response("invalid room hash", { status: 400 });
  }

  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  const id = env.ROOM.idFromName(roomHash);
  const stub = env.ROOM.get(id);
  return stub.fetch(request);
};
