// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @fileoverview AnonCrypto — sTELgano-std-1 client-side cryptographic primitives.
 *
 * All cryptography uses the browser's built-in Web Crypto API (crypto.subtle).
 * No external libraries. No WASM. This file is the canonical, auditable
 * implementation of the sTELgano cryptographic specification.
 *
 * ## Derivation chain
 *
 *   phone       = normalise(raw_input)
 *   room_hash   = SHA-256(phone + ":" + ROOM_SALT)
 *   access_hash = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT)
 *   enc_key     = PBKDF2(password: phone, salt: room_id + ENC_SALT,
 *                        iterations: 600_000, hash: SHA-256, keylen: 256)
 *   sender_hash = SHA-256(phone + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
 *
 * ## Why salts are public constants
 *
 * Salts provide domain separation — preventing hash reuse across contexts.
 * Security does not depend on salt secrecy; it depends on the entropy of the
 * phone number + PIN inputs. See §8.9 of the PRD.
 */

"use strict";

// ---------------------------------------------------------------------------
// Public salt constants (domain separators — not secrets)
// ---------------------------------------------------------------------------

const ROOM_SALT   = "stelegano-room-v1-2026";
const ACCESS_SALT = "stelegano-access-v1-2026";
const SENDER_SALT = "stelegano-sender-v1-2026";
const ENC_SALT    = "stelegano-enc-v1-2026";

/**
 * PBKDF2 iteration count — OWASP 2023 recommendation for PBKDF2-HMAC-SHA256.
 * 600,000 iterations takes ~1.5–2.5s on a mid-range mobile device.
 * This is intentional: it makes offline key recovery computationally expensive.
 */
const PBKDF2_ITER = 600_000;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a raw phone number input to digits-only with country code.
 *
 * Strips: spaces, dashes, dots, +, parentheses, and other non-digit characters.
 * The normalised form is the canonical input for all hash derivations.
 *
 * @param {string} raw - Raw phone number as entered by the user.
 * @returns {string} Digits-only string.
 */
function normalise(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a string to UTF-8 bytes.
 * @param {string} s
 * @returns {Uint8Array}
 */
function encode(s) {
  return new TextEncoder().encode(s);
}

/**
 * Converts an ArrayBuffer to a lowercase hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Computes SHA-256 of a UTF-8 string and returns the hex digest.
 * @param {string} input
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
async function sha256hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", encode(input));
  return toHex(digest);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives the room_hash from a normalised phone number.
 *
 * room_hash = SHA-256(phone + ":" + ROOM_SALT)
 *
 * Sent to the server to locate the room. Cannot be reversed to find the
 * phone number.
 *
 * @param {string} phone - Normalised (digits-only) phone number.
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
async function roomHash(phone) {
  return sha256hex(`${normalise(phone)}:${ROOM_SALT}`);
}

/**
 * Derives the access_hash from a normalised phone number and PIN.
 *
 * access_hash = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT)
 *
 * Sent to the server as the PIN gate credential. The PIN never leaves the
 * device. User A and User B have different access_hashes for the same room.
 *
 * @param {string} phone - Normalised phone number.
 * @param {string} pin   - User's personal PIN (digits only).
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
async function accessHash(phone, pin) {
  return sha256hex(`${normalise(phone)}:${pin}:${ACCESS_SALT}`);
}

/**
 * Derives the sender_hash for bubble-side rendering.
 *
 * sender_hash = SHA-256(phone + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
 *
 * Stored in sessionStorage. Determines which bubble side (sent/received) to
 * render. The access_hash is mixed in so that two users with the same phone
 * but different PINs produce different sender_hashes.
 *
 * @param {string} phone       - Normalised phone number.
 * @param {string} accessHash_ - The access_hash hex string (64 chars).
 * @param {string} roomHash_   - The room_hash hex string (64 chars).
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
async function senderHash(phone, accessHash_, roomHash_) {
  return sha256hex(`${normalise(phone)}:${accessHash_}:${roomHash_}:${SENDER_SALT}`);
}

/**
 * Derives the AES-256-GCM encryption key using PBKDF2.
 *
 * enc_key = PBKDF2(
 *   password  : phone,
 *   salt      : room_id + ENC_SALT,
 *   iterations: 600_000,
 *   hash      : SHA-256,
 *   keylen    : 256 bits
 * )
 *
 * Derived client-side AFTER the server returns room_id on successful join.
 * NEVER transmitted to the server.
 *
 * Both users independently derive the same key because both know the same
 * phone number and room_id. The PIN is NOT part of the enc_key so that
 * both parties — who have different PINs — arrive at the same decryption key.
 *
 * @param {string} phone  - Normalised phone number.
 * @param {string} roomId - Server-generated UUID returned on join.
 * @returns {Promise<CryptoKey>} AES-256-GCM CryptoKey (extractable: false).
 */
async function deriveKey(phone, roomId) {
  // Import the phone number as raw key material for PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encode(normalise(phone)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const salt = encode(`${roomId}${ENC_SALT}`);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITER,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,        // not extractable — enc_key never leaves JS memory
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 *
 * Generates a cryptographically random 96-bit (12-byte) nonce per message.
 * The GCM auth tag (128-bit) ensures integrity — tampered ciphertext will
 * throw a DOMException on decryption before any plaintext is returned.
 *
 * @param {CryptoKey} key       - AES-256-GCM key from deriveKey().
 * @param {string}    plaintext - Message content (UTF-8).
 * @returns {Promise<{ iv: Uint8Array, ciphertext: Uint8Array }>}
 *   iv         — 12-byte nonce (must be stored with ciphertext)
 *   ciphertext — GCM ciphertext || 128-bit auth tag
 */
async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encode(plaintext)
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypts an AES-256-GCM ciphertext.
 *
 * Throws DOMException if the auth tag is invalid (tampered ciphertext or
 * wrong key). The caller MUST handle this exception and never display
 * plaintext from a failed decryption.
 *
 * @param {CryptoKey}  key        - AES-256-GCM key from deriveKey().
 * @param {Uint8Array} iv         - 12-byte nonce stored with the message.
 * @param {Uint8Array} ciphertext - GCM ciphertext || auth tag.
 * @returns {Promise<string>} Decrypted UTF-8 plaintext.
 * @throws {DOMException} If decryption fails (wrong key or tampered data).
 */
async function decrypt(key, iv, ciphertext) {
  const plainbuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plainbuf);
}

/**
 * Encodes a Uint8Array to a base64 string for JSON transport.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string to a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Extension token (monetization)
// ---------------------------------------------------------------------------

/**
 * Generates a random extension secret and computes its SHA-256 hash.
 *
 * The secret is held client-side; the hash is sent to the server as
 * the payment reference. After payment, the client redeems the secret
 * via the channel to extend the room's TTL.
 *
 * The extension_tokens table has no room_id — the server cannot link
 * a payment to a specific room.
 *
 * @returns {Promise<{ secret: string, tokenHash: string }>}
 *   secret    — 64-char hex string (the preimage, kept by client)
 *   tokenHash — 64-char hex string (SHA-256 of secret, sent to server)
 */
async function generateExtensionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = toHex(bytes.buffer);
  const tokenHash = await sha256hex(secret);
  return { secret, tokenHash };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const AnonCrypto = {
  normalise,
  roomHash,
  accessHash,
  senderHash,
  deriveKey,
  encrypt,
  decrypt,
  toBase64,
  fromBase64,
  generateExtensionToken,
};
