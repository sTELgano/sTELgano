// SPDX-License-Identifier: AGPL-3.0-only
//
// AnonCrypto — sTELgano-std-1 client-side cryptographic primitives.
//
// Direct port of elixir/assets/js/crypto/anon.js with TypeScript types.
// All cryptography uses the browser's built-in Web Crypto API. Zero
// external libraries. Constants and algorithms are unchanged from v1
// — same hashes, same key derivation, same protocol. Salts MUST stay
// in lockstep with src/client/workers/pbkdf2.ts.
//
// Derivation chain:
//   phone       = normalise(raw_input)
//   room_hash   = SHA-256(phone + ":" + ROOM_SALT)
//   access_hash = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT)
//   enc_key     = PBKDF2(password: phone, salt: room_id + ENC_SALT,
//                        iterations: 600_000, hash: SHA-256, keylen: 256)
//   sender_hash = SHA-256(phone + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)

// ---------------------------------------------------------------------------
// Public salt constants (domain separators — not secrets)
// ---------------------------------------------------------------------------

const ROOM_SALT = "stelegano-room-v1-2026";
const ACCESS_SALT = "stelegano-access-v1-2026";
const SENDER_SALT = "stelegano-sender-v1-2026";
const ENC_SALT = "stelegano-enc-v1-2026";

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. ~1.5–2.5s on a
 *  mid-range mobile device — intentionally expensive to brute force. */
const PBKDF2_ITER = 600_000;

/** URL of the bundled PBKDF2 worker, served from public/assets/. */
const PBKDF2_WORKER_URL = "/assets/pbkdf2_worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips spaces, dashes, parens, +, and any other non-digit. The
 *  normalised form is the canonical input to all hash derivations. */
export function normalise(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "");
}

// TextEncoder always allocates a fresh non-shared ArrayBuffer; the
// cast narrows the generic away from ArrayBufferLike so Web Crypto
// APIs (which want ArrayBuffer-backed BufferSource) accept it without
// per-call gymnastics.
function encode(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encode(input));
  return toHex(digest);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** room_hash = SHA-256(phone + ":" + ROOM_SALT) */
export async function roomHash(phone: string): Promise<string> {
  return sha256hex(`${normalise(phone)}:${ROOM_SALT}`);
}

/** access_hash = SHA-256(phone + ":" + PIN + ":" + ACCESS_SALT) */
export async function accessHash(phone: string, pin: string): Promise<string> {
  return sha256hex(`${normalise(phone)}:${pin}:${ACCESS_SALT}`);
}

/** sender_hash = SHA-256(phone + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
 *  Two users with the same phone but different PINs produce different
 *  sender_hashes — that's the point of including access_hash. */
export async function senderHash(phone: string, access: string, room: string): Promise<string> {
  return sha256hex(`${normalise(phone)}:${access}:${room}:${SENDER_SALT}`);
}

/** AES-256-GCM key via PBKDF2. Both users derive the same key because
 *  PIN is NOT in the input. Never transmitted. */
export async function deriveKey(phone: string, roomId: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encode(normalise(phone)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  const salt = encode(`${roomId}${ENC_SALT}`);

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, // not extractable — never leaves JS memory
    ["encrypt", "decrypt"],
  );
}

export type ProgressCallback = (percent: number) => void;

/** Same as deriveKey but in a Web Worker so the 600k PBKDF2 doesn't
 *  freeze the main thread for ~2s at login. CryptoKey is structured-
 *  cloneable so it travels back over postMessage without being
 *  serialised as bytes. Falls back to main-thread derivation if the
 *  worker can't be created. */
export function deriveKeyInWorker(
  phone: string,
  roomId: string,
  onProgress?: ProgressCallback,
): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(PBKDF2_WORKER_URL);
    } catch {
      // CSP, offline, unsupported browser. Degrade.
      deriveKey(phone, roomId).then(resolve, reject);
      return;
    }

    const cleanup = () => {
      try {
        worker.terminate();
      } catch {
        // ignore
      }
    };

    worker.addEventListener("message", (e: MessageEvent) => {
      const data = e.data as
        | { type: "progress"; percent: number }
        | { type: "done"; key: CryptoKey }
        | { type: "error"; message?: string }
        | null
        | undefined;
      if (!data) return;
      if (data.type === "progress") {
        try {
          onProgress?.(data.percent);
        } catch {
          // swallow listener errors
        }
      } else if (data.type === "done") {
        cleanup();
        resolve(data.key);
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(data.message ?? "PBKDF2 worker failed"));
      }
    });

    worker.addEventListener("error", () => {
      cleanup();
      // Last-chance fallback to main-thread derivation.
      deriveKey(phone, roomId).then(resolve, reject);
    });

    worker.postMessage({ type: "derive", phone: normalise(phone), roomId });
  });
}

/** AES-256-GCM encrypt with a fresh 96-bit random nonce per message.
 *  Returns binary {iv, ciphertext}; caller base64-encodes for transport. */
export async function encrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
  // getRandomValues' return type is ArrayBufferLike-generic; we know
  // the input was a fresh non-shared Uint8Array, so the cast is safe.
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encode(plaintext),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** AES-256-GCM decrypt. Throws DOMException on auth-tag mismatch
 *  (tampered ciphertext or wrong key). Caller MUST handle the
 *  exception and never display anything from a failed decryption.
 *  Inputs are ArrayBuffer-backed Uint8Arrays; fromBase64() returns
 *  this shape, as do fresh-allocated Uint8Arrays. */
export async function decrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plain);
}

/** Uint8Array → base64 (for JSON transport). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** base64 → Uint8Array (ArrayBuffer-backed, suitable for Web Crypto). */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Extension token (monetization)
// ---------------------------------------------------------------------------

/** Random 256-bit secret + its SHA-256. The secret stays client-side;
 *  the hash is sent to the server as the payment reference. The
 *  extension_tokens table has no room_id — the server cannot link a
 *  payment to a specific room. */
export async function generateExtensionToken(): Promise<{
  secret: string;
  tokenHash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
  const secret = toHex(bytes.buffer);
  const tokenHash = await sha256hex(secret);
  return { secret, tokenHash };
}
