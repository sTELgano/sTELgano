// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @fileoverview chat.js — LiveView hooks for the sTELgano chat interface.
 *
 * Imports from ../crypto/anon.js (the canonical crypto implementation) and
 * ../crypto/phone-gen.js. No other npm dependencies.
 *
 * ## Hook overview
 *
 * - ChatEntry     — entry form; drives PBKDF2 derivation + channel join
 * - ChatSession   — manages the open chat: messages, input, inactivity lock
 * - LockScreen    — PIN re-entry on the lock screen
 * - ThemeToggle   — light/dark theme toggle with localStorage persistence
 * - ExpireRoom    — room expiry confirmation
 * - PhoneGenerator — steg number generation (delegates to phone-gen.js)
 * - CustomNumberCheck — availability check on the steg-number page
 */

"use strict";

import { AnonCrypto } from "../crypto/anon.js";
import { generateStegNumber, normalisePhone, isPlausiblePhone } from "../crypto/phone-gen.js";
import { Socket } from "phoenix";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Phoenix Socket for the anonymous room channel. */
let _socket = null;

/** Active Phoenix Channel instance. */
let _channel = null;

/** Derived AES-256-GCM CryptoKey (JS memory only, never serialised). */
let _encKey = null;

/** Inactivity timer handle. */
let _inactivityTimer = null;

/** Typing indicator broadcast timer handle. */
let _typingTimer = null;

// ---------------------------------------------------------------------------
// Session storage helpers
// ---------------------------------------------------------------------------

function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch (_) {}
}

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch (_) { return null; }
}

function sessionClear() {
  try { sessionStorage.clear(); } catch (_) {}
  _encKey = null;
}

// ---------------------------------------------------------------------------
// Inactivity timer
// ---------------------------------------------------------------------------

const TIMEOUT_MAP = {
  "30s":  30_000,
  "1min": 60_000,
  "5min": 300_000,
  "15min": 900_000,
  "30min": 1_800_000,
  "never": null,
};

function startInactivityTimer(hook) {
  clearInactivityTimer();
  const raw = hook.el.dataset.inactivityTimeout || "5min";
  const ms = TIMEOUT_MAP[raw];
  if (ms === null) return;
  _inactivityTimer = setTimeout(() => {
    hook.pushEvent("lock_session", {});
  }, ms);
}

function resetInactivityTimer(hook) {
  startInactivityTimer(hook);
}

function clearInactivityTimer() {
  if (_inactivityTimer) { clearTimeout(_inactivityTimer); _inactivityTimer = null; }
}

// ---------------------------------------------------------------------------
// Message rendering helpers
// ---------------------------------------------------------------------------

/**
 * Formats an ISO timestamp as a short locale time string.
 * @param {string|null} ts
 * @returns {string}
 */
function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

/**
 * Renders a message bubble into the messages container.
 * @param {object} opts
 * @param {string}  opts.id          - Message UUID
 * @param {string}  opts.text        - Decrypted plaintext
 * @param {boolean} opts.isSent      - True = right bubble, false = left bubble
 * @param {string|null} opts.readAt  - ISO timestamp if read, else null
 * @param {string|null} opts.time    - ISO insertion timestamp
 * @param {boolean} opts.edited      - Whether the message has been edited
 */
