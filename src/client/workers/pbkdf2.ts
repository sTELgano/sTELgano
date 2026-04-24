// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />
//
// PBKDF2 web worker. Runs the 600,000-iteration key derivation off
// the main thread so the UI stays responsive during the ~1.5–2.5s
// operation.
//
// Direct port of elixir/assets/js/workers/pbkdf2_worker.js.
//
// Constants below MUST stay in lockstep with src/client/crypto/anon.ts
// — this is a classic (non-module) worker that cannot import, so
// duplication is the cost of avoiding a module-worker + CSP change.
// Changing any constant here is a breaking change (all existing rooms
// become inaccessible).

const ENC_SALT = "stelegano-enc-v1-2026";
const PBKDF2_ITER = 600_000;

// Synthetic progress — crypto.subtle.deriveKey is atomic and emits no
// progress events. We tick a timer so the UI can show "deriving key…
// 45%" rather than a silent pause. Tuned to reach ~95% around the 2s
// mark on a mid-range mobile device, then hold until the real
// operation completes and we snap to 100%.
const PROGRESS_TICK_MS = 100;
const PROGRESS_TARGET_MS = 2000;
const PROGRESS_CAP_PCT = 95;

function normalise(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

// TextEncoder always allocates a fresh non-shared ArrayBuffer; cast
// narrows the generic so Web Crypto APIs accept the result directly.
function encode(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

async function derive(phone: string, roomId: string): Promise<CryptoKey> {
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
    false,
    ["encrypt", "decrypt"],
  );
}

type DeriveMessage = { type: "derive"; phone: string; roomId: string };

self.addEventListener("message", async (event: MessageEvent<DeriveMessage>) => {
  const data = event.data;
  if (!data || data.type !== "derive") return;

  const startedAt = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const percent = Math.min(
      PROGRESS_CAP_PCT,
      Math.round((elapsed / PROGRESS_TARGET_MS) * PROGRESS_CAP_PCT),
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
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
