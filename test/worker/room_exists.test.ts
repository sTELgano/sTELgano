// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /api/room/:hash/exists — the client probes this before full
// WebSocket join so it can route first-time numbers through
// new_channel (tier selection) vs. straight into connect. The DO
// replies `{ exists: boolean }` based on whether it's ever been
// initialised. No auth — the room_hash already encodes the phone +
// ROOM_SALT, so knowing one means knowing the other.

// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const FRESH_HASH = "a".repeat(64);
const ANOTHER_HASH = "b".repeat(64);

describe("GET /api/room/:hash/exists", () => {
  it("rejects a non-hex room hash with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/room/not-a-hash/exists");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_room_hash");
  });

  it("rejects an uppercase hex hash (must be lowercase) with 400", async () => {
    const res = await SELF.fetch(`https://example.com/api/room/${"A".repeat(64)}/exists`);
    expect(res.status).toBe(400);
  });

  it("returns exists=false for a never-initialised room", async () => {
    const res = await SELF.fetch(`https://example.com/api/room/${FRESH_HASH}/exists`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(false);
  });

  it("keeps probe isolated per room hash", async () => {
    // Hitting one room's probe must not mark a *different* room as
    // initialised. Each DO is addressed by idFromName(roomHash).
    const a = await SELF.fetch(`https://example.com/api/room/${FRESH_HASH}/exists`);
    const b = await SELF.fetch(`https://example.com/api/room/${ANOTHER_HASH}/exists`);
    expect(((await a.json()) as { exists: boolean }).exists).toBe(false);
    expect(((await b.json()) as { exists: boolean }).exists).toBe(false);
  });
});
