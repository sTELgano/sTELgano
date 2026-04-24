// SPDX-License-Identifier: AGPL-3.0-only
//
// RoomClient — typed WebSocket client for the room Durable Object.
//
// Wraps the wire protocol from src/protocol.ts in a Promise-based
// API. Replies are correlated via per-event refs (auto-incrementing
// integers serialised as strings); broadcasts are dispatched to
// event-name listeners.
//
// One RoomClient instance per chat session. Closes its socket when
// the user logs out, panics, or the room expires.
//
// The client is deliberately stateless about chat semantics — it
// neither remembers messages nor tracks the room's current state.
// The state machine layer (Phase 5c) layers that on top.

import {
  type ClientEvent,
  type ErrorReason,
  type JoinReply,
  type MessagePayload,
  type ServerBroadcast,
  type ServerReply,
} from "../protocol";

export type RoomClientError = {
  reason: ErrorReason;
  attempts_remaining?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: RoomClientError) => void;
};

export type Listeners = {
  onNewMessage?: (msg: MessagePayload) => void;
  onMessageRead?: (messageId: string) => void;
  onMessageEdited?: (data: { message_id: string; ciphertext: string; iv: string }) => void;
  onMessageDeleted?: (messageId: string) => void;
  onCounterpartyTyping?: () => void;
  onRoomExpired?: () => void;
  onTtlExtended?: (ttlExpiresAt: string) => void;

  /** Underlying socket closed (clean or unclean). Code 1000 = normal. */
  onClose?: (code: number, reason: string) => void;

  /** Generic transport error (parse failure, socket error). */
  onTransportError?: (err: unknown) => void;
};

export class RoomClient {
  private readonly url: string;
  private readonly listeners: Listeners;

  private ws: WebSocket | null = null;
  private nextRef = 1;
  private readonly pending = new Map<string, Pending>();

