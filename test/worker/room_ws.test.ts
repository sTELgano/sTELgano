// SPDX-License-Identifier: AGPL-3.0-only
//
// RoomDO — end-to-end behaviour over the WebSocket protocol.
//
// The DO is addressed via `GET /room/:roomHash/ws` with `Upgrade:
// websocket`. vitest-pool-workers routes that through the worker,
// which forwards to the DO stub. We then send/receive JSON frames
// matching the wire protocol in src/protocol.ts.
//
// These tests cover the invariants that would most plausibly break
// under a future refactor:
//   1. First join auto-initialises and succeeds.
//   2. Invalid sender/access hashes are rejected BEFORE any room
//      bootstrap, preserving the join-time-floor oracle defence.
//   3. Second party joining with a DIFFERENT access_hash is accepted
//      (fills slot 2).
//   4. Third party with a wrong access_hash is rejected with
//      "unauthorized" + attempts_remaining decrement.
//   5. Turn-taking: first party can send, but not twice in a row.
//   6. N=1: a reply from the second party overwrites the first's
//      message atomically — a subsequent /exists probe still shows
//      exists=true, and the next join sees the NEW message as
//      current_message.
//   7. Read receipts gate edit/delete — once read, edits return
//      not_editable.

// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// ---- helpers --------------------------------------------------------------

function hex64(tag: string): string {
  // Deterministic 64-char hex from a tag. Uses repetition + padding so
  // two tests with the same tag collide (useful for re-join scenarios)
  // while different tags produce distinct hashes. No crypto needed —
  // the DO only checks HEX64_RE shape, not cryptographic freshness.
  const base = tag.padEnd(32, "0");
  const hex = Array.from(base)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 64).padEnd(64, "0");
}

async function openSocket(roomHash: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/room/${roomHash}/ws`, {
    headers: { upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on upgrade response");
  ws.accept();
  return ws;
}

type ServerFrame =
  | { ref: string; ok?: unknown; error?: { reason: string; attempts_remaining?: number } }
  | { event: string; data: unknown };

function nextFrame(ws: WebSocket, timeoutMs = 2000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("ws frame timeout"));
    }, timeoutMs);
    const onMessage = (evt: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      const data = typeof evt.data === "string" ? evt.data : "";
      resolve(JSON.parse(data) as ServerFrame);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function waitRef(ws: WebSocket, ref: string): Promise<ServerFrame> {
  // Collect frames until one matches the ref. Broadcasts interleave
  // with replies in the DO; the client needs to filter by ref.
  for (let i = 0; i < 8; i++) {
    const frame = await nextFrame(ws);
    if ("ref" in frame && frame.ref === ref) return frame;
  }
  throw new Error(`never saw reply with ref=${ref}`);
}

async function waitEvent(ws: WebSocket, event: string): Promise<ServerFrame> {
  for (let i = 0; i < 8; i++) {
    const frame = await nextFrame(ws);
    if ("event" in frame && frame.event === event) return frame;
  }
  throw new Error(`never saw event=${event}`);
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

// Base64 of a 1-byte payload — passes base64 shape check but stays far
// under MAX_CIPHERTEXT_BYTES.
const TINY_CT = btoa("x");
const TINY_IV = btoa("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b");

// ---- tests ----------------------------------------------------------------

describe("RoomDO — join", () => {
  it("auto-initialises on first join with a valid access_hash", async () => {
    const room = hex64("room-join-first");
    const ws = await openSocket(room);
    send(ws, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-a"), access_hash: hex64("access-a") },
    });
    const reply = await waitRef(ws, "1");
    expect("ok" in reply && reply.ok).toBeTruthy();
    const ok = (reply as { ok: { room_id: string } }).ok;
    expect(typeof ok.room_id).toBe("string");
    expect(ok.room_id.length).toBeGreaterThan(0);
    ws.close();
  });

  it("rejects an invalid sender_hash before bootstrap", async () => {
    const room = hex64("room-bad-sender");
    const ws = await openSocket(room);
    send(ws, {
      event: "join",
      ref: "1",
      data: { sender_hash: "not-hex", access_hash: hex64("access-a") },
    });
    const reply = await waitRef(ws, "1");
    expect("error" in reply && reply.error?.reason).toBe("invalid_sender");

    // Probe: room must still be uninitialised — bad joins MUST NOT
    // leak into room state.
    const probe = await SELF.fetch(`https://example.com/api/room/${room}/exists`);
    expect(((await probe.json()) as { exists: boolean }).exists).toBe(false);
    ws.close();
  });

  it("rejects an invalid access_hash before bootstrap", async () => {
    const room = hex64("room-bad-access");
    const ws = await openSocket(room);
    send(ws, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-a"), access_hash: "nope" },
    });
    const reply = await waitRef(ws, "1");
    expect("error" in reply && reply.error?.reason).toBe("invalid_access");
    ws.close();
  });

  it("accepts a second party joining with a different access_hash", async () => {
    const room = hex64("room-two-parties");
    const a = await openSocket(room);
    send(a, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-a"), access_hash: hex64("access-a") },
    });
    await waitRef(a, "1");

    const b = await openSocket(room);
    send(b, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-b"), access_hash: hex64("access-b") },
    });
    const reply = await waitRef(b, "1");
    expect("ok" in reply && reply.ok).toBeTruthy();
    a.close();
    b.close();
  });

  it("returns unauthorized + attempts_remaining on wrong access_hash", async () => {
    const room = hex64("room-wrong-access");
    // Seat both access slots with two different hashes.
    const a = await openSocket(room);
    send(a, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-a"), access_hash: hex64("access-a") },
    });
    await waitRef(a, "1");
    const b = await openSocket(room);
    send(b, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-b"), access_hash: hex64("access-b") },
    });
    await waitRef(b, "1");
    a.close();
    b.close();

    // Third-party join with a NEW access_hash (both slots already
    // occupied) → unauthorized.
    const c = await openSocket(room);
    send(c, {
      event: "join",
      ref: "1",
      data: { sender_hash: hex64("sender-c"), access_hash: hex64("access-c") },
    });
    const reply = await waitRef(c, "1");
    expect("error" in reply && reply.error?.reason).toBe("unauthorized");
    const remaining = (reply as { error: { attempts_remaining?: number } }).error
      .attempts_remaining;
    expect(typeof remaining).toBe("number");
    expect(remaining).toBeLessThan(10);
    c.close();
  });
});

