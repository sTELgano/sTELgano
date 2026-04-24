// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat state machine.
//
// Models the v1 chat_live.ex state machine in plain TypeScript:
//
//   entry → deriving → [new_channel?] → connecting → chat
//                                                    ↓ ↑
//                                                  locked
//                                                    ↓
//                                                  expired (terminal)
//
// The state object is the single source of truth for what the UI
// shows. The view layer (Phase 5d) subscribes via onStateChange()
// and rebuilds the DOM. The state machine itself never touches the
// DOM and never imports from a view module — it's pure data + a
// thin RPC layer over RoomClient + AnonCrypto.
//
// Side effects (network, crypto, sessionStorage) happen inside the
// async action methods. Each action is the v1 equivalent of a
// handle_event clause and produces 0+ setState() calls before
// resolving.

import {
  type ProgressCallback,
  accessHash as deriveAccessHash,
  decrypt,
  deriveKeyInWorker,
  encrypt,
  fromBase64,
  normalise,
  roomHash as deriveRoomHash,
  senderHash as deriveSenderHash,
  toBase64,
} from "./crypto/anon";
import { RoomClient, type RoomClientError } from "./room_client";
import { type MessagePayload } from "../protocol";

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/** Decrypted message visible to the UI. ciphertext + iv are kept so
 *  edit/delete can re-validate ownership, and so the displayed text
 *  can be re-rendered without holding a DOM reference. */
export type PlainMessage = {
  id: string;
  senderHash: string;
  plaintext: string;
  /** ISO timestamp the server stamped at insert. */
  insertedAt: string;
  /** ISO timestamp when the recipient marked it read, or null. */
  readAt: string | null;
};

export type State =
  /** Initial. Form is empty (or the phone is pre-populated from
   *  sessionStorage / generator drawer / handoff). */
  | {
      kind: "entry";
      /** True when the phone field was set by the generator drawer
       *  or the post-payment handoff — UI renders it read-only. */
      phoneLocked: boolean;
      /** Pre-populated phone, or "" when blank. */
      phone: string;
      /** Eye-toggle state for the phone field. v1 default: false
       *  (password-style masking). */
      phoneVisible: boolean;
      /** Error banner copy (e.g. "Wrong PIN") — null means no
       *  banner. Cleared on next submit. */
      error: string | null;
      /** When error is a failed-auth, how many attempts remain
       *  before the 30-minute lockout. */
      attemptsRemaining: number | null;
    }
  /** PBKDF2 in flight. The 600k iterations take ~1.5–2.5s. */
  | {
      kind: "deriving";
      phone: string;
      pin: string;
      /** 0–100; updated by the worker. */
      progress: number;
    }
  /** Monetization-on case: room doesn't exist on the server yet, the
   *  user has to pick a tier. Skipped when monetization is off (the
   *  state machine auto-fires continueFree() in that path). */
  | {
      kind: "new_channel";
      phone: string;
      pin: string;
      roomHash: string;
      accessHash: string;
      senderHash: string;
    }
  /** Opening the WebSocket and joining. Brief — under a second
   *  typically. */
  | { kind: "connecting"; phone: string }
  /** The chat surface. */
  | {
      kind: "chat";
      phone: string;
      senderHash: string;
      /** N=1: at most one. */
      current: PlainMessage | null;
      /** True iff the OTHER party is composing. UI shows the
       *  indicator; resets on next state change. */
      counterpartyTyping: boolean;
      /** Inline edit of own message. The edit textarea is
       *  uncontrolled — the initial value comes from
       *  current.plaintext at the moment startEdit() is called, and
       *  saveEdit(text) reads the textarea's DOM value directly.
       *  Keeps the textarea focus stable across renders. */
      editing: boolean;
      /** Destruction modal: renders over the chat when true. */
      confirmExpire: boolean;
    }
  /** Wrong PIN OR 30-min lockout. PIN re-entry only — phone stays
   *  the same. Splits from v1 into two sub-flows keyed by `reason`. */
  | {
      kind: "locked";
      phone: string;
      reason: "unauthorized" | "locked";
      attemptsRemaining?: number;
      /** Error copy for a failed unlock attempt, e.g. "Wrong PIN". */
      lockError: string | null;
      /** Number of pips shown in v1's corner — how many failed
       *  attempts so far in this lock session. */
      lockAttempts: number;
    }
  /** Terminal. Room TTL hit, expire_room fired, or connection
   *  bounced after expiry. */
  | { kind: "expired" };