function renderMessage({ id, text, isSent, readAt, time, edited = false }) {
  const container = document.getElementById("messages-container");
  if (!container) return;

  // Remove existing bubble with same ID (for edits)
  const existing = document.getElementById(`msg-${id}`);
  if (existing) existing.remove();

  const wrapper = document.createElement("div");
  wrapper.id = `msg-${id}`;
  wrapper.className = `flex ${isSent ? "justify-end" : "justify-start"} mb-2`;
  wrapper.dataset.messageId = id;
  wrapper.dataset.sent = isSent ? "true" : "false";

  const bubble = document.createElement("div");
  bubble.className = "max-w-xs sm:max-w-sm lg:max-w-md px-4 py-3 relative group";
  bubble.style.cssText = isSent
    ? "background: var(--accent-soft); color: var(--accent-fg); border-radius: 20px 20px 4px 20px;"
    : "background: var(--received); color: var(--received-fg); border-radius: 20px 20px 20px 4px;";

  const textEl = document.createElement("p");
  textEl.className = "text-sm whitespace-pre-wrap break-words";
  textEl.textContent = text;
  bubble.appendChild(textEl);

  // Meta row (time + tick + edited)
  const meta = document.createElement("div");
  meta.className = "flex items-center gap-1 mt-1";
  meta.style.justifyContent = "flex-end";

  if (edited) {
    const editedLabel = document.createElement("span");
    editedLabel.className = "text-xs opacity-60";
    editedLabel.textContent = "edited";
    meta.appendChild(editedLabel);
  }

  if (time) {
    const timeEl = document.createElement("span");
    timeEl.className = "text-xs opacity-60";
    timeEl.textContent = formatTime(time);
    meta.appendChild(timeEl);
  }

  if (isSent) {
    const tick = document.createElement("span");
    tick.id = `tick-${id}`;
    tick.className = "text-xs opacity-70 select-none";
    tick.textContent = readAt ? "✓✓" : "✓";
    meta.appendChild(tick);
  }

  bubble.appendChild(meta);

  // Context menu for own unread messages (edit / delete)
  if (isSent && !readAt) {
    bubble.addEventListener("contextmenu", e => {
      e.preventDefault();
      showContextMenu(id, bubble);
    });
    // Long-press for mobile
    let longPressTimer;
    bubble.addEventListener("pointerdown", () => {
      longPressTimer = setTimeout(() => showContextMenu(id, bubble), 600);
    });
    bubble.addEventListener("pointerup", () => clearTimeout(longPressTimer));
    bubble.addEventListener("pointermove", () => clearTimeout(longPressTimer));
  }

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);

  // Scroll to bottom
  wrapper.scrollIntoView({ behavior: "smooth", block: "end" });

  // Animate in
  bubble.style.opacity = "0";
  bubble.style.transform = "scale(0.95)";
  bubble.style.transition = "opacity 150ms ease, transform 150ms ease";
  requestAnimationFrame(() => {
    bubble.style.opacity = "1";
    bubble.style.transform = "scale(1)";
  });
}

/**
 * Shows a context menu near the given bubble element.
 * @param {string} messageId
 * @param {HTMLElement} bubble
 */
function showContextMenu(messageId, bubble) {
  // Remove any existing context menu
  document.querySelectorAll(".steg-ctx-menu").forEach(el => el.remove());

  const menu = document.createElement("div");
  menu.className = "steg-ctx-menu absolute right-0 top-0 z-50 rounded-xl shadow-lg overflow-hidden";
  menu.style.cssText = "background: var(--bg-surface); border: 1px solid var(--border); transform: translateY(-100%);";

  const editBtn = document.createElement("button");
  editBtn.className = "block w-full text-left px-4 py-3 text-sm hover:opacity-70 transition-opacity";
  editBtn.style.color = "var(--text-primary)";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => {
    menu.remove();
    window._stelganoStartEdit && window._stelganoStartEdit(messageId);
  };

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "block w-full text-left px-4 py-3 text-sm hover:opacity-70 transition-opacity";
  deleteBtn.style.color = "var(--danger)";
  deleteBtn.textContent = "Delete";
  deleteBtn.onclick = () => {
    menu.remove();
    if (confirm("Delete this message?")) {
      window._stelganoDeleteMessage && window._stelganoDeleteMessage(messageId);
    }
  };

  menu.appendChild(editBtn);
  menu.appendChild(deleteBtn);
  bubble.style.position = "relative";
  bubble.appendChild(menu);

  // Dismiss on outside click
  const dismiss = e => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", dismiss); }
  };
  setTimeout(() => document.addEventListener("click", dismiss), 0);
}

/**
 * Updates the tick/read receipt for a sent message.
 * @param {string} messageId
 */
function markMessageRead(messageId) {
  const tick = document.getElementById(`tick-${messageId}`);
  if (tick) tick.textContent = "✓✓";
}

