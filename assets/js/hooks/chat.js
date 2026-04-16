// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @fileoverview chat.js — LiveView hooks for the sTELgano chat interface.
 *
 * Consolidated hook architecture matching the production design:
 *
 * - AnonChat         — main orchestrator: entry → channel join → messaging
 * - AutoResize       — auto-growing textarea
 * - IntersectionReader — read receipts via viewport observation
 * - ThemeToggle      — light/dark theme toggle
 * - PhoneGenerator   — steg number generation with country selector (phone-number-generator-js)
 */

"use strict";

import { AnonCrypto } from "../crypto/anon.js";
import { generatePhoneNumber, CountryNames } from "phone-number-generator-js";
import { Socket } from "phoenix";

// ---------------------------------------------------------------------------
// Module-level state (mutable closure singletons)
// ---------------------------------------------------------------------------

/** Derived AES-256-GCM CryptoKey (JS memory only, never serialised). */
let encKey = null;

/** Phoenix Socket for the anonymous room channel. */
let socket = null;

/** Active Phoenix Channel instance. */
let channel = null;

// ---------------------------------------------------------------------------
// AutoResize hook — auto-growing textarea
// ---------------------------------------------------------------------------

export const AutoResize = {
  mounted() {
    this.resize();
    this.el.addEventListener("input", () => this.resize());
  },

  resize() {
    this.el.style.height = "auto";
    this.el.style.height = Math.min(this.el.scrollHeight, 140) + "px";
  },
};

// ---------------------------------------------------------------------------
// IntersectionReader hook — read receipts via viewport observation
// ---------------------------------------------------------------------------

export const IntersectionReader = {
  mounted() {
    const messageId = this.el.dataset.messageId;
    if (!messageId) return;

    let dwellTimer = null;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            dwellTimer = setTimeout(() => {
              this.pushEvent("read_receipt_js", { message_id: messageId });
              observer.disconnect();
            }, 500); // 500ms dwell before read receipt fires
          } else {
            clearTimeout(dwellTimer);
          }
        });
      },
      { threshold: 0.8 } // 80% visible threshold
    );

    observer.observe(this.el);
    this.cleanup = () => {
      observer.disconnect();
      clearTimeout(dwellTimer);
    };
  },

  destroyed() {
    if (this.cleanup) this.cleanup();
  },
};

// ---------------------------------------------------------------------------
// AnonChat hook — main orchestrator
// ---------------------------------------------------------------------------

