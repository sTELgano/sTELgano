// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
//
// Unit tests for src/client/room_client.ts.
//
// Verifies that each public method produces the correct JSON frame on the
// wire. This is the layer that was missing when country_iso was defined
// in the protocol type but never included in the join() payload.
//
// Strategy: mock globalThis.WebSocket with a minimal EventTarget-backed
// stub, open the client, capture raw ws.send() strings, and assert the
// parsed frame shape. Server replies are injected via ws.receive() so
// Promise-based methods resolve.
//
// Environment: node (not jsdom). EventTarget/Event/MessageEvent/CloseEvent
// are available in Node 18+. We stub globalThis.location since RoomClient
// reads location.protocol and location.host to build the WebSocket URL.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoomClient } from "../../src/client/room_client";

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Last instance created — reset in beforeEach. */
  static last: MockWebSocket | null = null;

  readonly sent: string[] = [];
  readyState = MockWebSocket.OPEN;

  constructor(public readonly url: string) {
    super();
    MockWebSocket.last = this;
    // Fire open on next microtask, matching real WebSocket behaviour.
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  /** Inject a server → client message frame. */
  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Shorthand: inject a successful reply for a given ref. */
  replyOk(ref: string, ok: unknown): void {
    this.receive(JSON.stringify({ ref, ok }));
  }

  /** Shorthand: inject an error reply for a given ref. */
  replyError(ref: string, reason: string, extra?: Record<string, unknown>): void {
    this.receive(JSON.stringify({ ref, error: { reason, ...extra } }));
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOM = "a".repeat(64);
const SENDER = "b".repeat(64);
const ACCESS = "c".repeat(64);
const JOIN_OK = { room_id: "test-room", ttl_expires_at: "2099-01-01T00:00:00.000Z" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openedClient(): Promise<{ client: RoomClient; ws: MockWebSocket }> {
  const client = new RoomClient(ROOM);
  await client.open();
  const ws = MockWebSocket.last!;
  return { client, ws };
}

async function joinedClient(countryIso = "US"): Promise<{ client: RoomClient; ws: MockWebSocket }> {
  const { client, ws } = await openedClient();
  const p = client.join(SENDER, ACCESS, countryIso);
  ws.replyOk("1", JOIN_OK);
  await p;
  return { client, ws };
}

function parseSent(ws: MockWebSocket, index: number): Record<string, unknown> {
  const raw = ws.sent[index];
  if (!raw) throw new Error(`No frame at index ${index} — sent: ${ws.sent.length}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.last = null;
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
});

// ---------------------------------------------------------------------------
// join()
// ---------------------------------------------------------------------------

describe("RoomClient.join()", () => {
  it("includes sender_hash, access_hash, and country_iso in the wire frame", async () => {
    const { client, ws } = await openedClient();

    const p = client.join(SENDER, ACCESS, "KE");
    ws.replyOk("1", JOIN_OK);
    await p;

    const frame = parseSent(ws, 0);
    expect(frame.event).toBe("join");
    expect(typeof frame.ref).toBe("string");
    expect(frame.data).toMatchObject({
      sender_hash: SENDER,
      access_hash: ACCESS,
      country_iso: "KE",
    });
    client.close();
  });

  it("omits country_iso from the frame when not provided", async () => {
    const { client, ws } = await openedClient();

    const p = client.join(SENDER, ACCESS);
    ws.replyOk("1", JOIN_OK);
    await p;

    const frame = parseSent(ws, 0);
    const data = frame.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("country_iso");
    client.close();
  });

  it("resolves with the room_id returned by the server", async () => {
    const { client, ws } = await openedClient();

    const p = client.join(SENDER, ACCESS, "NG");
    ws.replyOk("1", { room_id: "my-room", ttl_expires_at: "2099-01-01T00:00:00.000Z" });
    const reply = await p;

    expect(reply.room_id).toBe("my-room");
    client.close();
  });

  it("rejects with the server error reason on unauthorized", async () => {
    const { client, ws } = await openedClient();

    const p = client.join(SENDER, ACCESS, "US");
    ws.replyError("1", "unauthorized", { attempts_remaining: 8 });

    await expect(p).rejects.toMatchObject({
      reason: "unauthorized",
      attempts_remaining: 8,
    });
    client.close();
  });

  it("rejects with invalid_sender on malformed sender_hash", async () => {
    const { client, ws } = await openedClient();

    const p = client.join(SENDER, ACCESS, "US");
    ws.replyError("1", "invalid_sender");

    await expect(p).rejects.toMatchObject({ reason: "invalid_sender" });
    client.close();
  });

  it("uses auto-incrementing refs so concurrent requests do not collide", async () => {
    const { client, ws } = await openedClient();

    // join (ref "1"), then send_message without awaiting join first —
    // the important thing is that each call gets a unique ref.
    const p1 = client.join(SENDER, ACCESS, "US");
    ws.replyOk("1", JOIN_OK);
    await p1;

    const p2 = client.sendMessage(btoa("x"), btoa("\x00".repeat(12)));
    ws.replyOk("2", { message_id: "msg-1" });
    await p2;

    expect(parseSent(ws, 0).ref).toBe("1");
    expect(parseSent(ws, 1).ref).toBe("2");
    client.close();
  });
});

// ---------------------------------------------------------------------------
// sendMessage()
// ---------------------------------------------------------------------------

describe("RoomClient.sendMessage()", () => {
  it("sends ciphertext and iv in the wire frame", async () => {
    const { client, ws } = await joinedClient();

    const ct = btoa("ciphertext-bytes");
    const iv = btoa("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b");
    const p = client.sendMessage(ct, iv);
    ws.replyOk("2", { message_id: "msg-abc" });
    const reply = await p;

    const frame = parseSent(ws, 1); // sent[0] is join
    expect(frame.event).toBe("send_message");
    expect(frame.data).toMatchObject({ ciphertext: ct, iv });
    expect(reply.message_id).toBe("msg-abc");
    client.close();
  });
});

// ---------------------------------------------------------------------------
// redeemExtension()
// ---------------------------------------------------------------------------

describe("RoomClient.redeemExtension()", () => {
  it("sends extension_secret and country_iso when provided", async () => {
    const { client, ws } = await joinedClient();

    const p = client.redeemExtension("secret-hex-64", "GH");
    ws.replyOk("2", { ttl_expires_at: "2100-01-01T00:00:00.000Z" });
    await p;

    const frame = parseSent(ws, 1);
    expect(frame.event).toBe("redeem_extension");
    expect(frame.data).toMatchObject({
      extension_secret: "secret-hex-64",
      country_iso: "GH",
    });
    client.close();
  });

  it("omits country_iso from the frame when not provided", async () => {
    const { client, ws } = await joinedClient();

    const p = client.redeemExtension("secret-hex-64");
    ws.replyOk("2", { ttl_expires_at: "2100-01-01T00:00:00.000Z" });
    await p;

    const frame = parseSent(ws, 1);
    const data = frame.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("country_iso");
    client.close();
  });

  it("resolves with the extended ttl_expires_at", async () => {
    const { client, ws } = await joinedClient();

    const p = client.redeemExtension("secret-hex-64", "ZA");
    ws.replyOk("2", { ttl_expires_at: "2100-06-15T12:00:00.000Z" });
    const reply = await p;

    expect(reply.ttl_expires_at).toBe("2100-06-15T12:00:00.000Z");
    client.close();
  });
});

// ---------------------------------------------------------------------------
// markRead() and typing() — fire-and-forget
// ---------------------------------------------------------------------------

describe("RoomClient fire-and-forget events", () => {
  it("markRead() sends a read_receipt frame with the message_id", async () => {
    const { client, ws } = await joinedClient();

    client.markRead("msg-xyz");

    const frame = parseSent(ws, 1);
    expect(frame.event).toBe("read_receipt");
    expect((frame.data as Record<string, unknown>).message_id).toBe("msg-xyz");
    client.close();
  });

  it("typing() sends a typing frame with an empty data object", async () => {
    const { client, ws } = await joinedClient();

    client.typing();

    const frame = parseSent(ws, 1);
    expect(frame.event).toBe("typing");
    expect(frame.data).toEqual({});
    client.close();
  });
});

// ---------------------------------------------------------------------------
// close() — internal_error for in-flight requests
// ---------------------------------------------------------------------------

describe("RoomClient.close()", () => {
  it("rejects in-flight requests with internal_error", async () => {
    const { client } = await openedClient();

    const p = client.join(SENDER, ACCESS, "US");
    // Close before the server replies — pending join should reject.
    client.close();

    await expect(p).rejects.toMatchObject({ reason: "internal_error" });
  });
});