/**
 * Removes a message bubble from the DOM.
 * @param {string} messageId
 */
function removeMessageBubble(messageId) {
  const el = document.getElementById(`msg-${messageId}`);
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// Input area state management
// ---------------------------------------------------------------------------

/**
 * Switches the input area to "waiting" state (sender's turn is over).
 */
function showWaitingState() {
  const active = document.getElementById("active-input");
  const waiting = document.getElementById("waiting-state");
  if (active) active.classList.add("hidden");
  if (waiting) { waiting.classList.remove("hidden"); waiting.classList.add("flex"); }
}

/**
 * Switches the input area to "active" state (ready to send).
 */
function showActiveInput() {
  const active = document.getElementById("active-input");
  const waiting = document.getElementById("waiting-state");
  if (active) active.classList.remove("hidden");
  if (waiting) { waiting.classList.add("hidden"); waiting.classList.remove("flex"); }
}

// ---------------------------------------------------------------------------
// ChatEntry hook
// ---------------------------------------------------------------------------

/**
 * Drives the entry form: collects steg number + PIN, runs PBKDF2 derivation,
 * and joins the Phoenix Channel.  All crypto runs in the browser.
 */
export const ChatEntry = {
  mounted() {
    const submitBtn = document.getElementById("entry-submit");
    const numberInput = document.getElementById("steg-number-input");
    const pinInput = document.getElementById("pin-input");

    if (!submitBtn || !numberInput || !pinInput) return;

    const handleSubmit = async () => {
      const rawPhone = numberInput.value.trim();
      const rawPin   = pinInput.value.trim();

      if (!rawPhone || !rawPin) return;

      // Signal deriving state to LiveView
      this.pushEvent("set_deriving", { value: "true" });

      try {
        const phone      = AnonCrypto.normalise(rawPhone);
        const rHash      = await AnonCrypto.roomHash(phone);
        const aHash      = await AnonCrypto.accessHash(phone, rawPin);
        const sHash      = await AnonCrypto.senderHash(phone, rHash);

        // Persist to sessionStorage (enc_key goes to JS memory only)
        sessionSet("steg_phone", phone);
        sessionSet("room_hash", rHash);
        sessionSet("sender_hash", sHash);

        // Connect socket and join channel
        await joinChannel(phone, rHash, aHash, sHash, this);

      } catch (err) {
        console.error("ChatEntry derivation error:", err);
        this.pushEvent("set_deriving", { value: "false" });
        this.pushEvent("channel_error", { reason: "unknown" });
      }
    };

    submitBtn.addEventListener("click", handleSubmit);

    // Allow Enter key to submit from either field
    [numberInput, pinInput].forEach(input => {
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") handleSubmit();
      });
    });
  },
};

/**
 * Connects to the Phoenix Socket and joins the anonymous room channel.
 *
 * @param {string} phone   - Normalised phone number
 * @param {string} rHash   - room_hash hex
 * @param {string} aHash   - access_hash hex
 * @param {string} sHash   - sender_hash hex
 * @param {object} hook    - The hook instance (for pushEvent)
 */
async function joinChannel(phone, rHash, aHash, sHash, hook) {
  // Disconnect existing socket if any
  if (_socket) {
    _socket.disconnect();
    _socket = null;
    _channel = null;
  }

  const csrfToken = document.querySelector("meta[name='csrf-token']")?.getAttribute("content") || "";

  _socket = new Socket("/anon_socket", { params: { _csrf_token: csrfToken } });
  _socket.connect();

  _channel = _socket.channel(`anon_room:${rHash}`, {
    access_hash: aHash,
    sender_hash: sHash,
  });

  _channel.join()
    .receive("ok", async resp => {
      const roomId = resp.room_id;
      sessionSet("room_id", roomId);

      // Derive enc_key AFTER getting room_id (never transmitted)
      _encKey = await AnonCrypto.deriveKey(phone, roomId);

      hook.pushEvent("set_deriving", { value: "false" });
      hook.pushEvent("channel_joined", { room_id: roomId });

      // If a message was waiting, it's in resp.current_message
      if (resp.current_message) {
        window._stelganoHandleNewMessage && window._stelganoHandleNewMessage(resp.current_message);
      }
    })
    .receive("error", resp => {
      hook.pushEvent("set_deriving", { value: "false" });
      hook.pushEvent("channel_error", {
        reason: resp.reason || "unknown",
        attempts_remaining: resp.attempts_remaining || null,
      });
      if (_socket) { _socket.disconnect(); _socket = null; }
    });
}

