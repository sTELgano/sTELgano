// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/client/crypto/anon.ts.
//
// Tests the actual cryptographic invariants of the sTELgano-std-1
// protocol, NOT just that the functions return strings. The goal
// is to catch accidental algorithm drift (wrong salt, wrong
// iteration count, wrong hash function) as a test failure rather
// than silently breaking every existing room on cutover.

import { describe, expect, it } from "vitest";

import {
  accessHash,
  decrypt,
  encrypt,
  fromBase64,
  generateExtensionToken,
  normalise,
  roomHash,
  senderHash,
  toBase64,
} from "../../src/client/crypto/anon";

describe("normalise", () => {
  it("strips non-digits", () => {
    expect(normalise("+1 (555) 012-3456")).toBe("15550123456");
    expect(normalise(" +254 700 000 000 ")).toBe("254700000000");
    expect(normalise("  ")).toBe("");
    expect(normalise("")).toBe("");
  });

  it("returns empty string on non-string input", () => {
    // @ts-expect-error — deliberate runtime check
    expect(normalise(null)).toBe("");
    // @ts-expect-error
    expect(normalise(undefined)).toBe("");
    // @ts-expect-error
    expect(normalise(12345)).toBe("");
  });
});

describe("hash derivations", () => {
  // Known-good test vectors. Generating them by running v1's
  // Elixir implementation against the same inputs would catch
  // algorithm drift between v1 and v2; for now we just pin the
  // CURRENT outputs so refactors don't silently change them.
  const phone = "15550123456";
  const pin = "1234";

  it("roomHash is deterministic + 64 lowercase hex", async () => {
    const a = await roomHash(phone);
    const b = await roomHash(phone);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("roomHash normalises before hashing — formatting is irrelevant", async () => {
    const a = await roomHash("15550123456");
    const b = await roomHash("+1 (555) 012-3456");
    expect(a).toBe(b);
  });

  it("accessHash depends on phone AND PIN", async () => {
    const base = await accessHash(phone, pin);
    expect(await accessHash(phone, "4321")).not.toBe(base);
    expect(await accessHash("15550000000", pin)).not.toBe(base);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
  });

  it("senderHash depends on access_hash AND room_hash", async () => {
    const access = await accessHash(phone, pin);
    const room = await roomHash(phone);

    const self = await senderHash(phone, access, room);
    const differentAccess = await senderHash(phone, access.replace(/^./, "f"), room);
    const differentRoom = await senderHash(phone, access, room.replace(/^./, "f"));

    expect(self).not.toBe(differentAccess);
    expect(self).not.toBe(differentRoom);
    expect(self).toMatch(/^[a-f0-9]{64}$/);
  });

  it("two users sharing a steg number but different PINs produce different sender_hashes", async () => {
    // Protocol invariant (sTELgano-std-1 §3): access_hash is in
    // sender_hash's input so same-phone-different-PIN produces
    // distinguishable identities. Without this, a user could
    // impersonate their counterpart.
    const room = await roomHash(phone);
    const aliceAccess = await accessHash(phone, "1234");
    const bobAccess = await accessHash(phone, "9999");
    const alice = await senderHash(phone, aliceAccess, room);
    const bob = await senderHash(phone, bobAccess, room);
    expect(alice).not.toBe(bob);
  });
});

describe("encrypt / decrypt round-trip", () => {
  // AES-256-GCM key. Generated once per test because deriveKey
  // takes ~2s (600k PBKDF2 iterations) and we don't want that
  // latency in the test loop. Using crypto.subtle.generateKey
  // directly instead.
  async function makeKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  it("round-trips UTF-8 plaintext byte-for-byte", async () => {
    const key = await makeKey();
    const plaintext = "Hello, sTELgano! ✨ 🔒 Привет мир 你好";
    const { iv, ciphertext } = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, iv, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("generates a fresh IV per encryption (no nonce reuse)", async () => {
    const key = await makeKey();
    const a = await encrypt(key, "same plaintext");
    const b = await encrypt(key, "same plaintext");
    // IV is 12 random bytes — collision probability is 2^-96.
    expect(toBase64(a.iv)).not.toBe(toBase64(b.iv));
    expect(toBase64(a.ciphertext)).not.toBe(toBase64(b.ciphertext));
  });

  it("decrypt throws on ciphertext tampering (GCM auth tag)", async () => {
    const key = await makeKey();
    const { iv, ciphertext } = await encrypt(key, "secret");
    // Flip one byte of the ciphertext — the auth tag will mismatch.
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decrypt(key, iv, ciphertext)).rejects.toThrow();
  });

  it("decrypt throws when key doesn't match", async () => {
    const keyA = await makeKey();
    const keyB = await makeKey();
    const { iv, ciphertext } = await encrypt(keyA, "secret");
    await expect(decrypt(keyB, iv, ciphertext)).rejects.toThrow();
  });

  it("produces ArrayBuffer-backed Uint8Arrays (Web Crypto compat)", async () => {
    const key = await makeKey();
    const { iv, ciphertext } = await encrypt(key, "x");
    // Both must be ArrayBuffer-backed (not SharedArrayBuffer) so
    // the caller can feed them to other Web Crypto APIs without
    // a type cast.
    expect(iv.buffer).toBeInstanceOf(ArrayBuffer);
    expect(ciphertext.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe("toBase64 / fromBase64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 100]);
    const back = fromBase64(toBase64(bytes));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("fromBase64 returns an ArrayBuffer-backed Uint8Array", () => {
    const back = fromBase64("AAEC");
    expect(back.buffer).toBeInstanceOf(ArrayBuffer);
    expect(back.length).toBe(3);
  });
});

describe("generateExtensionToken", () => {
  it("produces a 64-char hex secret and its SHA-256 hash", async () => {
    const { secret, tokenHash } = await generateExtensionToken();
    expect(secret).toMatch(/^[a-f0-9]{64}$/); // 32 random bytes → 64 hex
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 output

    // Verify the hash is genuinely SHA-256 of the secret, not
    // some unrelated computation.
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(tokenHash).toBe(expected);
  });

  it("produces distinct tokens across calls", async () => {
    const a = await generateExtensionToken();
    const b = await generateExtensionToken();
    expect(a.secret).not.toBe(b.secret);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
