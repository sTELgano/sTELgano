// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/paystack.ts — the pure-function helpers
// only (HMAC, timing-safe compare). The fetch-based functions
// (initialize, verifyTransaction) need the Worker runtime and
// network mocking; those get Phase 9b.

import { describe, expect, it } from "vitest";

import { hmacSha512Hex, timingSafeHexEqual } from "../../src/lib/paystack";

describe("hmacSha512Hex", () => {
  it("matches a known RFC 4231 test vector", async () => {
    // RFC 4231 §4.2 test case 1: key="Jefe" (4 bytes),
    // data="what do ya want for nothing?".
    const got = await hmacSha512Hex("Jefe", "what do ya want for nothing?");
    expect(got).toBe(
      "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
    );
  });

  it("returns 128 hex chars (SHA-512 = 64 bytes)", async () => {
    const hex = await hmacSha512Hex("k", "payload");
    expect(hex).toMatch(/^[a-f0-9]{128}$/);
  });

  it("different secrets produce different hashes", async () => {
    const a = await hmacSha512Hex("secret-a", "msg");
    const b = await hmacSha512Hex("secret-b", "msg");
    expect(a).not.toBe(b);
  });

  it("different payloads produce different hashes", async () => {
    const a = await hmacSha512Hex("secret", "msg-a");
    const b = await hmacSha512Hex("secret", "msg-b");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeHexEqual", () => {
  it("returns true for identical strings", () => {
    const a = "abcdef0123456789".repeat(8);
    expect(timingSafeHexEqual(a, a)).toBe(true);
  });

  it("returns false when strings differ by one character", () => {
    const a = "abcdef0123456789".repeat(8);
    const b = a.replace(/.$/, "0");
    expect(timingSafeHexEqual(a, b)).toBe(false);
  });

  it("returns false on length mismatch (short-circuits)", () => {
    expect(timingSafeHexEqual("abc", "abcd")).toBe(false);
    expect(timingSafeHexEqual("", "a")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeHexEqual("", "")).toBe(true);
  });
});