  /** Reverse-engineerable origin so the static chat shell (served
   *  from / on the same host) can construct ws://host/room/.../ws or
   *  wss://host/room/.../ws automatically. */
  constructor(roomHash: string, listeners: Listeners = {}) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${location.host}/room/${roomHash}/ws`;
    this.listeners = listeners;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Opens the WebSocket and waits for it to be OPEN. Does NOT send
   *  the join event — call `join()` next. Splitting open + join
   *  lets the caller layer error handling around each step. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      const onOpen = () => {
        this.ws!.removeEventListener("open", onOpen);
        this.ws!.removeEventListener("error", onError);
        this.attachHandlers();
        resolve();
      };

      const onError = () => {
        this.ws!.removeEventListener("open", onOpen);
        this.ws!.removeEventListener("error", onError);
        reject(new Error("websocket failed to open"));
      };

      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });
  }

  /** Sends the `join` event as the first message and awaits its
   *  reply. Resolves with the join payload (room_id, optional
   *  current_message). Rejects with RoomClientError on locked /
   *  unauthorized / not_found / invalid_*. */
  join(senderHash: string, accessHash: string): Promise<JoinReply> {
    return this.request<JoinReply>("join", { sender_hash: senderHash, access_hash: accessHash });
  }

  /** Closes the socket cleanly. After this, no further events fire. */
  close(code = 1000, reason = "client_close"): void {
    try {
      this.ws?.close(code, reason);
    } catch {
      // already closed
    }
    this.ws = null;
    // Reject any in-flight requests so callers don't hang.
    for (const p of this.pending.values()) {
      p.reject({ reason: "internal_error" });
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // RPC-style operations (await reply via ref)
  // -------------------------------------------------------------------------

  sendMessage(ciphertextB64: string, ivB64: string): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>("send_message", {
      ciphertext: ciphertextB64,
      iv: ivB64,
    });
  }

  editMessage(
    messageId: string,
    ciphertextB64: string,
    ivB64: string,
  ): Promise<Record<string, never>> {
    return this.request<Record<string, never>>("edit_message", {
      message_id: messageId,
      ciphertext: ciphertextB64,
      iv: ivB64,
    });
  }

  deleteMessage(messageId: string): Promise<Record<string, never>> {
    return this.request<Record<string, never>>("delete_message", {
      message_id: messageId,
    });
  }

  expireRoom(): Promise<Record<string, never>> {
    return this.request<Record<string, never>>("expire_room", {});
  }

  // -------------------------------------------------------------------------
  // Fire-and-forget operations (no reply awaited)
  // -------------------------------------------------------------------------

  /** Read receipt is intentionally fire-and-forget on v1 (mirrors
   *  Phoenix Channel `:noreply`). Server still broadcasts to all
   *  connected sockets; the sender's listener fires too. */
  markRead(messageId: string): void {
    this.send({ event: "read_receipt", data: { message_id: messageId } });
  }

  /** Typing indicator — broadcast-only, never awaits a reply. */
  typing(): void {
    this.send({ event: "typing", data: {} });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private request<T>(event: ClientEvent["event"], data: object): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject({ reason: "internal_error" } satisfies RoomClientError);
        return;
      }
      const ref = String(this.nextRef++);
      this.pending.set(ref, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.send({ event, ref, data } as unknown as ClientEvent);
    });
  }

  private send(payload: object): void {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (err) {
      this.listeners.onTransportError?.(err);
    }
  }

  private attachHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener("message", (e: MessageEvent) => {
      let data: ServerReply | ServerBroadcast;
      try {
        data = JSON.parse(typeof e.data === "string" ? e.data : "") as
          | ServerReply
          | ServerBroadcast;
      } catch (err) {
        this.listeners.onTransportError?.(err);
        return;
      }

      // Reply: has `ref`. Broadcast: has `event`. They're disjoint.
      if ("ref" in data) {
        const pending = this.pending.get(data.ref);
        if (!pending) return; // late reply for an aborted request
        this.pending.delete(data.ref);
        if ("ok" in data) {
          pending.resolve(data.ok);
        } else if ("error" in data) {
          pending.reject(data.error);
        }
      } else if ("event" in data) {
        this.dispatchBroadcast(data);
      }
    });

    this.ws.addEventListener("error", (err) => {
      this.listeners.onTransportError?.(err);
    });

    this.ws.addEventListener("close", (e: CloseEvent) => {
      // Reject any still-pending requests so the UI doesn't hang.
      for (const p of this.pending.values()) {
        p.reject({ reason: "internal_error" });
      }
      this.pending.clear();
      this.listeners.onClose?.(e.code, e.reason);
    });
  }

  private dispatchBroadcast(b: ServerBroadcast): void {
    switch (b.event) {
      case "new_message":
        this.listeners.onNewMessage?.(b.data);
        break;
      case "message_read":
        this.listeners.onMessageRead?.(b.data.message_id);
        break;
      case "message_edited":
        this.listeners.onMessageEdited?.(b.data);
        break;
      case "message_deleted":
        this.listeners.onMessageDeleted?.(b.data.message_id);
        break;
      case "counterparty_typing":
        this.listeners.onCounterpartyTyping?.();
        break;
      case "room_expired":
        this.listeners.onRoomExpired?.();
        break;
      case "ttl_extended":
        this.listeners.onTtlExtended?.(b.data.ttl_expires_at);
        break;
      default: {
        const _exhaustive: never = b;
        void _exhaustive;
      }
    }
  }

  /** Send a redeem_extension event. ref-based reply resolves with
   *  { ttl_expires_at } on success; rejects with invalid_token /
   *  monetization_disabled / not_found otherwise. */
  redeemExtension(
    extensionSecret: string,
    countryIso?: string,
  ): Promise<{ ttl_expires_at: string }> {
    const data: { extension_secret: string; country_iso?: string } = {
      extension_secret: extensionSecret,
    };
    if (countryIso) data.country_iso = countryIso;
    return this.request<{ ttl_expires_at: string }>("redeem_extension", data);
  }
}