// ---------------------------------------------------------------------------
// ChatSession hook
// ---------------------------------------------------------------------------

/**
 * Manages the open chat session: message rendering, send/edit/delete,
 * typing indicator, IntersectionObserver for read receipts, and inactivity lock.
 */
export const ChatSession = {
  mounted() {
    const sessionHook = this;

    startInactivityTimer(this);

    // Reset timer on user activity
    ["click", "keydown", "pointerdown"].forEach(evt => {
      this.el.addEventListener(evt, () => resetInactivityTimer(sessionHook), { passive: true });
    });

    // Track visibility for inactivity (tab hidden = not reset)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInactivityTimer();
      } else {
        resetInactivityTimer(sessionHook);
      }
    });

    // ---------------------------------------------------------------------------
    // Incoming channel events
    // ---------------------------------------------------------------------------

    if (!_channel) return;

    /**
     * Handle an incoming new_message event.
     * Decrypts and renders the bubble; marks as read via IntersectionObserver.
     */
    const handleNewMessage = async (payload) => {
      const senderHash = sessionGet("sender_hash");
      const isSent = payload.sender_hash === senderHash;

      let text;
      try {
        const iv         = AnonCrypto.fromBase64(payload.iv);
        const ciphertext = AnonCrypto.fromBase64(payload.ciphertext);
        text = await AnonCrypto.decrypt(_encKey, iv, ciphertext);
      } catch (err) {
        console.error("Decryption failed:", err);
        text = "[Unable to decrypt message]";
      }

      renderMessage({
        id: payload.id,
        text,
        isSent,
        readAt: payload.read_at,
        time: payload.inserted_at,
        edited: false,
      });

      // If received (not sent), update input state and trigger read receipt
      if (!isSent) {
        showActiveInput();

        // IntersectionObserver with 500ms dwell confirms the message was viewed
        const msgEl = document.getElementById(`msg-${payload.id}`);
        if (msgEl && _channel) {
          let dwellTimer = null;
          const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                dwellTimer = setTimeout(() => {
                  _channel.push("read_receipt", { message_id: payload.id });
                  observer.disconnect();
                }, 500);
              } else {
                if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
              }
            });
          }, { threshold: 0.5 });
          observer.observe(msgEl);
        }
      } else {
        // Own message: show waiting state
        showWaitingState();
      }

      // Hide empty state
      const emptyState = document.getElementById("empty-state");
      if (emptyState) emptyState.classList.add("hidden");
    };

    window._stelganoHandleNewMessage = handleNewMessage;

    _channel.on("new_message", handleNewMessage);

    _channel.on("message_read", ({ message_id }) => {
      markMessageRead(message_id);
      // Re-enable input when our sent message is read — recipient is now reading
      // (They'll send a reply which will arrive via new_message)
    });

    _channel.on("message_edited", async ({ message_id, ciphertext, iv }) => {
      let text;
      try {
        const ivBytes  = AnonCrypto.fromBase64(iv);
        const ctBytes  = AnonCrypto.fromBase64(ciphertext);
        text = await AnonCrypto.decrypt(_encKey, ivBytes, ctBytes);
      } catch {
        text = "[Unable to decrypt edited message]";
      }

      const senderHash = sessionGet("sender_hash");
      // Re-render edited bubble (we don't know sender_hash from this event,
      // so check existing bubble's data attribute)
      const existing = document.getElementById(`msg-${message_id}`);
      const isSent = existing ? existing.dataset.sent === "true" : false;

      renderMessage({
        id: message_id,
        text,
        isSent,
        readAt: null,
        time: null,
        edited: true,
      });
    });

    _channel.on("message_deleted", ({ message_id }) => {
      removeMessageBubble(message_id);
      showActiveInput();
      const container = document.getElementById("messages-container");
      if (container && !container.hasChildNodes()) {
        const emptyState = document.getElementById("empty-state");
        if (emptyState) emptyState.classList.remove("hidden");
      }
    });

    _channel.on("counterparty_typing", () => {
      const indicator = document.getElementById("typing-indicator");
      if (indicator) {
        indicator.classList.remove("hidden");
        clearTimeout(window._stelganoTypingHideTimer);
        window._stelganoTypingHideTimer = setTimeout(() => {
          indicator.classList.add("hidden");
        }, 3_000);
      }
    });

    _channel.on("room_expired", () => {
      sessionClear();
      if (_socket) { _socket.disconnect(); _socket = null; }
      this.pushEvent("room_expired", {});
    });

    // ---------------------------------------------------------------------------
    // Send / edit / delete logic
    // ---------------------------------------------------------------------------

    const messageInput = document.getElementById("message-input");
    const sendBtn = document.getElementById("send-btn");
    const charCountEl = document.getElementById("char-count");
    const charCounter = document.getElementById("char-counter");

    let editingMessageId = null;

    const sendMessage = async () => {
      if (!messageInput || !_channel || !_encKey) return;
      const text = messageInput.value.trim();
      if (!text) return;

      try {
        const { iv, ciphertext } = await AnonCrypto.encrypt(_encKey, text);
        const ivB64 = AnonCrypto.toBase64(iv);
        const ctB64 = AnonCrypto.toBase64(ciphertext);

        if (editingMessageId) {
          _channel.push("edit_message", {
            message_id: editingMessageId,
            ciphertext: ctB64,
            iv: ivB64,
          }).receive("ok", () => {
            editingMessageId = null;
            messageInput.value = "";
            messageInput.style.height = "";
            showWaitingState();
          }).receive("error", resp => {
            console.error("Edit failed:", resp);
          });
        } else {
          _channel.push("send_message", { ciphertext: ctB64, iv: ivB64 })
            .receive("ok", () => {
              messageInput.value = "";
              messageInput.style.height = "";
              if (charCounter) charCounter.classList.add("hidden");
            })
            .receive("error", resp => {
              console.error("Send failed:", resp);
            });
        }
      } catch (err) {
        console.error("Encryption error:", err);
      }
    };

    if (sendBtn) sendBtn.addEventListener("click", sendMessage);

    if (messageInput) {
      messageInput.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // Auto-resize textarea
      messageInput.addEventListener("input", () => {
        messageInput.style.height = "auto";
        messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + "px";

        // Character counter
        const len = messageInput.value.length;
        if (charCountEl) charCountEl.textContent = len;
        if (charCounter) {
          if (len >= 3500) {
            charCounter.classList.remove("hidden");
          } else {
            charCounter.classList.add("hidden");
          }
        }

        // Typing indicator broadcast (debounced)
        if (_channel) {
          clearTimeout(_typingTimer);
          _typingTimer = setTimeout(() => {
            _channel.push("typing", {});
          }, 200);
        }
      });
    }

    // Expose edit/delete handlers to context menu
    window._stelganoStartEdit = (messageId) => {
      editingMessageId = messageId;
      // Pre-populate textarea with current displayed text
      const bubble = document.querySelector(`#msg-${messageId} p`);
      if (bubble && messageInput) {
        messageInput.value = bubble.textContent;
        messageInput.focus();
        showActiveInput();
      }
    };

    window._stelganoDeleteMessage = (messageId) => {
      if (_channel) {
        _channel.push("delete_message", { message_id: messageId });
      }
    };

    // ---------------------------------------------------------------------------
    // Expire room
    // ---------------------------------------------------------------------------

    const expireBtn = document.getElementById("expire-room-btn");
    if (expireBtn) {
      expireBtn.addEventListener("click", () => {
        if (confirm("End this conversation? This cannot be undone.")) {
          if (_channel) _channel.push("expire_room", {});
        }
      });
    }
  },

  destroyed() {
    clearInactivityTimer();
    window._stelganoHandleNewMessage = null;
    window._stelganoStartEdit = null;
    window._stelganoDeleteMessage = null;
  },
};

