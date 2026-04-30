// SPDX-License-Identifier: AGPL-3.0-only
//
// Wire protocol shared between the WebSocket client and the room Durable
// Object. Keeping this in one file makes the protocol auditable in a
// single read and lets the client TS bundle import the same types as the
// server.
//
// Ports the Phoenix Channel protocol from
// elixir/lib/stelgano_web/channels/anon_room_channel.ex with one shape
// change: there is no Phoenix-style envelope — events are bare JSON
// objects. Replies are distinguished from broadcasts by the presence of
// `ref` vs. `event` on the top-level object.

// ---------------------------------------------------------------------------
// Constants — must match elixir/lib/stelgano/rooms/room_access.ex and
// elixir/lib/stelgano_web/channels/anon_room_channel.ex.
//
// Changing any of these breaks the security/UX guarantees those modules
// document. Update both sides in lockstep, or document the divergence.
// ---------------------------------------------------------------------------

/** Maximum base64-encoded ciphertext length accepted per message.
 *  Covers up to 4,000 UTF-8 chars of plaintext + AES-GCM overhead. */
export const MAX_CIPHERTEXT_BYTES = 8_192;

/** Failed access attempts before lockout kicks in. */
export const MAX_ACCESS_ATTEMPTS = 10;

/** Lockout duration after MAX_ACCESS_ATTEMPTS failures. */
export const LOCKOUT_MINUTES = 30;

/** Floor on the time spent inside join, in ms. Prevents an attacker from
 *  classifying room_hash values as "exists" vs. "does not exist" by
 *  measuring reply latency. Must be larger than the normal worst-case
 *  inter-branch delta. */
export const JOIN_TIME_FLOOR_MS = 500;

/** Default TTL for free-tier rooms. */
export const FREE_TTL_DAYS = 7;

/** TTL for paid-tier rooms. */
export const PAID_TTL_DAYS = 365;

/** A 64-char lowercase hex string (SHA-256 hex). */
export const HEX64_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Client → Server events
// ---------------------------------------------------------------------------

export type ClientEvent =
  | {
      event: "join";
      ref: string;
      data: {
        sender_hash: string;
        access_hash: string;
        /** ISO-3166 alpha-2 derived client-side from the E.164 steg number
         *  via libphonenumber-js. All legitimate clients always send this
         *  because the UI rejects non-international numbers before submit.
         *  The server treats it as optional for defence-in-depth — older
         *  clients and direct wire tests may omit it. Never stored alongside
         *  any individual room or access record. */
        country_iso?: string;
        /** Raw extension secret (64-char hex) stashed in sessionStorage
         *  before the Paystack redirect. When present on a first join, the
         *  server atomically creates the room as paid and marks the token
         *  redeemed, skipping the separate redeem_extension round-trip.
         *  Ignored when the room already exists or the token is not paid. */
        extension_secret?: string;
      };
    }
  | { event: "send_message"; ref: string; data: { ciphertext: string; iv: string } }
  | { event: "read_receipt"; ref?: string; data: { message_id: string } }
  | {
      event: "edit_message";
      ref: string;
      data: { message_id: string; ciphertext: string; iv: string };
    }
  | { event: "delete_message"; ref: string; data: { message_id: string } }
  | { event: "typing"; ref?: string; data: Record<string, never> }
  | { event: "expire_room"; ref: string; data: Record<string, never> }
  | {
      event: "redeem_extension";
      ref: string;
      data: {
        extension_secret: string;
        /** Optional ISO-3166 alpha-2 derived client-side from
         *  the E.164 phone. Bumps CountryMetrics.paid_rooms. Never
         *  stored alongside any individual room/token. */
        country_iso?: string;
      };
    };

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export type ServerReply =
  | { ref: string; ok: unknown }
  | { ref: string; error: { reason: ErrorReason; attempts_remaining?: number } };

export type ServerBroadcast =
  | { event: "new_message"; data: MessagePayload }
  | { event: "message_read"; data: { message_id: string } }
  | { event: "message_edited"; data: { message_id: string; ciphertext: string; iv: string } }
  | { event: "message_deleted"; data: { message_id: string } }
  | { event: "counterparty_typing"; data: Record<string, never> }
  | { event: "room_expired"; data: Record<string, never> }
  | { event: "ttl_extended"; data: { ttl_expires_at: string } };

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export type MessagePayload = {
  id: string;
  sender_hash: string;
  ciphertext: string; // base64
  iv: string; // base64
  read_at: string | null; // ISO 8601 or null
  inserted_at: string; // ISO 8601
};

export type JoinReply = {
  room_id: string;
  current_message?: MessagePayload;
  /** ISO 8601 timestamp when the room TTL expires. Present on all joins. */
  ttl_expires_at?: string;
};

// ---------------------------------------------------------------------------
// Errors — mirror the v1 reply atoms so client error handling can stay
// stable across the migration.
// ---------------------------------------------------------------------------

export type ErrorReason =
  | "invalid_room"
  | "invalid_sender"
  | "invalid_access"
  | "not_found"
  | "locked"
  | "unauthorized"
  | "not_joined"
  | "not_your_turn"
  | "message_too_large"
  | "invalid_encoding"
  | "send_failed"
  | "not_editable"
  | "not_deletable"
  | "expire_failed"
  | "invalid_token"
  | "payment_pending"
  | "monetization_disabled"
  | "invalid_topic"
  | "internal_error"
  | "rate_limited";
