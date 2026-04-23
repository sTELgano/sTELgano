// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @fileoverview PBKDF2 web worker.
 *
 * Runs the 600,000-iteration key derivation off the main thread so the UI
 * stays responsive during the ~1.5–2.5s operation. Same iteration count,
 * same Web Crypto primitives, same security posture as the on-main-thread
 * path — the only difference is execution context.
 *
 * See `assets/js/crypto/anon.js` for the canonical cryptographic
 * specification. The constants below must stay in sync with that file.
 * This is a classic (non-module) worker and therefore cannot `import` —
 * duplication is the cost of avoiding a module-worker + CSP change.
 *
 * Changing any constant here is a breaking change (all existing rooms
 * become inaccessible).
 */

"use strict";

const ENC_SALT = "stelegano-enc-v1-2026";
const PBKDF2_ITER = 600_000;

// Synthetic progress — `crypto.subtle.deriveKey` is atomic and emits no
// progress events. We tick a timer on the worker thread so the UI can show
// "deriving key… 45%" rather than a silent pause. Tuned to reach ~95%
// around the 2s mark on a mid-range mobile device, then hold until the
// real operation completes and we snap to 100%.
const PROGRESS_TICK_MS = 100;
const PROGRESS_TARGET_MS = 2000;
const PROGRESS_CAP_PCT = 95;

function normalise(raw) {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

function encode(s) {
  return new TextEncoder().encode(s);
}

async function derive(phone, roomId) {
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
    false,
    ["encrypt", "decrypt"]
  );
}

self.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.type !== "derive") return;

  const startedAt = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const percent = Math.min(
      PROGRESS_CAP_PCT,
      Math.round((elapsed / PROGRESS_TARGET_MS) * PROGRESS_CAP_PCT)
    );
    self.postMessage({ type: "progress", percent });
  }, PROGRESS_TICK_MS);

  try {
    const key = await derive(data.phone, data.roomId);
    clearInterval(progressInterval);
    self.postMessage({ type: "progress", percent: 100 });
    self.postMessage({ type: "done", key });
  } catch (err) {
    clearInterval(progressInterval);
    self.postMessage({
      type: "error",
      message: (err && err.message) || String(err),
    });
  }
});