// ---------------------------------------------------------------------------
// LockScreen hook
// ---------------------------------------------------------------------------

/**
 * Handles PIN re-entry on the lock screen.
 * Derives access_hash client-side and compares with stored sender_hash
 * (proxy: we re-derive the full set and compare room_hash consistency).
 */
export const LockScreen = {
  mounted() {
    const pinInput = document.getElementById("lock-pin-input");
    const unlockBtn = document.getElementById("lock-unlock-btn");

    if (!pinInput || !unlockBtn) return;

    const attempt = async () => {
      const pin = pinInput.value.trim();
      if (!pin) return;

      const phone    = sessionGet("steg_phone");
      const rHash    = sessionGet("room_hash");
      const sHash    = sessionGet("sender_hash");

      if (!phone || !rHash || !sHash) {
        // Session data missing — force full logout
        this.pushEvent("unlock_attempt", { correct: "false" });
        return;
      }

      // Verify by re-deriving sender_hash and comparing
      const derivedSHash = await AnonCrypto.senderHash(phone, rHash);
      const correct = derivedSHash === sHash;

      if (correct && _encKey === null) {
        // Re-derive enc_key if session was cleared from memory
        const roomId = sessionGet("room_id");
        if (roomId) {
          _encKey = await AnonCrypto.deriveKey(phone, roomId);
        }
      }

      pinInput.value = "";
      this.pushEvent("unlock_attempt", { correct: correct ? "true" : "false" });
    };

    unlockBtn.addEventListener("click", attempt);
    pinInput.addEventListener("keydown", e => { if (e.key === "Enter") attempt(); });
    pinInput.focus();
  },
};

