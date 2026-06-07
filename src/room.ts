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
// Ports the full v1 channel protocol from
// elixir/lib/stelgano_web/channels/anon_room_channel.ex.

import type { Env } from "./env";
import {
  conversionBucket,
  enqueueMetric,
  enqueueMetrics,
  extensionBucket,
  lifespanBucket,
  type MetricKey,
  priceLabel,
  ttfmBucket,
  utcHour,
} from "./lib/daily_metrics";
import { deleteToken, findByTokenHash, markPaid, markRedeemed } from "./lib/extension_tokens";
import {
  convertActiveToPaid,
  decrementActiveRooms,
  incrementActiveRooms,
} from "./lib/live_counters";
import { verifyTransaction } from "./lib/paystack";
import {
  type ClientEvent,
  type ErrorReason,
  FREE_TTL_DAYS,
  HEX64_RE,
  JOIN_TIME_FLOOR_MS,
  LOCKOUT_MINUTES,
  MAX_ACCESS_ATTEMPTS,
  MAX_CIPHERTEXT_BYTES,
  type MessagePayload,
  PAID_TTL_DAYS,
  type ServerBroadcast,
  type ServerReply,
} from "./protocol";

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
  /** "free" or "paid". Paid rooms are created atomically on first join
   *  when a valid paid extension_secret is supplied, or upgraded later
   *  via a redeem_extension event (existing-room extend path). */
  tier: "free" | "paid";
  /** epoch ms — when the alarm fires, the room self-destructs. */
  ttlExpiresAtMs: number;
  /** epoch ms — room creation time. Set once at init and NOT changed on
   *  extension, so room_lifespan reflects the channel's true total life.
   *  Used for lifespan and time-to-first-message analytics. */
  createdAtMs: number;
  /** Set true on the first message ever sent in the room; never reset by
   *  edit/delete. Lets time_to_first_message fire exactly once and lets
   *  room_expired_empty exclude rooms whose only message was later deleted. */
  everMessaged: boolean;
  /** Count of paid extensions this number has received (1 = first purchase,
   *  free→paid; 2 = first renewal; …). Tracked in room state, never by hash,
   *  so the `extension` ordinal metric is a population distribution. */
  extensionCount: number;
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
  /** CF-IPCountry forwarded by the main Worker as X-CF-Country before
   *  the stub.fetch() call. Stored in the attachment so it survives
   *  DO hibernation and is available in later event handlers. */
  cfCountry?: string;
  /** Steg-number country (ISO alpha-2) from evt.data.country_iso on join.
   *  Stored so message_sent events carry the same country dimension as join events. */
  stegCountry?: string;
};

// ---------------------------------------------------------------------------
// RoomDO
// ---------------------------------------------------------------------------

