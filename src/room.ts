// SPDX-License-Identifier: AGPL-3.0-only
//
// RoomDO — Durable Object for a single sTELgano room.
//
// One instance per room_hash. Single-threaded execution enforces the N=1
// invariant by construction (replaces the v1 Postgres UNIQUE index on
// messages.room_id + delete-then-insert transaction in
// elixir/lib/stelgano/rooms.ex:send_message/4).
//
// Hibernatable WebSockets keep idle rooms cheap — when no events are in
// flight, the runtime hibernates the DO and re-instantiates it on the
// next event. State survives via DO Storage; per-connection state
// survives via serializeAttachment().
//
// Phase 2 implements the full v1 channel protocol minus redeem_extension
// (which needs D1 and lands in Phase 7). See
// elixir/lib/stelgano_web/channels/anon_room_channel.ex for the v1
// reference behaviour we are porting.

import type { Env } from "./env";
import {
  FREE_TTL_DAYS,
  HEX64_RE,
  JOIN_TIME_FLOOR_MS,
  LOCKOUT_MINUTES,
  MAX_ACCESS_ATTEMPTS,
  MAX_CIPHERTEXT_BYTES,
  PAID_TTL_DAYS,
  type ClientEvent,
  type ErrorReason,
  type MessagePayload,
  type ServerBroadcast,
  type ServerReply,
} from "./protocol";
import { findByTokenHash, markRedeemed } from "./lib/extension_tokens";
import { incrementPaid as countryIncrementPaid } from "./lib/country_metrics";
import { incrementPaidNew } from "./lib/daily_metrics";

// ---------------------------------------------------------------------------
// Persisted state — the entire room lives under one storage key. Rooms
// hold a small bounded amount of data (one message + at most two access
// records + a few scalars), so the simplicity of "load-modify-save" beats
// the complexity of a normalised SQL schema.
// ---------------------------------------------------------------------------

type AccessRecord = {
  accessHash: string;
  failedAttempts: number;
  /** epoch ms; null means not locked. */
  lockedUntilMs: number | null;
};

type StoredMessage = {
  id: string;
  senderHash: string;
  ciphertext: string; // base64
  iv: string; // base64
  insertedAtMs: number;
  readAtMs: number | null;
};

type RoomState = {
  /** Set true once the first join has bootstrapped the room. */
  isInitialized: boolean;
  /** Random UUID generated at room init. Returned to both parties on
   *  join so they can use it as the PBKDF2 salt input for the symmetric
   *  encryption key (matches v1's room.id semantics: independent
   *  per-room randomness, not derivable from room_hash by an attacker
   *  who knows the phone number). Stored separately from
   *  state.id.toString() so we don't bind the protocol to the CF DO id
   *  scheme (which is also deterministic from room_hash). */
  roomId: string;
  /** "free" or "paid". Phase 2 only creates "free" rooms. */
  tier: "free" | "paid";
  /** epoch ms — when the alarm fires, the room self-destructs. */
  ttlExpiresAtMs: number;
  /** Up to 2 records, one per party. */
  accessRecords: AccessRecord[];
  /** N=1 invariant — at most one current message. */
  currentMessage: StoredMessage | null;
};

const STATE_KEY = "state";

/** SHA-256 of a UTF-8 string, returned as lowercase hex. Used to
 *  reconstitute the token_hash from the client's extension_secret
 *  in the redeem flow. Same algorithm as AnonCrypto.sha256hex on
 *  the client. */
async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input) as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Per-WebSocket attachment that survives hibernation. */
type WsAttachment = {
  joined: boolean;
  senderHash?: string;
  accessHash?: string;
};

// ---------------------------------------------------------------------------
// RoomDO
// ---------------------------------------------------------------------------

