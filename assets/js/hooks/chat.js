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
import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";

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
    // Phone handoff from /steg-number via sessionStorage (keeps phone out of URL).
    try {
      const handoff = sessionStorage.getItem("stelegano_handoff_phone");
      const tierHandoff = sessionStorage.getItem("stelegano_handoff_tier");
      if (handoff) {
        sessionStorage.removeItem("stelegano_handoff_phone");
        sessionStorage.removeItem("stelegano_handoff_tier");
        this.pushEvent("prefill_phone", { phone: handoff, tier: tierHandoff });
      }
    } catch (_) {}

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
    this.handleEvent("set_textarea_value", ({ value }) => {
      const textarea = document.getElementById("chat-textarea");
      if (textarea) {
        textarea.value = value;
        // Trigger resize
        const event = new Event("input", { bubbles: true });
        textarea.dispatchEvent(event);
      }
    });

    this.handleEvent("reverse_handoff", ({ phone, tier }) => {
      try {
        sessionStorage.setItem("stelegano_handoff_phone", phone);
        if (tier) sessionStorage.setItem("stelegano_handoff_tier", tier);
        window.location.href = "/steg-number";
      } catch (_) {}
    });

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
      // Derive ISO-3166 alpha-2 from the E.164 phone so the server can bump
      // the per-country CountryMetrics counter for new rooms. Never leaves
      // the client bound to anything identifying — only the counter is
      // incremented server-side, no per-room country metadata is stored.
      country_iso: countryIsoFromPhone(phone),
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
      .receive("ok", (resp) => {
        this._handleJoinOk(resp, sender_hash);
        this._tryRedeemExtension();
      })
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
  // Extension token redemption (monetization)
  // -------------------------------------------------------------------------

  _tryRedeemExtension() {
    const secret = sessionGet("stelegano_extension_secret");
    if (!secret || !channel) return;

    // Include ISO-3166 alpha-2 (derived from the phone kept in memory for
    // the current session) so the server can bump the per-country
    // paid-rooms CountryMetrics counter. Not persisted anywhere tied
    // to the room or the token.
    const phone = sessionGet("stelegano_phone") || this._pendingPhone;
    const payload = { extension_secret: secret };
    const iso = countryIsoFromPhone(phone);
    if (iso) payload.country_iso = iso;

    channel
      .push("redeem_extension", payload)
      .receive("ok", (resp) => {
        // Token redeemed — clear it from storage and notify the server
        try { sessionStorage.removeItem("stelegano_extension_secret"); } catch (_) {}
        this.pushEvent("ttl_extended", { ttl_expires_at: resp.ttl_expires_at });
      })
      .receive("error", () => {
        // Invalid or already-redeemed token — clean up silently
        try { sessionStorage.removeItem("stelegano_extension_secret"); } catch (_) {}
      });
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
      sessionStorage.removeItem("stelegano_extension_secret");
      sessionStorage.removeItem("stelgano_selected_country");
      sessionStorage.removeItem("stelegano_handoff_phone");
      sessionStorage.removeItem("stelegano_handoff_tier");
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
    const isManualMode = this.el.id === "manual-hook";

    if (isManualMode) {
      this.initManualMode();
    } else {
      this.initGeneratorMode();
    }

    // Handle Copy Button
    this.el.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("#copy-generated-btn");
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

    // Synchronise countries logic removed -- now handled by native Elixir database.

    // Phone handoff from /chat via sessionStorage (reverse handoff/upgrade)
    try {
      const handoff = sessionStorage.getItem("stelegano_handoff_phone");
      const tierHandoff = sessionStorage.getItem("stelegano_handoff_tier");
      if (handoff) {
        sessionStorage.removeItem("stelegano_handoff_phone");
        sessionStorage.removeItem("stelegano_handoff_tier");
        this.pushEvent("restore_number", { phone: handoff, tier: tierHandoff });
      }
    } catch (_) {}
  },

  initGeneratorMode() {
    this.selectedCountry = this.el.dataset.country;

    // We use event delegation on the hook container because regen-btn 
    // might be rendered conditionally after the hook mounts.
    this.el.addEventListener("click", (e) => {
      if (e.target.closest("#regen-btn")) {
        this.generate();
      }
    });

    this.handleEvent("country_selected", ({ country }) => {
      this.selectedCountry = country;
      this.generate();
    });

    // Auto-generate if country is already selected but no number is displayed
    if (this.selectedCountry && !this.el.querySelector("#copy-generated-btn")) {
      this.generate();
    }
  },

  async generate() {
    if (!this.selectedCountry) return;

    this.pushEvent("start_generation", {});
    
    // Artificial delay for "calculating" feel
    await new Promise(r => setTimeout(r, 600));

    const config = { countryName: CountryNames[this.selectedCountry] };
    const number = generatePhoneNumber(config);
    const roomHash = await AnonCrypto.roomHash(number);
    
    this.pushEvent("number_generated", { number: number, display: number, room_hash: roomHash });

    // Auto-copy to clipboard
    navigator.clipboard.writeText(number).then(
      () => this.pushEvent("copied", {}),
      () => {}
    );
  },

  initManualMode() {
    const input = document.getElementById("manual-number-input");
    if (!input) return;

    // Track the current ISO code for formatting, initializing from dataset if present
    this.currentIso = (this.el.dataset.iso || "").toUpperCase();

    this.handleEvent("country_selected", ({ iso }) => {
      // libphonenumber-js requires Uppercase ISO
      this.currentIso = (iso || "").toUpperCase();
      
      // Fixed placeholder as requested
      input.placeholder = "shared phone number";

      // Re-trigger formatting on country change if input has value
      if (input.value) {
        this.formatInput();
      }
    });

    this.formatInput = () => {
      const val = input.value;
      if (!val) return;

      const formatter = new AsYouType(this.currentIso);
      const formatted = formatter.input(val);
      
      // Update input
      input.value = formatted;
      
      handleManualChange(formatted);
    };

    const handleManualChange = async (number) => {
      const input = this.el.querySelector("#manual-number-input");
      const formatter = new AsYouType(this.currentIso);
      formatter.input(number);
      const phoneNumber = formatter.getNumber();
      
      const isValid = !!(phoneNumber && phoneNumber.isValid());
      
      if (input) {
        if (!number) {
          input.classList.remove("is-valid", "is-invalid");
        } else if (isValid) {
          input.classList.add("is-valid");
          input.classList.remove("is-invalid");
        } else {
          input.classList.add("is-invalid");
          input.classList.remove("is-valid");
        }
      }

      if (isValid) {
        const fullNumber = phoneNumber.number;
        const roomHash = await AnonCrypto.roomHash(fullNumber);
        this.pushEvent("check_manual_number", { 
          number: fullNumber, 
          room_hash: roomHash,
          original_input: number
        });
      } else {
        this.pushEvent("manual_number_change", { 
          value: number,
          is_valid: false
        });
      }
    };

    this.handleEvent("check_manual_number_trigger", ({ number }) => {
      handleManualChange(number);
    });

    input.addEventListener("input", () => {
      this.formatInput();
    });
  },

  updated() {
    const isManualMode = this.el.id === "manual-hook";
    if (isManualMode) {
      const nextIso = (this.el.dataset.iso || "").toUpperCase();
      if (nextIso !== this.currentIso) {
        this.currentIso = nextIso;
        if (this.formatInput) {
          this.formatInput();
        }
      }
    }
  }
};