export const AnonChat = {
  mounted() {
    this.boundHandleServerEvent = this.handleServerEvent.bind(this);

    // Server → Client event listeners
    this.handleEvent("channel_join", this.boundHandleServerEvent);
    this.handleEvent("send_encrypted", () => this.sendEncrypted());
    this.handleEvent("send_encrypted_trigger", () => this.sendEncrypted());
    this.handleEvent("disconnect_channel", () => this.disconnectChannel());
    this.handleEvent("rederive_key", ({ room_id, pin }) => this.rederiveKey(room_id, pin));
    this.handleEvent("read_receipt_js", ({ message_id }) => this.sendReadReceipt(message_id));
    this.handleEvent("channel_join_now", async (data) => await this.joinChannel(data));
    this.handleEvent("expire_room_js", () => this.expireRoom());
    this.handleEvent("edit_message_js", ({ message_id, plaintext }) =>
      this.editMessage(message_id, plaintext)
    );
    this.handleEvent("delete_message_js", ({ message_id }) =>
      this.deleteMessage(message_id)
    );

    // Typing detection on textarea
    this.el.addEventListener("input", (e) => {
      if (e.target?.id === "chat-textarea") this.sendTyping();
    });
  },

  destroyed() {
    this.disconnectChannel();
  },

  // -------------------------------------------------------------------------
  // Entry form → hash computation → server auth
  // -------------------------------------------------------------------------

  async handleServerEvent(data) {
    if (data.action !== "join") return;

    const { phone, pin } = data;
    const rHash = await AnonCrypto.roomHash(phone);
    const aHash = await AnonCrypto.accessHash(phone, pin);
    const sHash = await AnonCrypto.senderHash(phone, aHash, rHash);

    this.pushEvent("channel_authenticate", {
      room_hash: rHash,
      access_hash: aHash,
      sender_hash: sHash,
    });

    this._pendingPhone = phone;
    this._pendingRoomHash = rHash;
    this._pendingSenderHash = sHash;
    sessionSet("stelegano_access_hash", aHash);
  },

  // -------------------------------------------------------------------------
  // Channel join (called after server validates access)
  // -------------------------------------------------------------------------

  async joinChannel({ room_id, sender_hash, room_hash, phone }) {
    this.pushEvent("key_derivation_start", {});
    encKey = await AnonCrypto.deriveKey(phone, room_id);
    this.pushEvent("key_derivation_complete", {});

    // Persist to sessionStorage for lock-screen re-auth
    sessionSet("stelegano_phone", AnonCrypto.normalise(phone));
    sessionSet("stelegano_room_id", room_id);
    sessionSet("stelegano_room_hash", room_hash);
    sessionSet("stelegano_sender_hash", sender_hash);

    socket = new Socket("/anon_socket", {});
    socket.connect();

    channel = socket.channel(`anon_room:${room_hash}`, {
      access_hash: sessionGet("stelegano_access_hash") || "",
      sender_hash,
    });

    this._setupChannelHandlers(sender_hash);

    channel
      .join()
      .receive("ok", (resp) => this._handleJoinOk(resp, sender_hash))
      .receive("error", (err) => this.pushEvent("channel_join_error", err));
  },

  // -------------------------------------------------------------------------
  // Channel event handlers
  // -------------------------------------------------------------------------

  _setupChannelHandlers(mySenderHash) {
    channel.on("new_message", async (payload) => {
      let plaintext;
      try {
        plaintext = await AnonCrypto.decrypt(
          encKey,
          AnonCrypto.fromBase64(payload.iv),
          AnonCrypto.fromBase64(payload.ciphertext)
        );
      } catch (err) {
        console.error("Decryption failed:", err);
        plaintext = "[Unable to decrypt message]";
      }

      const isMine = payload.sender_hash === mySenderHash;
      this.pushEvent("message_received", {
        id: payload.id,
        plaintext,
        sender_hash: payload.sender_hash,
        is_mine: isMine,
        inserted_at: payload.inserted_at,
      });
    });

    channel.on("message_read", (payload) => {
      this.pushEvent("message_read_confirmed", { message_id: payload.message_id });
    });

    channel.on("message_edited", async (payload) => {
      let plaintext;
      try {
        plaintext = await AnonCrypto.decrypt(
          encKey,
          AnonCrypto.fromBase64(payload.iv),
          AnonCrypto.fromBase64(payload.ciphertext)
        );
      } catch {
        plaintext = "[Unable to decrypt edited message]";
      }
      this.pushEvent("message_edit_received", {
        message_id: payload.message_id,
        plaintext,
      });
    });

    channel.on("message_deleted", (payload) => {
      this.pushEvent("message_delete_received", { message_id: payload.message_id });
    });

    channel.on("counterparty_typing", () => {
      this.pushEvent("typing_indicator", {});
    });

    channel.on("room_expired", () => {
      this.pushEvent("room_expired_received", {});
      this.clearSession();
    });
  },

  // -------------------------------------------------------------------------
  // Join OK — existing message decrypted from channel join response
  // -------------------------------------------------------------------------

  async _handleJoinOk(resp, mySenderHash) {
    const { room_id, current_message, ttl_expires_at } = resp;

    if (current_message) {
      let plaintext;
      try {
        plaintext = await AnonCrypto.decrypt(
          encKey,
          AnonCrypto.fromBase64(current_message.iv),
          AnonCrypto.fromBase64(current_message.ciphertext)
        );
      } catch {
        plaintext = "[Unable to decrypt message]";
      }

      const isMine = current_message.sender_hash === mySenderHash;
      this.pushEvent("join_with_message", {
        id: current_message.id,
        plaintext,
        sender_hash: current_message.sender_hash,
        is_mine: isMine,
        read_at: current_message.read_at,
        inserted_at: current_message.inserted_at,
        ttl_expires_at,
      });
    } else {
      this.pushEvent("join_empty", { room_id, ttl_expires_at });
    }
  },

  // -------------------------------------------------------------------------
  // Send message
  // -------------------------------------------------------------------------

  async sendEncrypted() {
    const textarea = document.getElementById("chat-textarea");
    const plaintext = textarea?.value ?? "";
    if (!plaintext.trim()) {
      this.pushEvent("send_error", { reason: "empty_message" });
      return;
    }
    await this.sendMessage(plaintext);
    textarea.value = "";
    this.pushEvent("input_change", { value: "" });
  },

  async sendMessage(plaintext) {
    const { iv, ciphertext } = await AnonCrypto.encrypt(encKey, plaintext);
    const ivB64 = AnonCrypto.toBase64(iv);
    const ctB64 = AnonCrypto.toBase64(ciphertext);

    channel
      .push("send_message", { ciphertext: ctB64, iv: ivB64 })
      .receive("ok", () => {})
      .receive("error", (err) => this.pushEvent("send_error", err))
      .receive("timeout", () => this.pushEvent("send_error", { reason: "timeout" }));
  },

  // -------------------------------------------------------------------------
  // Read receipt (sent via channel)
  // -------------------------------------------------------------------------

  sendReadReceipt(messageId) {
    if (!channel) return;
    channel.push("read_receipt", { message_id: messageId });
  },

  // -------------------------------------------------------------------------
  // Typing indicator (1-second debounce)
  // -------------------------------------------------------------------------

  sendTyping() {
    if (!channel) return;
    const now = Date.now();
    if (!this._lastTypingSent || now - this._lastTypingSent > 1000) {
      this._lastTypingSent = now;
      channel.push("typing", {});
    }
  },

  // -------------------------------------------------------------------------
  // Edit / Delete
  // -------------------------------------------------------------------------

  async editMessage(messageId, plaintext) {
    const { iv, ciphertext } = await AnonCrypto.encrypt(encKey, plaintext);
    const ivB64 = AnonCrypto.toBase64(iv);
    const ctB64 = AnonCrypto.toBase64(ciphertext);

    channel
      .push("edit_message", { message_id: messageId, ciphertext: ctB64, iv: ivB64 })
      .receive("ok", () => this.pushEvent("edit_success", { message_id: messageId }))
      .receive("error", (err) => this.pushEvent("edit_error", err));
  },

  deleteMessage(messageId) {
    channel
      .push("delete_message", { message_id: messageId })
      .receive("ok", () => this.pushEvent("delete_success", { message_id: messageId }))
      .receive("error", (err) => this.pushEvent("delete_error", err));
  },

  // -------------------------------------------------------------------------
  // Expire room
  // -------------------------------------------------------------------------

  expireRoom() {
    if (!channel) return;
    channel
      .push("expire_room", {})
      .receive("ok", () => this.clearSession())
      .receive("error", (err) => console.error("expire_room error", err));
  },

  // -------------------------------------------------------------------------
  // Lock-screen re-authentication (re-derives key without re-joining)
  // -------------------------------------------------------------------------

  async rederiveKey(roomId, pin) {
    const phone = sessionGet("stelegano_phone");
    const storedAccessHash = sessionGet("stelegano_access_hash");

    if (!phone || phone.trim() === "") {
      this.pushEvent("rederive_failed", {});
      return;
    }

    const computedAccessHash = await AnonCrypto.accessHash(phone, pin);
    if (computedAccessHash !== storedAccessHash) {
      this.pushEvent("rederive_failed", {});
      return;
    }

    encKey = await AnonCrypto.deriveKey(phone, roomId);
    this.pushEvent("rederive_success", {});
  },

  // -------------------------------------------------------------------------
  // Session clear (used by panic, logout, and room_expired)
  // -------------------------------------------------------------------------

  clearSession() {
    encKey = null;
    try {
      sessionStorage.removeItem("stelegano_phone");
      sessionStorage.removeItem("stelegano_room_id");
      sessionStorage.removeItem("stelegano_room_hash");
      sessionStorage.removeItem("stelegano_sender_hash");
      sessionStorage.removeItem("stelegano_access_hash");
    } catch (_) {}
    this.disconnectChannel();
  },

  disconnectChannel() {
    if (channel) {
      channel.leave();
      channel = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  },
};


// ---------------------------------------------------------------------------
// PhoneGenerator hook (steg-number page)
// ---------------------------------------------------------------------------

export const PhoneGenerator = {
  mounted() {
    // Synchronise full country list to server on mount
    const countries = Object.keys(CountryNames)
      .filter((k) => isNaN(k))
      .map((k) => ({
        name: k.replace(/_/g, " ").replace(/'/g, "'"),
        value: k,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.pushEvent("set_countries", { countries });

    this.el.addEventListener("click", (e) => {
      // Handle Generate Button
      const generateBtn = e.target.closest("#generate-btn");
      if (generateBtn && !generateBtn.disabled) {
        const countryInput = document.getElementById("country-select");
        if (!countryInput) return;

        this.pushEvent("start_generation", {});

        setTimeout(() => {
          const selected = countryInput.value;
          const config = selected ? { countryName: CountryNames[selected] } : {};
          const number = generatePhoneNumber(config);
          this.pushEvent("number_generated", { number: number, display: number });

          // Auto-copy to clipboard
          navigator.clipboard.writeText(number).then(
            () => this.pushEvent("copied", {}),
            () => {}
          );
        }, 600); // Reduced to 600ms for snappier feel
      }

      // Handle Copy Button
      const copyBtn = e.target.closest("#copy-btn");
      if (copyBtn) {
        const number = copyBtn.dataset.number;
        if (number) {
          navigator.clipboard.writeText(number).then(
            () => this.pushEvent("copied", {}),
            () => {}
          );
        }
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Session storage helpers
// ---------------------------------------------------------------------------

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch (_) {}
}

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (_) {
    return null;
  }
}
