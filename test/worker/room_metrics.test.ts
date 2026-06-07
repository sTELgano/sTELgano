// SPDX-License-Identifier: AGPL-3.0-only
//
// RoomDO analytics — end-to-end. Drives the WebSocket protocol so the DO
// enqueues metrics to METRICS_QUEUE; the worker's queue() consumer (bound
// in wrangler.test.toml with a 1s batch timeout) flushes them into D1. We
// then poll daily_metrics for the expected rows.
//
// Verifies which metric fires for which event, the new engagement signals
// (second-party join, time-to-first-message, lifespan, empty expiry),
// security counters, and the privacy invariant (no identifier ever lands
// in a row).

// @ts-expect-error — see healthz.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { type DailyMetricRow, queryRange } from "../../src/lib/daily_metrics";
import { createPending, markPaid } from "../../src/lib/extension_tokens";

const DB = env.DB as D1Database;

function hex64(tag: string): string {
  const base = tag.padEnd(32, "0");
  const hex = Array.from(base)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 64).padEnd(64, "0");
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Inserts a paid extension token and returns the raw secret the client
 *  would send on join / redeem. */
async function paidSecret(tag: string, amountCents = 200, currency = "USD"): Promise<string> {
  const secret = hex64(tag);
  const tokenHash = await sha256hex(secret);
  await createPending(DB, {
    tokenHash,
    amountCents,
    currency,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await markPaid(DB, tokenHash, "test");
  return secret;
}

type ServerFrame =
  | { ref: string; ok?: unknown; error?: { reason: string; attempts_remaining?: number } }
  | { event: string; data: unknown };

async function openSocket(roomHash: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/room/${roomHash}/ws`, {
    headers: { upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket");
  ws.accept();
  return ws;
}

function nextFrame(ws: WebSocket, timeoutMs = 3000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("ws frame timeout"));
    }, timeoutMs);
    const onMessage = (evt: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(JSON.parse(typeof evt.data === "string" ? evt.data : "") as ServerFrame);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function waitRef(ws: WebSocket, ref: string): Promise<ServerFrame> {
  for (let i = 0; i < 8; i++) {
    const frame = await nextFrame(ws);
    if ("ref" in frame && frame.ref === ref) return frame;
  }
  throw new Error(`no reply ref=${ref}`);
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

async function join(ws: WebSocket, sender: string, access: string, countryIso?: string) {
  send(ws, {
    event: "join",
    ref: "j",
    data: { sender_hash: hex64(sender), access_hash: hex64(access), country_iso: countryIso },
  });
  return waitRef(ws, "j");
}

const TINY_CT = btoa("x");
const TINY_IV = btoa("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b");

/** Polls daily_metrics until `predicate` holds or the deadline passes. */
async function pollMetrics(
  predicate: (rows: DailyMetricRow[]) => boolean,
  timeoutMs = 12_000,
): Promise<DailyMetricRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: DailyMetricRow[] = [];
  while (Date.now() < deadline) {
    rows = await queryRange(DB, "2000-01-01", "2100-01-01");
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  return rows;
}

// Storage isolation is off (see vitest.workers.config.ts) so each test
// starts from a clean metrics table — assertions reflect only this test's
// DO emissions, not rows left by earlier suites.
beforeEach(async () => {
  await DB.prepare("DELETE FROM daily_metrics").run();
});

const has = (rows: DailyMetricRow[], metric: string) => rows.some((r) => r.metric === metric);
const countOf = (rows: DailyMetricRow[], metric: string) =>
  rows.filter((r) => r.metric === metric).reduce((a, r) => a + r.count, 0);

describe("RoomDO analytics emission", () => {
  it("emits room_free, second_party_joined, message_sent + time_to_first_message", async () => {
    const room = hex64("metrics-activation");
    const a = await openSocket(room);
    await join(a, "sender-a", "access-a", "KE");

    const b = await openSocket(room);
    await join(b, "sender-b", "access-b", "KE");

    send(a, { event: "send_message", ref: "m", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    await waitRef(a, "m");

    const rows = await pollMetrics(
      (r) => has(r, "second_party_joined") && has(r, "time_to_first_message"),
    );
    expect(has(rows, "room_free")).toBe(true);
    expect(has(rows, "second_party_joined")).toBe(true);
    expect(has(rows, "message_sent")).toBe(true);
    expect(has(rows, "time_to_first_message")).toBe(true);
    // The first-message metric carries a bucket dim and a positive avg.
    const ttfm = rows.find((r) => r.metric === "time_to_first_message");
    expect(ttfm?.dim).toBeTruthy();
    a.close();
    b.close();
  }, 20_000);

  it("emits room_lifespan + room_expired_empty for a channel that never carried a message", async () => {
    const room = hex64("metrics-empty-expiry");
    const ws = await openSocket(room);
    await join(ws, "sender-a", "access-a");
    send(ws, { event: "expire_room", ref: "x", data: {} });
    await waitRef(ws, "x");

    const rows = await pollMetrics((r) => has(r, "room_expired_empty"));
    expect(has(rows, "room_expired_free")).toBe(true);
    expect(has(rows, "room_lifespan")).toBe(true);
    expect(has(rows, "room_expired_empty")).toBe(true);
    // Expiry metrics are global — no country dimension.
    for (const r of rows.filter((x) => x.metric.startsWith("room_expired"))) {
      expect(r.stegCountry).toBe("");
      expect(r.cfCountry).toBe("");
    }
    ws.close();
  }, 20_000);

  it("counts access_failed and access_lockout after repeated wrong PINs", async () => {
    const room = hex64("metrics-lockout");
    const a = await openSocket(room);
    await join(a, "sender-a", "access-a");
    const b = await openSocket(room);
    await join(b, "sender-b", "access-b");
    a.close();
    b.close();

    // Both slots full; ten wrong-PIN joins trigger the 30-min lockout.
    for (let i = 0; i < 10; i++) {
      const w = await openSocket(room);
      await join(w, `intruder-${i}`, "access-wrong");
      w.close();
    }

    const rows = await pollMetrics((r) => has(r, "access_lockout"));
    expect(countOf(rows, "access_failed")).toBeGreaterThanOrEqual(10);
    expect(has(rows, "access_lockout")).toBe(true);
    expectSecurityGlobal(rows);
  }, 40_000);
});

describe("RoomDO monetization analytics", () => {
  it("emits room_free at create, then room_paid + extension(x1) + paid_sale + time_to_paid on redeem", async () => {
    const secret = await paidSecret("extend-free", 200, "USD");
    const room = hex64("metrics-extend");
    const ws = await openSocket(room);
    // Join creates a FREE number (the secret is ignored at creation).
    await join(ws, "s", "a", "KE");
    // redeem_extension upgrades free → paid: this is the "new paid number" flow.
    send(ws, {
      event: "redeem_extension",
      ref: "r",
      data: { extension_secret: secret, country_iso: "KE" },
    });
    await waitRef(ws, "r");

    const rows = await pollMetrics((r) => has(r, "paid_sale") && has(r, "time_to_paid"));
    expect(has(rows, "room_free")).toBe(true); // created free first
    expect(has(rows, "room_paid")).toBe(true); // converted on redeem
    expect(rows.find((r) => r.metric === "extension")?.dim).toBe("x1");
    const sale = rows.find((r) => r.metric === "paid_sale");
    expect(sale?.dim).toBe("USD_200");
    expect(sale?.sumValue).toBe(200);
    expect(sale?.stegCountry).toBe("KE");
    expect(rows.find((r) => r.metric === "time_to_paid")).toBeTruthy();
    expect(has(rows, "activity_hour")).toBe(true);
    ws.close();
  }, 20_000);
});

describe("RoomDO message-engagement analytics", () => {
  it("emits message_edited, message_read, and message_deleted", async () => {
    // Room 1: send → edit (before read) → read.
    const room1 = hex64("metrics-edit-read");
    const a = await openSocket(room1);
    await join(a, "sa", "aa");
    const b = await openSocket(room1);
    await join(b, "sb", "ab");
    send(a, { event: "send_message", ref: "m1", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const m1 = (await waitRef(a, "m1")) as { ok: { message_id: string } };
    const id1 = m1.ok.message_id;
    send(a, {
      event: "edit_message",
      ref: "e",
      data: { message_id: id1, ciphertext: TINY_CT, iv: TINY_IV },
    });
    await waitRef(a, "e");
    send(b, { event: "read_receipt", data: { message_id: id1 } });

    // Room 2: single party sends then deletes its own unread message.
    const room2 = hex64("metrics-delete");
    const c = await openSocket(room2);
    await join(c, "sc", "ac");
    send(c, { event: "send_message", ref: "m2", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    const m2 = (await waitRef(c, "m2")) as { ok: { message_id: string } };
    send(c, { event: "delete_message", ref: "d", data: { message_id: m2.ok.message_id } });
    await waitRef(c, "d");

    const rows = await pollMetrics(
      (r) => has(r, "message_edited") && has(r, "message_read") && has(r, "message_deleted"),
    );
    expect(has(rows, "message_edited")).toBe(true);
    expect(has(rows, "message_read")).toBe(true);
    expect(has(rows, "message_deleted")).toBe(true);
    a.close();
    b.close();
    c.close();
  }, 25_000);
});

// NOTE: acquisition emits (page_view / referrer) and the other request-path
// + cron emits (payment_*, funnel_*, cron_sweep, *_rate_limited) are wired
// with ctx.waitUntil so they deliver in production, but they are NOT
// integration-tested here: vitest-pool-workers only advances miniflare's
// queue timer on worker I/O, and a single SELF.fetch followed by direct D1
// reads never ticks it (the DO tests pass only because their many WS frames
// keep the worker busy). The classifier logic (pageRoute / referrerCategory)
// is covered deterministically by the pure unit tests, and the queue→D1
// consumer path is proven by the DO emission tests above.

describe("RoomDO analytics privacy", () => {
  it("never writes an identifier into any daily_metrics row", async () => {
    const room = hex64("metrics-privacy");
    const a = await openSocket(room);
    await join(a, "sender-a", "access-a", "KE");
    send(a, { event: "send_message", ref: "m", data: { ciphertext: TINY_CT, iv: TINY_IV } });
    await waitRef(a, "m");
    a.close();

    const rows = await pollMetrics((r) => has(r, "message_sent"));
    expect(rows.length).toBeGreaterThan(0);
    const HEX64 = /[a-f0-9]{64}/i;
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toMatch(HEX64);
    // dim values are only buckets / campaign slugs / '' — never a hash.
    for (const r of rows) expect(r.dim.length).toBeLessThan(40);
  }, 20_000);
});

/** Security counters are global (no country). */
function expectSecurityGlobal(rows: DailyMetricRow[]): void {
  for (const r of rows.filter((x) => x.metric.startsWith("access_"))) {
    expect(r.stegCountry).toBe("");
    expect(r.cfCountry).toBe("");
  }
}