// ---------------------------------------------------------------------------
// ThemeToggle hook
// ---------------------------------------------------------------------------

export const ThemeToggle = {
  mounted() {
    this.el.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("phx:theme", next);
      document.documentElement.setAttribute("data-theme", next);
    });
  },
};

// ---------------------------------------------------------------------------
// PhoneGenerator hook (steg-number page)
// ---------------------------------------------------------------------------

export const PhoneGenerator = {
  mounted() {
    const generateBtn = document.getElementById("generate-btn");
    if (!generateBtn) return;

    generateBtn.addEventListener("click", () => {
      const result = generateStegNumber();
      this.pushEvent("number_generated", { number: result.e164, display: result.display });
    });

    // Copy button
    this.el.addEventListener("click", e => {
      const copyBtn = e.target.closest("#copy-btn");
      if (!copyBtn) return;
      const number = copyBtn.dataset.number;
      if (!number) return;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(number).catch(() => fallbackCopy(number));
      } else {
        fallbackCopy(number);
      }
    });

    function fallbackCopy(text) {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(el);
    }
  },
};

// ---------------------------------------------------------------------------
// CustomNumberCheck hook (steg-number page)
// ---------------------------------------------------------------------------

export const CustomNumberCheck = {
  mounted() {
    const checkBtn = document.getElementById("check-availability-btn");
    const input    = document.getElementById("custom-number-input");

    if (!checkBtn || !input) return;

    input.addEventListener("input", () => {
      this.pushEvent("custom_number_change", { value: input.value });
    });

    checkBtn.addEventListener("click", async () => {
      const raw = input.value.trim();
      if (!isPlausiblePhone(raw)) {
        this.pushEvent("custom_number_change", { value: raw });
        return;
      }

      const phone  = normalisePhone(raw);
      const rHash  = await AnonCrypto.roomHash(phone);
      this.pushEvent("check_availability", { room_hash: rHash });
    });
  },
};

// ---------------------------------------------------------------------------
// ChatRoot hook — no-op container for phx-hook requirement
// ---------------------------------------------------------------------------

export const ChatRoot = {
  mounted() {},
};