export class RoomDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  /** In-memory copy of persisted state, hydrated on first access. */
  private room: RoomState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Hydrate state before any concurrent requests are served. blockConcurrencyWhile
    // gates incoming messages until this resolves.
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get<RoomState>(STATE_KEY)) ?? null;
    });
  }

  // -------------------------------------------------------------------------
  // HTTP entry point — accepts the WebSocket upgrade and hibernates.
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Initial attachment marks the connection as not-yet-joined. The
    // first event must be `join` — anything else replies with not_joined.
    server.serializeAttachment({ joined: false } satisfies WsAttachment);

    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Hibernatable WebSocket handlers — runtime invokes these on each frame
  // even after the DO has hibernated. Re-hydrates state on first call.
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.send(ws, { ref: "0", error: { reason: "invalid_encoding" } });
      return;
    }

    let evt: ClientEvent;
    try {
      evt = JSON.parse(raw) as ClientEvent;
    } catch {
      this.send(ws, { ref: "0", error: { reason: "invalid_encoding" } });
      return;
    }

    // Handle the join event before checking attachment so the ref is
    // honoured on the very first message.
    if (evt.event === "join") {
      await this.handleJoin(ws, evt);
      return;
    }

    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att?.joined) {
      const ref = "ref" in evt ? evt.ref : undefined;
      if (ref) {
        this.send(ws, { ref, error: { reason: "not_joined" } });
      }
      return;
    }

    switch (evt.event) {
      case "send_message":
        await this.handleSendMessage(ws, att, evt);
        break;
      case "read_receipt":
        await this.handleReadReceipt(ws, evt);
        break;
      case "edit_message":
        await this.handleEditMessage(ws, att, evt);
        break;
      case "delete_message":
        await this.handleDeleteMessage(ws, att, evt);
        break;
      case "typing":
        this.handleTyping(ws, att);
        break;
      case "expire_room":
        await this.handleExpireRoom(ws, evt);
        break;
      case "redeem_extension":
        await this.handleRedeemExtension(ws, evt);
        break;
      default: {
        // Unknown event — ignore (matches v1's Logger.warning + noreply).
        const _exhaustive: never = evt;
        void _exhaustive;
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket, _err: unknown): void {
    try {
      ws.close(1011, "internal_error");
    } catch {
      // already closed
    }
  }

  // -------------------------------------------------------------------------
  // Alarm — fires at ttlExpiresAtMs. Self-destruct: clear state, broadcast
  // room_expired to anyone connected, close all sockets.
  //
  // Replaces the v1 elixir/lib/stelgano/jobs/expire_ttl_rooms.ex hourly
  // sweep — exact-time per-room expiry instead of a polled batch.
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    if (!this.room) return;

    this.broadcastAll({ event: "room_expired", data: {} });

    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, "room_expired");
      } catch {
        // already closed
      }
    }

    await this.state.storage.deleteAll();
    this.room = null;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async handleJoin(ws: WebSocket, evt: Extract<ClientEvent, { event: "join" }>): Promise<void> {
    const start = Date.now();

    const senderHash = evt.data.sender_hash;
    const accessHash = evt.data.access_hash;

    if (!HEX64_RE.test(senderHash)) {
      await this.padJoin(start);
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_sender" } });
      return;
    }
    if (!HEX64_RE.test(accessHash)) {
      await this.padJoin(start);
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_access" } });
      return;
    }

    // Auto-initialise on first join with default free tier.
    // Phase 3+ will add an explicit create-room HTTP entry that lets
    // the client pick a tier (free vs. paid) before the WebSocket join.
    if (!this.room || !this.room.isInitialized) {
      const ttlMs = Date.now() + FREE_TTL_DAYS * 86_400_000;
      this.room = {
        isInitialized: true,
        roomId: crypto.randomUUID(),
        tier: "free",
        ttlExpiresAtMs: ttlMs,
        accessRecords: [{ accessHash, failedAttempts: 0, lockedUntilMs: null }],
        currentMessage: null,
      };
      await this.persist();
      await this.state.storage.setAlarm(ttlMs);

      ws.serializeAttachment({ joined: true, senderHash, accessHash } satisfies WsAttachment);
      await this.padJoin(start);
      this.send(ws, {
        ref: evt.ref,
        ok: { room_id: this.room.roomId },
      });
      return;
    }

    // Existing room — check access.
    const result = this.checkAccess(accessHash);
    if (result.kind === "ok") {
      await this.persist();
      ws.serializeAttachment({ joined: true, senderHash, accessHash } satisfies WsAttachment);
      await this.padJoin(start);
      const reply: { room_id: string; current_message?: MessagePayload } = {
        room_id: this.room.roomId,
      };
      if (this.room.currentMessage) {
        reply.current_message = this.toPayload(this.room.currentMessage);
      }
      this.send(ws, { ref: evt.ref, ok: reply });
      return;
    }

    await this.persist();
    await this.padJoin(start);

    if (result.kind === "locked") {
      this.send(ws, { ref: evt.ref, error: { reason: "locked" } });
    } else {
      this.send(ws, {
        ref: evt.ref,
        error: { reason: "unauthorized", attempts_remaining: result.remaining },
      });
    }
  }

  private async handleSendMessage(
    ws: WebSocket,
    att: WsAttachment,
    evt: Extract<ClientEvent, { event: "send_message" }>,
  ): Promise<void> {
    if (!this.room) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_found" } });
      return;
    }

    const decoded = this.decodeAndCheckCiphertext(evt.data.ciphertext, evt.data.iv);
    if (decoded.kind === "error") {
      this.send(ws, { ref: evt.ref, error: { reason: decoded.reason } });
      return;
    }

    const existing = this.room.currentMessage;
    if (existing && existing.senderHash === att.senderHash) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_your_turn" } });
      return;
    }

    // N=1 enforcement: replace whatever was there. Single-threaded DO
    // execution makes this atomic without a UNIQUE index — no race
    // window for a competing sender to slip in between delete and insert.
    const message: StoredMessage = {
      id: crypto.randomUUID(),
      senderHash: att.senderHash!,
      ciphertext: evt.data.ciphertext,
      iv: evt.data.iv,
      insertedAtMs: Date.now(),
      readAtMs: null,
    };

    this.room.currentMessage = message;
    await this.persist();

    const payload = this.toPayload(message);
    this.broadcastAll({ event: "new_message", data: payload });
    this.send(ws, { ref: evt.ref, ok: { message_id: message.id } });
  }

  private async handleReadReceipt(
    ws: WebSocket,
    evt: Extract<ClientEvent, { event: "read_receipt" }>,
  ): Promise<void> {
    if (!this.room?.currentMessage) {
      // Match v1: silently ignore.
      return;
    }
    const msg = this.room.currentMessage;
    if (msg.id !== evt.data.message_id || msg.readAtMs !== null) {
      return;
    }
    msg.readAtMs = Date.now();
    await this.persist();
    this.broadcastAll({ event: "message_read", data: { message_id: msg.id } });
    void ws;
  }

  private async handleEditMessage(
    ws: WebSocket,
    att: WsAttachment,
    evt: Extract<ClientEvent, { event: "edit_message" }>,
  ): Promise<void> {
    const msg = this.room?.currentMessage;
    if (!msg || msg.id !== evt.data.message_id || msg.senderHash !== att.senderHash) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_found" } });
      return;
    }
    if (msg.readAtMs !== null) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_editable" } });
      return;
    }

    const decoded = this.decodeAndCheckCiphertext(evt.data.ciphertext, evt.data.iv);
    if (decoded.kind === "error") {
      this.send(ws, { ref: evt.ref, error: { reason: decoded.reason } });
      return;
    }

    msg.ciphertext = evt.data.ciphertext;
    msg.iv = evt.data.iv;
    await this.persist();

    this.broadcastAll({
      event: "message_edited",
      data: { message_id: msg.id, ciphertext: msg.ciphertext, iv: msg.iv },
    });
    this.send(ws, { ref: evt.ref, ok: {} });
  }

  private async handleDeleteMessage(
    ws: WebSocket,
    att: WsAttachment,
    evt: Extract<ClientEvent, { event: "delete_message" }>,
  ): Promise<void> {
    const msg = this.room?.currentMessage;
    if (!msg || msg.id !== evt.data.message_id || msg.senderHash !== att.senderHash) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_found" } });
      return;
    }
    if (msg.readAtMs !== null) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_deletable" } });
      return;
    }

    this.room!.currentMessage = null;
    await this.persist();

    this.broadcastAll({ event: "message_deleted", data: { message_id: msg.id } });
    this.send(ws, { ref: evt.ref, ok: {} });
  }

  private handleTyping(ws: WebSocket, att: WsAttachment): void {
    this.broadcastExcept(att.senderHash!, { event: "counterparty_typing", data: {} });
    void ws;
  }

  private async handleExpireRoom(
    ws: WebSocket,
    evt: Extract<ClientEvent, { event: "expire_room" }>,
  ): Promise<void> {
    this.broadcastAll({ event: "room_expired", data: {} });
    this.send(ws, { ref: evt.ref, ok: {} });

    // Close sockets after the reply is sent so the client gets the ack.
    for (const peer of this.state.getWebSockets()) {
      try {
        peer.close(1000, "room_expired");
      } catch {
        // already closed
      }
    }

    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    this.room = null;
  }

  // -------------------------------------------------------------------------
  // Redeem extension
  //
  // Client fires this with the extension_secret (random 256-bit hex)
  // it stashed in sessionStorage before redirecting to Paystack. We
  // hash it via SHA-256 to reconstitute the token_hash used as the
  // Paystack transaction reference, look the row up in D1, and —
  // if it's status=paid — mark it redeemed and bump the room TTL
  // to PAID_TTL_DAYS from now.
  //
  // The extension_tokens table has no room_id column, so the only
  // correlation between a payment and a room lives ephemerally
  // inside this handler. v1's elixir/lib/stelgano/monetization.ex
  // `redeem_token/2` is the same contract.
  // -------------------------------------------------------------------------

  private async handleRedeemExtension(
    ws: WebSocket,
    evt: Extract<ClientEvent, { event: "redeem_extension" }>,
  ): Promise<void> {
    if (this.env.MONETIZATION_ENABLED !== "true") {
      this.send(ws, { ref: evt.ref, error: { reason: "monetization_disabled" } });
      return;
    }
    if (!this.room) {
      this.send(ws, { ref: evt.ref, error: { reason: "not_found" } });
      return;
    }

    const secret = evt.data.extension_secret;
    if (typeof secret !== "string" || secret.length === 0) {
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    // Reconstitute the server-side token_hash from the client's secret.
    const tokenHash = await sha256hex(secret);

    const token = await findByTokenHash(this.env.DB, tokenHash);
    if (!token || token.status !== "paid") {
      // Not found OR still pending (webhook hasn't landed) OR
      // already redeemed. All collapse to "invalid_token" so the
      // client can't distinguish.
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    const changed = await markRedeemed(this.env.DB, tokenHash);
    if (changed === 0) {
      // Race: another connection redeemed it between our findByTokenHash
      // and markRedeemed. Treat as invalid.
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    // Extend the room's TTL and reschedule its self-destruct alarm.
    const newTtlMs = Date.now() + PAID_TTL_DAYS * 86_400_000;
    this.room.tier = "paid";
    this.room.ttlExpiresAtMs = newTtlMs;
    await this.persist();
    await this.state.storage.setAlarm(newTtlMs);

    // Bump telemetry. country_iso is optional — the client derives
    // it from libphonenumber-js, never stored alongside any
    // individual room or token.
    const iso = evt.data.country_iso;
    await Promise.all([
      iso ? countryIncrementPaid(this.env.DB, iso) : Promise.resolve(),
      incrementPaidNew(this.env.DB),
    ]);

    const ttlIso = new Date(newTtlMs).toISOString();
    this.broadcastAll({
      event: "ttl_extended",
      data: { ttl_expires_at: ttlIso },
    });
    this.send(ws, { ref: evt.ref, ok: { ttl_expires_at: ttlIso } });
  }

  // -------------------------------------------------------------------------
  // Access control — ports the elixir/lib/stelgano/rooms.ex handle_access /
  // handle_access_miss logic. Keeps the "increment counter on the record
  // with the most failures" cleverness so a wrong PIN doesn't reveal which
  // access_hash is the legitimate one.
  // -------------------------------------------------------------------------

  private checkAccess(
    accessHash: string,
  ): { kind: "ok" } | { kind: "locked" } | { kind: "unauthorized"; remaining: number } {
    if (!this.room) return { kind: "locked" };

    const now = Date.now();
    const records = this.room.accessRecords;
    const matched = records.find((r) => r.accessHash === accessHash);

    if (matched) {
      if (matched.lockedUntilMs !== null && matched.lockedUntilMs > now) {
        return { kind: "locked" };
      }
      matched.failedAttempts = 0;
      matched.lockedUntilMs = null;
      return { kind: "ok" };
    }

    // No matching record. If we still have room for a second party, this
    // is a first-time join — register and succeed.
    if (records.length < 2) {
      records.push({ accessHash, failedAttempts: 0, lockedUntilMs: null });
      return { kind: "ok" };
    }

    // Both slots occupied — wrong PIN. Increment the counter on the
    // record with the most failures (so the failure isn't attributable
    // to either specific record).
    const target = records.reduce((a, b) => (a.failedAttempts >= b.failedAttempts ? a : b));
    if (target.lockedUntilMs !== null && target.lockedUntilMs > now) {
      return { kind: "locked" };
    }

    target.failedAttempts += 1;
    if (target.failedAttempts >= MAX_ACCESS_ATTEMPTS) {
      target.lockedUntilMs = now + LOCKOUT_MINUTES * 60_000;
      return { kind: "locked" };
    }

    const remaining = Math.max(0, MAX_ACCESS_ATTEMPTS - target.failedAttempts);
    return { kind: "unauthorized", remaining };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async persist(): Promise<void> {
    if (this.room) {
      await this.state.storage.put(STATE_KEY, this.room);
    }
  }

  /** Pads the join handler's wall-clock duration to the JOIN_TIME_FLOOR_MS
   *  floor with a small jitter, so reply timing doesn't classify
   *  room_hashes as "exists" vs. "doesn't exist". */
  private async padJoin(startMs: number): Promise<void> {
    const target = JOIN_TIME_FLOOR_MS + Math.floor(Math.random() * (JOIN_TIME_FLOOR_MS / 4));
    const elapsed = Date.now() - startMs;
    if (elapsed < target) {
      await new Promise((r) => setTimeout(r, target - elapsed));
    }
  }

  private toPayload(m: StoredMessage): MessagePayload {
    return {
      id: m.id,
      sender_hash: m.senderHash,
      ciphertext: m.ciphertext,
      iv: m.iv,
      read_at: m.readAtMs === null ? null : new Date(m.readAtMs).toISOString(),
      inserted_at: new Date(m.insertedAtMs).toISOString(),
    };
  }

  /** Decodes base64 to verify validity, then verifies the binary length
   *  is within the MAX_CIPHERTEXT_BYTES limit. Does not return the
   *  decoded bytes — they're not needed (we store the base64 directly).
   */
  private decodeAndCheckCiphertext(
    ctB64: string,
    ivB64: string,
  ): { kind: "ok" } | { kind: "error"; reason: ErrorReason } {
    if (typeof ctB64 !== "string" || typeof ivB64 !== "string") {
      return { kind: "error", reason: "invalid_encoding" };
    }
    let ctBytes: number;
    try {
      // atob throws on invalid base64. We measure length without holding
      // the decoded string.
      ctBytes = atob(ctB64).length;
      atob(ivB64); // validate iv is base64
    } catch {
      return { kind: "error", reason: "invalid_encoding" };
    }
    if (ctBytes > MAX_CIPHERTEXT_BYTES) {
      return { kind: "error", reason: "message_too_large" };
    }
    return { kind: "ok" };
  }

  private send(ws: WebSocket, msg: ServerReply | ServerBroadcast): void {

    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closed mid-send; nothing to do
    }
  }

  /** Broadcasts to every connected (joined) WebSocket, including the
   *  sender. v1 calls this `broadcast!`. */
  private broadcastAll(msg: ServerBroadcast): void {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.joined) {
        this.send(ws, msg);
      }
    }
  }

  /** Broadcasts to every joined socket EXCEPT those matching the given
   *  sender hash. v1 calls this `broadcast_from!`. */
  private broadcastExcept(senderHash: string, msg: ServerBroadcast): void {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.joined && att.senderHash !== senderHash) {
        this.send(ws, msg);
      }
    }
  }
}