/**
 * CountryPersistence hook — remembers the selected country in localStorage
 */
export const CountryPersistence = {
  mounted() {
    const stored = sessionStorage.getItem("stelgano_selected_country");
    if (stored) {
      this.pushEvent("restore_country", { country: stored });
    }

    this.handleEvent("country_selected", ({ country }) => {
      if (country) {
        sessionStorage.setItem("stelgano_selected_country", country);
      }
    });
  }
};

// ---------------------------------------------------------------------------
// ChannelHandoff hook (steg-number page — "Enter Chat Workspace" button)
//
// Writes the phone number to sessionStorage under a transient key and then
// navigates to /chat. Avoids placing the phone in the URL / address bar /
// history / server logs. The /chat AnonChat hook reads and clears the key.
// ---------------------------------------------------------------------------

export const ChannelHandoff = {
  mounted() {
    this.el.addEventListener("click", (e) => {
      const phone = this.el.dataset.phone;
      const tier = this.el.dataset.tier;
      if (!phone) return;
      e.preventDefault();
      try {
        sessionStorage.setItem("stelegano_handoff_phone", phone);
        if (tier) sessionStorage.setItem("stelegano_handoff_tier", tier);
      } catch (_) {}
      window.location.href = "/chat";
    });
  },
};

// ---------------------------------------------------------------------------
// PaymentInitiator hook (steg-number page — extend button)
// ---------------------------------------------------------------------------

export const PaymentInitiator = {
  mounted() {
    this.el.addEventListener("click", async () => {
      if (this.el.disabled) return;

      const { secret, tokenHash } = await AnonCrypto.generateExtensionToken();

      // Store the secret so it can be redeemed after payment
      sessionSet("stelegano_extension_secret", secret);

      // Send the hash to the server to initiate the payment flow
      this.pushEvent("initiate_payment", { token_hash: tokenHash });
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

/**
 * Returns the ISO-3166 alpha-2 country code for a given E.164 phone, or
 * null if the number can't be parsed. libphonenumber-js figures this out
 * from the numeric prefix — no network call, no external lookup.
 *
 * Used only to bump the server-side CountryMetrics counter; the ISO is
 * never stored alongside the room_hash, token_hash, or phone. See the
 * Stelgano.CountryMetrics module doc for the privacy rationale.
 */
function countryIsoFromPhone(phone) {
  if (!phone || typeof phone !== "string") return null;
  try {
    const parsed = parsePhoneNumberFromString(phone);
    return parsed && parsed.country ? parsed.country : null;
  } catch (_) {
    return null;
  }
}