export class RoomDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  /** In-memory copy of persisted state, hydrated on first access. */
  private room: RoomState | null = null;

  /** Client IP injected by the main Worker via the X-Client-IP header
   *  before calling stub.fetch(). Used to rate-limit room creation per IP.
   *  Populated in fetch() and available throughout the request lifetime. */
  private clientIp = "unknown";

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Hydrate state before any concurrent requests are served. blockConcurrencyWhile
    // gates incoming messages until this resolves.
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get<RoomState>(STATE_KEY)) ?? null;
      // Backfill fields added after some rooms were created so lifespan /
      // time-to-first analytics never see undefined. createdAtMs is derived
      // best-effort from the TTL (approximate for legacy rooms, since the
      // TTL may have been extended); everMessaged is inferred from whether a
      // message is currently present. Persisted once so it stays stable.
      if (this.room && this.room.createdAtMs === undefined) {
        const ttlDays = this.room.tier === "paid" ? PAID_TTL_DAYS : FREE_TTL_DAYS;
        this.room.createdAtMs = this.room.ttlExpiresAtMs - ttlDays * 86_400_000;
        this.room.everMessaged = this.room.currentMessage != null;
        // A legacy paid room had at least one purchase; free rooms zero.
        this.room.extensionCount = this.room.tier === "paid" ? 1 : 0;
        await this.persist();
      }
    });
  }

  // -------------------------------------------------------------------------
  // HTTP entry point — accepts the WebSocket upgrade and hibernates.
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    this.clientIp = request.headers.get("X-Client-IP") ?? "unknown";
    const url = new URL(request.url);

    // GET /exists — probe whether this room has been initialised.
    // Used by the client to route first-time joins through
    // new_channel (tier selection) vs. straight into connect. No
    // authentication — room_hash alone has enough entropy that
    // someone probing it already has the phone number + ROOM_SALT.
    if (request.method === "GET" && url.pathname.endsWith("/exists")) {
      return new Response(JSON.stringify({ exists: Boolean(this.room?.isInitialized) }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Initial attachment marks the connection as not-yet-joined. The
    // first event must be `join` — anything else replies with not_joined.
    // CF-IPCountry is stored here so it survives hibernation and is
    // available when handleJoin() and handleRedeemExtension() fire.
    const cfCountry = request.headers.get("X-CF-Country") ?? "";
    server.serializeAttachment({ joined: false, cfCountry } satisfies WsAttachment);

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

    if (this.room) void decrementActiveRooms(this.env.DB, this.room.tier);
    this.emitExpiry(this.room);
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    this.room = null;
  }

  /** Enqueues the expiry metric family (global, no country — matching the
   *  long-standing design where room records carry no country): the tiered
   *  expiry counter, the total channel lifespan (with a bucket dim),
   *  room_expired_empty when the channel never carried a message, and
   *  room_expired_solo when it never gained a second party. */
  private emitExpiry(room: RoomState): void {
    const expiredType: MetricKey = room.tier === "paid" ? "room_expired_paid" : "room_expired_free";
    const lifespanHours = Math.max(0, (Date.now() - room.createdAtMs) / 3_600_000);
    const items: Array<{ metric: MetricKey; value?: number; dim?: string }> = [
      { metric: expiredType },
      { metric: "room_lifespan", value: lifespanHours, dim: lifespanBucket(lifespanHours) },
    ];
    if (!room.everMessaged) items.push({ metric: "room_expired_empty" });
    if (room.accessRecords.length < 2) items.push({ metric: "room_expired_solo" });
    enqueueMetrics(this.env.METRICS_QUEUE, items);
  }

  /** Enqueues the monetization pair for a realized payment: the extension
   *  ordinal (x1, x2, …) and the priced sale (count = unit, sum_value =
   *  revenue in minor units), both carrying country. No payment reference,
   *  room id, or hash is ever included — this stays an aggregate. */
  private emitPaidSale(
    sale: { currency: string; amount_cents: number },
    extensionOrdinal: number,
    stegCountry: string,
    cfCountry: string,
  ): void {
    enqueueMetrics(this.env.METRICS_QUEUE, [
      { metric: "extension", dim: extensionBucket(extensionOrdinal), stegCountry, cfCountry },
      {
        metric: "paid_sale",
        dim: priceLabel(sale.currency, sale.amount_cents),
        value: sale.amount_cents,
        stegCountry,
        cfCountry,
      },
    ]);
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async handleJoin(
    ws: WebSocket,
    evt: Extract<ClientEvent, { event: "join" }>,
  ): Promise<void> {
    const start = Date.now();

    const senderHash = evt.data.sender_hash;
    const accessHash = evt.data.access_hash;

    // Read CF country from the attachment set during WebSocket upgrade.
    // Falls back to "" if missing (old clients, test environments).
    const cfCountry = (ws.deserializeAttachment() as WsAttachment | null)?.cfCountry ?? "";

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

    // Auto-initialise on first join. Every number starts free (weekly TTL);
    // a paid (yearly) number is reached only via redeem_extension — the
    // client always creates the room free, then redeems to upgrade. We do
    // NOT claim a paid token at creation: that raced the Paystack webhook
    // and split the "new paid number" flow across two code paths. Any
    // extension_secret in the join payload is ignored here; the client's
    // post-join redeem_extension converts free → paid.
    if (!this.room?.isInitialized) {
      // Rate-limit room creation per client IP. Fail-open: if the rate
      // limiter is unavailable, we allow the request through. Checked
      // only on new-room creation (not on join of existing rooms).
      const rl = await this.env.RATE_LIMITER_ROOM_CREATE.limit({ key: this.clientIp }).catch(
        () => ({ success: true }),
      );
      if (!rl.success) {
        enqueueMetric(this.env.METRICS_QUEUE, "join_rate_limited", { dim: "create" });
        await this.padJoin(start);
        this.send(ws, { ref: evt.ref, error: { reason: "rate_limited" } });
        return;
      }

      const ttlMs = Date.now() + FREE_TTL_DAYS * 86_400_000;
      this.room = {
        isInitialized: true,
        roomId: crypto.randomUUID(),
        tier: "free",
        ttlExpiresAtMs: ttlMs,
        createdAtMs: Date.now(),
        everMessaged: false,
        extensionCount: 0,
        accessRecords: [{ accessHash, failedAttempts: 0, lockedUntilMs: null }],
        currentMessage: null,
      };
      await this.persist();
      await this.state.storage.setAlarm(ttlMs);
      void incrementActiveRooms(this.env.DB, "free");
      // Telemetry: steg-number country (client-derived) + CF-IPCountry.
      enqueueMetric(this.env.METRICS_QUEUE, "room_free", {
        stegCountry: evt.data.country_iso ?? "",
        cfCountry,
      });
      enqueueMetric(this.env.METRICS_QUEUE, "activity_hour", { dim: utcHour(Date.now()) });

      ws.serializeAttachment({
        joined: true,
        senderHash,
        accessHash,
        cfCountry,
        stegCountry: evt.data.country_iso ?? "",
      } satisfies WsAttachment);
      await this.padJoin(start);
      this.send(ws, {
        ref: evt.ref,
        ok: {
          room_id: this.room.roomId,
          ttl_expires_at: new Date(this.room.ttlExpiresAtMs).toISOString(),
        },
      });
      return;
    }

    // Existing room — check access.
    // Guard second-slot registration: if the room has only one access record
    // and this access_hash is new, the caller is claiming the second-party
    // slot. Rate-limit this the same way we rate-limit room creation to
    // prevent an attacker who knows the room_hash from pre-empting the slot
    // before the legitimate second party joins.
    if (
      this.room.accessRecords.length < 2 &&
      !this.room.accessRecords.find((r) => r.accessHash === accessHash)
    ) {
      const rl = await this.env.RATE_LIMITER_ROOM_CREATE.limit({ key: this.clientIp }).catch(
        () => ({ success: true }),
      );
      if (!rl.success) {
        enqueueMetric(this.env.METRICS_QUEUE, "join_rate_limited", { dim: "slot" });
        await this.padJoin(start);
        this.send(ws, { ref: evt.ref, error: { reason: "rate_limited" } });
        return;
      }
    }
    // Snapshot the slot count so we can tell a genuine second-party join
    // (1 → 2 records) apart from a returning party. NOTE: the protocol is
    // zero-knowledge here — a wrong PIN while the 2nd slot is still open
    // also registers as a join, so second_party_joined counts "distinct
    // access credentials registered", the best the server can know.
    const recordsBefore = this.room.accessRecords.length;
    const result = this.checkAccess(accessHash);
    if (result.kind === "ok") {
      await this.persist();
      const secondPartyJoined = recordsBefore === 1 && this.room.accessRecords.length === 2;
      enqueueMetric(
        this.env.METRICS_QUEUE,
        secondPartyJoined ? "second_party_joined" : "room_rejoin",
        { stegCountry: evt.data.country_iso ?? "", cfCountry },
      );
      ws.serializeAttachment({
        joined: true,
        senderHash,
        accessHash,
        cfCountry,
        stegCountry: evt.data.country_iso ?? "",
      } satisfies WsAttachment);
      await this.padJoin(start);
      const reply: { room_id: string; current_message?: MessagePayload; ttl_expires_at: string } = {
        room_id: this.room.roomId,
        ttl_expires_at: new Date(this.room.ttlExpiresAtMs).toISOString(),
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

    // First message ever in this room → record time-to-first-message
    // (seconds from creation), then latch everMessaged so it fires once.
    const isFirstMessage = !this.room.everMessaged;
    this.room.currentMessage = message;
    if (isFirstMessage) this.room.everMessaged = true;
    await this.persist();

    enqueueMetric(this.env.METRICS_QUEUE, "message_sent", {
      stegCountry: att.stegCountry ?? "",
      cfCountry: att.cfCountry ?? "",
    });
    enqueueMetric(this.env.METRICS_QUEUE, "activity_hour", { dim: utcHour(message.insertedAtMs) });
    if (isFirstMessage) {
      const ttfmSeconds = Math.max(0, (message.insertedAtMs - this.room.createdAtMs) / 1000);
      enqueueMetric(this.env.METRICS_QUEUE, "time_to_first_message", {
        stegCountry: att.stegCountry ?? "",
        cfCountry: att.cfCountry ?? "",
        value: ttfmSeconds,
        dim: ttfmBucket(ttfmSeconds),
      });
    }

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
    // Global (no country): the read-receipt handler has no attachment in scope.
    enqueueMetric(this.env.METRICS_QUEUE, "message_read");
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
    enqueueMetric(this.env.METRICS_QUEUE, "message_edited", {
      stegCountry: att.stegCountry ?? "",
      cfCountry: att.cfCountry ?? "",
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
    enqueueMetric(this.env.METRICS_QUEUE, "message_deleted", {
      stegCountry: att.stegCountry ?? "",
      cfCountry: att.cfCountry ?? "",
    });
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

    if (this.room) void decrementActiveRooms(this.env.DB, this.room.tier);
    if (this.room) this.emitExpiry(this.room);
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
      enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "no_room" });
      this.send(ws, { ref: evt.ref, error: { reason: "not_found" } });
      return;
    }

    const secret = evt.data.extension_secret;
    if (typeof secret !== "string" || secret.length === 0) {
      enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "invalid_token" });
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    // Reconstitute the server-side token_hash from the client's secret.
    const tokenHash = await sha256hex(secret);

    const token = await findByTokenHash(this.env.DB, tokenHash);
    if (!token) {
      enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "invalid_token" });
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    if (token.status === "pending") {
      // Proactive verification fallback: if the webhook hasn't arrived
      // yet, check directly with Paystack. This eliminates the race.
      const verified = await verifyTransaction(tokenHash, this.env);
      if (verified) {
        // Transaction confirmed! Mark it paid in D1 immediately.
        await markPaid(this.env.DB, tokenHash, "proactive_verify");
        // Proceed with the local check as if it were already paid.
        token.status = "paid";
      } else {
        enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "payment_pending" });
        this.send(ws, { ref: evt.ref, error: { reason: "payment_pending" } });
        return;
      }
    }

    if (token.status !== "paid") {
      // Already redeemed or expired/deleted.
      enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "invalid_token" });
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    const changed = await markRedeemed(this.env.DB, tokenHash);
    if (changed === 0) {
      // Race: another connection redeemed it between our findByTokenHash
      // and markRedeemed. Treat as invalid.
      enqueueMetric(this.env.METRICS_QUEUE, "redeem_failed", { dim: "invalid_token" });
      this.send(ws, { ref: evt.ref, error: { reason: "invalid_token" } });
      return;
    }

    // Delete the token row immediately after redemption so a redeemed
    // token's redeemed_at timestamp does not sit in D1 for up to 30 days
    // until the daily sweep. Closing this linkability window is the same
    // privacy goal as v1's separate-transaction design.
    await deleteToken(this.env.DB, tokenHash);

    // Extend the room's TTL and reschedule its self-destruct alarm.
    // Stack the extension on top of any remaining time rather than resetting
    // the clock to now: a user who pre-extends an active channel paid for
    // additional time, so PAID_TTL_DAYS is added to whichever is later — the
    // current expiry or now (the latter wins only if the room already lapsed).
    // Floor to the hour (v1 `round_to_hour/1`) so the exact redemption
    // moment is not encoded in ttl_expires_at. A server operator with
    // D1 + DO access cannot pinpoint redemption time from the expiry.
    const base = Math.max(Date.now(), this.room.ttlExpiresAtMs);
    const newTtlRaw = base + PAID_TTL_DAYS * 86_400_000;
    const newTtlMs = Math.floor(newTtlRaw / 3_600_000) * 3_600_000;

    // v1 slept 0–5000ms (jitter_sleep) between the token mark-redeemed
    // and the room TTL update to de-align their updated_at timestamps.
    // In the DO model both writes are in the same request handler; the
    // D1 write (markRedeemed above) and the DO SQLite write (persist
    // below) land in different storage systems at different latencies,
    // giving natural de-alignment without an explicit sleep.
    // Distinguish a first-time conversion (free → paid) from a renewal
    // of an already-paid room. Only the former is a new paid room;
    // counting every redeem as room_paid would inflate "new paid" /
    // "paid rooms" — e.g. one number extended three times would read as
    // three paid rooms instead of one.
    const wasPaid = this.room.tier === "paid";
    const createdAtMs = this.room.createdAtMs;
    this.room.tier = "paid";
    this.room.extensionCount = (this.room.extensionCount ?? 0) + 1;
    this.room.ttlExpiresAtMs = newTtlMs;
    await this.persist();
    await this.state.storage.setAlarm(newTtlMs);
    // First free→paid conversion moves the live tier counter.
    if (!wasPaid) void convertActiveToPaid(this.env.DB);

    // Telemetry: steg-number country + CF-IPCountry (survive hibernation
    // via the WsAttachment). The new-paid vs. renewal split feeds the
    // headline counters; emitPaidSale adds the extension-ordinal retention
    // distribution and the priced-sale / revenue breakdown.
    const att = ws.deserializeAttachment() as WsAttachment | null;
    const iso = evt.data.country_iso ?? att?.stegCountry ?? "";
    const cfCountry = att?.cfCountry ?? "";
    enqueueMetric(this.env.METRICS_QUEUE, wasPaid ? "room_extended" : "room_paid", {
      stegCountry: iso,
      cfCountry,
    });
    this.emitPaidSale(
      { currency: token.currency, amount_cents: token.amount_cents },
      this.room.extensionCount,
      iso,
      cfCountry,
    );
    enqueueMetric(this.env.METRICS_QUEUE, "activity_hour", { dim: utcHour(Date.now()) });
    // First conversion from free → record how long the number stayed free.
    if (!wasPaid) {
      const freeHours = Math.max(0, (Date.now() - createdAtMs) / 3_600_000);
      enqueueMetric(this.env.METRICS_QUEUE, "time_to_paid", {
        stegCountry: iso,
        cfCountry,
        value: freeHours,
        dim: conversionBucket(freeHours),
      });
    }

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
    // Security telemetry — global (no country), fire-and-forget.
    enqueueMetric(this.env.METRICS_QUEUE, "access_failed");
    if (target.failedAttempts >= MAX_ACCESS_ATTEMPTS) {
      target.lockedUntilMs = now + LOCKOUT_MINUTES * 60_000;
      enqueueMetric(this.env.METRICS_QUEUE, "access_lockout");
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