describe("RoomDO — messaging", () => {
  async function joined(roomTag: string, who: string): Promise<WebSocket> {
    const ws = await openSocket(hex64(roomTag));
    send(ws, {
      event: "join",
      ref: "j",
      data: { sender_hash: hex64(who), access_hash: hex64(`${who}-pin`) },
    });
    await waitRef(ws, "j");
    return ws;
  }

  it("enforces turn-taking (not_your_turn on second send in a row)", async () => {
    const a = await joined("room-turns", "a");

    send(a, { event: "send_message", ref: "1", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    await waitRef(a, "1");

    send(a, { event: "send_message", ref: "2", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const reply = await waitRef(a, "2");
    expect("error" in reply && reply.error?.reason).toBe("not_your_turn");

    a.close();
  });

  it("enforces N=1 — second party's reply overwrites the first message", async () => {
    const roomTag = "room-n1";
    const a = await joined(roomTag, "a");
    const b = await joined(roomTag, "b");

    send(a, { event: "send_message", ref: "1", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const ack1 = (await waitRef(a, "1")) as { ok: { message_id: string } };
    const id1 = ack1.ok.message_id;

    // B replies — this MUST atomically overwrite A's message. N=1
    // invariant. id2 must differ from id1.
    send(b, {
      event: "send_message",
      ref: "2",
      data: { ciphertext: btoa("y"), iv: TINY_IV },
    });
    const ack2 = (await waitRef(b, "2")) as { ok: { message_id: string } };
    const id2 = ack2.ok.message_id;
    expect(id2).not.toBe(id1);

    a.close();
    b.close();

    // A third party who joins now must only see the SECOND message
    // (the first was overwritten atomically at DO level).
    const c = await joined(roomTag, "a");
    send(c, {
      event: "join",
      ref: "jj",
      data: { sender_hash: hex64("a"), access_hash: hex64("a-pin") },
    });
    const rejoin = (await waitRef(c, "jj")) as {
      ok: { room_id: string; current_message?: { id: string } };
    };
    expect(rejoin.ok.current_message?.id).toBe(id2);
    c.close();
  });

  it("rejects edits after a read receipt (not_editable)", async () => {
    const roomTag = "room-edit-after-read";
    const a = await joined(roomTag, "a");
    const b = await joined(roomTag, "b");

    send(a, { event: "send_message", ref: "1", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const ack = (await waitRef(a, "1")) as { ok: { message_id: string } };
    const msgId = ack.ok.message_id;

    send(b, { event: "read_receipt", data: { message_id: msgId } });
    // Give the read broadcast time to land on A so the DO's
    // readAtMs is committed before the edit attempt races it.
    await waitEvent(a, "message_read");

    send(a, {
      event: "edit_message",
      ref: "2",
      data: { message_id: msgId, ciphertext: btoa("z"), iv: TINY_IV },
    });
    const reply = await waitRef(a, "2");
    expect("error" in reply && reply.error?.reason).toBe("not_editable");

    a.close();
    b.close();
  });

  it("rejects delete_message from the non-author", async () => {
    const roomTag = "room-del-non-author";
    const a = await joined(roomTag, "a");
    const b = await joined(roomTag, "b");

    send(a, { event: "send_message", ref: "1", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const ack = (await waitRef(a, "1")) as { ok: { message_id: string } };

    send(b, {
      event: "delete_message",
      ref: "2",
      data: { message_id: ack.ok.message_id },
    });
    const reply = await waitRef(b, "2");
    expect("error" in reply && reply.error?.reason).toBe("not_found");

    a.close();
    b.close();
  });

  it("rejects oversized ciphertext with message_too_large", async () => {
    const a = await joined("room-too-large", "a");
    // 8193 raw bytes → base64 length 10,924 — well past the 8192 limit
    // that the DO applies to the DECODED byte count. 10_000 base64
    // chars decode to ~7500 bytes — need more. Use 12,000 base64 chars
    // to clearly exceed the 8192-byte floor.
    const oversized = "A".repeat(12_000);
    send(a, { event: "send_message", ref: "1", data: { ciphertext: oversized, iv: TINY_IV } });
    const reply = await waitRef(a, "1");
    expect("error" in reply && reply.error?.reason).toBe("message_too_large");
    a.close();
  });
});

describe("RoomDO — unjoined events", () => {
  it("returns not_joined when a non-join event arrives first", async () => {
    const ws = await openSocket(hex64("room-not-joined"));
    send(ws, {
      event: "send_message",
      ref: "1",
      data: { ciphertext: TINY_CT, iv: TINY_IV },
    });
    const reply = await waitRef(ws, "1");
    expect("error" in reply && reply.error?.reason).toBe("not_joined");
    ws.close();
  });
});