// ---------------------------------------------------------------------------
// SessionStorage keys (cleared on logout / panic / room expiry)
// ---------------------------------------------------------------------------

const STORAGE_KEYS = [
  "stelegano_phone",
  "stelegano_room_hash",
  "stelegano_sender_hash",
  "stelegano_access_hash",
  "stelegano_extension_secret",
  "stelegano_handoff_phone",
  "stelegano_handoff_tier",
] as const;

function clearSession() {
  try {
    for (const k of STORAGE_KEYS) sessionStorage.removeItem(k);
  } catch {
    // sessionStorage may be disabled
  }
}

function readHandoffPhone(): string {
  try {
    const v = sessionStorage.getItem("stelegano_handoff_phone");
    if (v) sessionStorage.removeItem("stelegano_handoff_phone");
    return v ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// ChatState
// ---------------------------------------------------------------------------

export class ChatState {
  private state: State;
  private readonly listeners: Array<(s: State) => void> = [];

  // Side-effect-y handles, NOT part of the public State (so the view
  // doesn't accidentally consume them and bypass the action API).
  private client: RoomClient | null = null;
  private key: CryptoKey | null = null;
  /** Used for re-deriving on locked → re-enter without re-typing. */
  private cachedHashes: {
    phone: string;
    roomHash: string;
    accessHash: string;
    senderHash: string;
  } | null = null;

  constructor() {
    // On mount, check for the post-payment handoff. If present, the
    // user is returning from Paystack and we pre-populate the phone
    // (and lock the field) so they don't retype it.
    const handoff = readHandoffPhone();
    this.state = {
      kind: "entry",
      phoneLocked: !!handoff,
      phone: handoff,
      phoneVisible: false,
      error: null,
      attemptsRemaining: null,
    };
  }

  private initialEntry(phone = "", phoneLocked = false): Extract<State, { kind: "entry" }> {
    return {
      kind: "entry",
      phoneLocked,
      phone,
      phoneVisible: false,
      error: null,
      attemptsRemaining: null,
    };
  }

  // -------------------------------------------------------------------------
  // Subscription API (used by the view layer)
  // -------------------------------------------------------------------------

  getState(): State {
    return this.state;
  }

  onStateChange(fn: (s: State) => void): () => void {
    this.listeners.push(fn);
    fn(this.state);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  private setState(s: State): void {
    this.state = s;
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        // never let a listener crash kill the state machine
      }
    }
  }

  // -------------------------------------------------------------------------
  // Action: submit the entry form
  // -------------------------------------------------------------------------

  /** Validates inputs, derives the room/access/sender hashes,
   *  derives the AES key (PBKDF2, off-thread), opens the WS, joins.
   *  Routes to new_channel/connecting/chat/locked based on the join
   *  reply. */
  async submit(phone: string, pin: string): Promise<void> {
    const normalisedPhone = normalise(phone);
    if (!normalisedPhone || !pin) return; // silently ignore — UI validates first

    // Phase 1: derive identifiers (instant — three SHA-256 calls).
    // room_hash and access_hash can derive in parallel; sender_hash
    // depends on both so waits.
    const [roomHash, accessHash] = await Promise.all([
      deriveRoomHash(normalisedPhone),
      deriveAccessHash(normalisedPhone, pin),
    ]);
    const senderHash = await deriveSenderHash(normalisedPhone, accessHash, roomHash);

    this.cachedHashes = {
      phone: normalisedPhone,
      roomHash,
      accessHash,
      senderHash,
    };

    // Phase 2: PBKDF2 (slow). Visualise progress.
    this.setState({ kind: "deriving", phone: normalisedPhone, pin, progress: 0 });

    const onProgress: ProgressCallback = (percent) => {
      // Only update if we haven't been thrown off this state by a
      // panic / cancel.
      if (this.state.kind === "deriving") {
        this.setState({ ...this.state, progress: percent });
      }
    };

    try {
      // We use the room_hash as the room_id for PBKDF2 salt — both
      // parties derive it identically from the phone number, so they
      // arrive at the same key.
      this.key = await deriveKeyInWorker(normalisedPhone, roomHash, onProgress);
    } catch {
      // Crypto failure — usually means the browser blocks Web Crypto
      // (very old browsers). Drop back to entry.
      this.setState(this.initialEntry(phone, false));
      return;
    }

    // Phase 3: connect + join.
    await this.connectAndJoin(normalisedPhone, roomHash, accessHash, senderHash);
  }

  // -------------------------------------------------------------------------
  // Action: locked → re-enter PIN (re-derive without re-typing phone)
  // -------------------------------------------------------------------------

  async reauthenticate(pin: string): Promise<void> {
    if (this.state.kind !== "locked") return;
    const phone = this.state.phone;
    await this.submit(phone, pin);
  }

  // -------------------------------------------------------------------------
  // Action: free-tier confirm on the new_channel screen
  //
  // Phase 7 (Paystack) will add `initiatePayment` for the paid path.
  // For now the state machine treats new_channel as a one-button
  // confirm — both v1 monetization-off and the "Continue Free" click
  // route through here.
  // -------------------------------------------------------------------------

  async continueFree(): Promise<void> {
    if (this.state.kind !== "new_channel") return;
    const { phone, roomHash, accessHash, senderHash } = this.state;
    await this.connectAndJoin(phone, roomHash, accessHash, senderHash);
  }

  // -------------------------------------------------------------------------
  // Action: send a message
  // -------------------------------------------------------------------------

  async sendMessage(plaintext: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.key || !this.client) return;
    const trimmed = plaintext.trim();
    if (!trimmed) return;

    // Turn-based input enforcement (mirrors v1 can_type?/4): only
    // type if the room is empty or the last message is from the
    // other party. The state.current check covers it; the server
    // also enforces via :sender_blocked in case of races.
    if (this.state.current && this.state.current.senderHash === this.state.senderHash) {
      return;
    }

    const { iv, ciphertext } = await encrypt(this.key, trimmed);
    try {
      await this.client.sendMessage(toBase64(ciphertext), toBase64(iv));
      // The DO broadcasts new_message back to us too (matches v1 —
      // server pushes to sender first then broadcasts). The
      // onNewMessage listener installed in connectAndJoin updates
      // state.current. No-op here.
    } catch (err) {
      const e = err as RoomClientError;
      if (e.reason === "not_your_turn") return; // benign race
      // Other errors are silent for now; Phase 5d may surface them.
    }
  }

  /** Marks the current message as read. Idempotent — server returns
   *  no reply on duplicate. */
  markCurrentRead(): void {
    if (this.state.kind !== "chat") return;
    const m = this.state.current;
    if (!m || m.readAt) return;
    if (m.senderHash === this.state.senderHash) return; // can't read your own
    this.client?.markRead(m.id);
  }

  /** Edit the current message (only if it's ours and unread). */
  async editCurrent(newPlaintext: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.key || !this.client) return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    const trimmed = newPlaintext.trim();
    if (!trimmed) return;

    const { iv, ciphertext } = await encrypt(this.key, trimmed);
    try {
      await this.client.editMessage(m.id, toBase64(ciphertext), toBase64(iv));
      // The DO broadcasts message_edited back to us; listener
      // updates state.current.
    } catch {
      // silent
    }
  }

  /** Delete the current message (only if it's ours and unread). */
  async deleteCurrent(): Promise<void> {
    if (this.state.kind !== "chat" || !this.client) return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    try {
      await this.client.deleteMessage(m.id);
    } catch {
      // silent
    }
  }

  /** Fire-and-forget typing indicator. */
  typing(): void {
    if (this.state.kind !== "chat") return;
    this.client?.typing();
  }

  /** Manually expire the room. Terminal action. */
  async expireRoom(): Promise<void> {
    if (this.state.kind !== "chat" || !this.client) return;
    try {
      await this.client.expireRoom();
    } catch {
      // ignore
    }
    // The DO broadcasts room_expired then closes; listener handles
    // the state transition.
  }

  /** User-initiated logout. Closes the socket and wipes session
   *  storage. The view layer typically navigates to / after this. */
  logout(): void {
    this.client?.close(1000, "logout");
    this.client = null;
    this.key = null;
    this.cachedHashes = null;
    clearSession();
    this.setState(this.initialEntry());
  }

  /** Lock the chat without destroying session data. Drops the
   *  encryption key from memory (re-derived on unlock) but keeps
   *  the phone + hashes + socket so unlock is fast. v1
   *  `lock_chat`. */
  lockChat(): void {
    if (this.state.kind !== "chat") return;
    const phone = this.state.phone;
    this.key = null;
    this.client?.close(1000, "lock");
    this.client = null;
    this.setState({
      kind: "locked",
      phone,
      reason: "unauthorized",
      attemptsRemaining: undefined,
      lockError: null,
      lockAttempts: 0,
    });
  }

  /** Wipe all session data and return to the blank entry form.
   *  v1 `clear_session`. Used from the locked screen's "Erase All"
   *  button. */
  clearSession(): void {
    this.logout();
  }

  /** Toggle password-masking of the phone field on entry. */
  togglePhoneVisibility(): void {
    if (this.state.kind !== "entry") return;
    this.setState({ ...this.state, phoneVisible: !this.state.phoneVisible });
  }

  /** Enter inline-edit mode for the current (own, unread) message. */
  startEdit(): void {
    if (this.state.kind !== "chat") return;
    const m = this.state.current;
    if (!m || m.senderHash !== this.state.senderHash || m.readAt) return;
    this.setState({ ...this.state, editing: true });
  }

  /** Cancel inline edit. */
  cancelEdit(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, editing: false });
  }

  /** Save the edited message. The caller reads the textarea's DOM
   *  value and passes it in. Clears editing regardless of success
   *  (matches v1 — the edit form dismisses even if the send fails;
   *  the server's broadcast is the source of truth for the final
   *  text). */
  async saveEdit(text: string): Promise<void> {
    if (this.state.kind !== "chat" || !this.state.editing) return;
    this.setState({ ...this.state, editing: false });
    await this.editCurrent(text);
  }

  /** Show the "nuclear wipe" confirmation modal. */
  confirmExpireShow(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, confirmExpire: true });
  }

  /** Dismiss the "nuclear wipe" confirmation modal. */
  confirmExpireHide(): void {
    if (this.state.kind !== "chat") return;
    this.setState({ ...this.state, confirmExpire: false });
  }

  // -------------------------------------------------------------------------
  // Internal: open WS, send join, route by reply
  // -------------------------------------------------------------------------

  private async connectAndJoin(
    phone: string,
    roomHash: string,
    accessHash: string,
    senderHash: string,
  ): Promise<void> {
    this.setState({ kind: "connecting", phone });

    // Tear down any previous client (locked → reauthenticate path).
    this.client?.close();
    this.client = new RoomClient(roomHash, {
      onNewMessage: (msg) => this.onNewMessage(msg),
      onMessageRead: (id) => this.onMessageRead(id),
      onMessageEdited: (data) => this.onMessageEdited(data),
      onMessageDeleted: (id) => this.onMessageDeleted(id),
      onCounterpartyTyping: () => this.onCounterpartyTyping(),
      onRoomExpired: () => this.onRoomExpired(),
      onClose: (code) => this.onSocketClose(code),
    });

    try {
      await this.client.open();
    } catch {
      // Couldn't open WS — drop to entry. (Phase 5d UI may show an
      // error toast.)
      this.client = null;
      this.setState(this.initialEntry(phone, false));
      return;
    }

    let joinReply;
    try {
      joinReply = await this.client.join(senderHash, accessHash);
    } catch (err) {
      const e = err as RoomClientError;
      if (e.reason === "locked" || e.reason === "unauthorized") {
        // If we came from :locked state already, preserve
        // lockAttempts + bump it. Otherwise start at 1.
        const prevAttempts = this.state.kind === "locked" ? this.state.lockAttempts : 0;
        this.setState({
          kind: "locked",
          phone,
          reason: e.reason,
          attemptsRemaining: e.attempts_remaining,
          lockError:
            e.reason === "locked"
              ? "LOCKOUT ACTIVE · 30 MIN"
              : "INVALID PIN",
          lockAttempts: prevAttempts + 1,
        });
        return;
      }
      // not_found / invalid_* / internal_error → back to entry with
      // an error banner so the user sees what happened.
      this.client?.close();
      this.client = null;
      const entry = this.initialEntry(phone, false);
      entry.error =
        e.reason === "not_found"
          ? "No active channel for that number."
          : "Connection failed. Try again.";
      this.setState(entry);
      return;
    }

    // Persist enough to survive a panic-and-restore cycle.
    try {
      sessionStorage.setItem("stelegano_phone", phone);
      sessionStorage.setItem("stelegano_room_hash", roomHash);
      sessionStorage.setItem("stelegano_access_hash", accessHash);
      sessionStorage.setItem("stelegano_sender_hash", senderHash);
    } catch {
      // sessionStorage disabled — ignore
    }

    // Decrypt the current message if one was returned.
    let current: PlainMessage | null = null;
    if (joinReply.current_message) {
      current = await this.tryDecrypt(joinReply.current_message);
    }

    this.setState({
      kind: "chat",
      phone,
      senderHash,
      current,
      counterpartyTyping: false,
      editing: false,
      confirmExpire: false,
    });
  }

  // -------------------------------------------------------------------------
  // Broadcast handlers (installed in connectAndJoin)
  // -------------------------------------------------------------------------

  private async onNewMessage(msg: MessagePayload): Promise<void> {
    if (this.state.kind !== "chat") return;
    const decrypted = await this.tryDecrypt(msg);
    if (!decrypted) return;
    this.setState({ ...this.state, current: decrypted, counterpartyTyping: false });
  }

  private onMessageRead(messageId: string): void {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== messageId) return;
    this.setState({
      ...this.state,
      current: { ...this.state.current, readAt: new Date().toISOString() },
    });
  }

  private async onMessageEdited(data: {
    message_id: string;
    ciphertext: string;
    iv: string;
  }): Promise<void> {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== data.message_id) return;
    const ct = fromBase64(data.ciphertext);
    const iv = fromBase64(data.iv);
    let plaintext: string;
    try {
      plaintext = await decrypt(this.key!, iv, ct);
    } catch {
      return; // can't decrypt — ignore the edit
    }
    this.setState({
      ...this.state,
      current: { ...this.state.current, plaintext },
    });
  }

  private onMessageDeleted(messageId: string): void {
    if (this.state.kind !== "chat") return;
    if (!this.state.current || this.state.current.id !== messageId) return;
    this.setState({ ...this.state, current: null, counterpartyTyping: false });
  }

  private onCounterpartyTyping(): void {
    if (this.state.kind !== "chat") return;
    if (this.state.counterpartyTyping) return;
    this.setState({ ...this.state, counterpartyTyping: true });
    // Auto-clear after a bit so the indicator doesn't stick if the
    // other party stops typing without sending.
    setTimeout(() => {
      if (this.state.kind === "chat" && this.state.counterpartyTyping) {
        this.setState({ ...this.state, counterpartyTyping: false });
      }
    }, 3000);
  }

  private onRoomExpired(): void {
    this.client?.close();
    this.client = null;
    this.key = null;
    this.cachedHashes = null;
    clearSession();
    this.setState({ kind: "expired" });
  }

  private onSocketClose(code: number): void {
    // 1000 = normal (we initiated). Ignore — the action that closed
    // it has already set the appropriate state.
    if (code === 1000) return;
    // Unclean close — drop to entry. User can retry.
    if (this.state.kind === "chat" || this.state.kind === "connecting") {
      this.client = null;
      const entry = this.initialEntry(this.cachedHashes?.phone ?? "", false);
      entry.error = "Connection lost. Reconnect to continue.";
      this.setState(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: decrypt a wire-format MessagePayload to a PlainMessage
  // -------------------------------------------------------------------------

  private async tryDecrypt(msg: MessagePayload): Promise<PlainMessage | null> {
    if (!this.key) return null;
    try {
      const ct = fromBase64(msg.ciphertext);
      const iv = fromBase64(msg.iv);
      const plaintext = await decrypt(this.key, iv, ct);
      return {
        id: msg.id,
        senderHash: msg.sender_hash,
        plaintext,
        insertedAt: msg.inserted_at,
        readAt: msg.read_at,
      };
    } catch {
      // Decryption failed — wrong key, tampered ciphertext, or a
      // protocol mismatch. Caller treats this as "no message".
      return null;
    }
  }
}
