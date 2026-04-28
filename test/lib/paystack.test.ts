// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/paystack.ts — pure-function helpers and the
// FX conversion path of initialize().

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env";
import { initialize, hmacSha512Hex, timingSafeHexEqual } from "../../src/lib/paystack";

// ---------------------------------------------------------------------------
// Helpers shared across initialize() tests
// ---------------------------------------------------------------------------

const VALID_TOKEN = "a".repeat(64);

function makeKV(rate: number | null): KVNamespace {
  return {
    get: vi.fn(() => Promise.resolve(rate !== null ? String(rate) : null)),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    PAYSTACK_SECRET_KEY: "sk_test_key",
    PAYSTACK_CALLBACK_URL: "https://example.com/payment/callback",
    PAYSTACK_RECEIPT_EMAIL_DOMAIN: "example.com",
    PAYMENT_CURRENCY: "USD",
    MONETIZATION_ENABLED: "true",
    // Satisfy required Cloudflare.Env members that initialize() doesn't use:
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ROOM: {} as DurableObjectNamespace,
    RATE_LIMITER_ADMIN: {} as RateLimit,
    RATE_LIMITER_WS: {} as RateLimit,
    RATE_LIMITER_ROOM_CREATE: {} as RateLimit,
    PHX_HOST: "example.com",
    PRICE_CENTS: "200",
    FREE_TTL_DAYS: "7",
    PAID_TTL_DAYS: "365",
    CF_ACCOUNT_ID: "",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    PAYSTACK_PUBLIC_KEY: "",
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

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

// ---------------------------------------------------------------------------
// initialize() — FX conversion
// ---------------------------------------------------------------------------

describe("initialize() FX conversion", () => {
  it("passes amount unchanged when settlement equals display currency", async () => {
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        if (String(url).includes("paystack")) {
          captured = JSON.parse(opts.body as string);
          return Promise.resolve(new Response(JSON.stringify({ status: false }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    await initialize(VALID_TOKEN, 200, baseEnv());
    expect((captured as { amount: number }).amount).toBe(200);
  });

  it("converts amount using cached rate + 5% default buffer", async () => {
    // 200 USD × 130.0 KES/USD × 1.05 = 27,300 (rounded)
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        if (String(url).includes("paystack")) {
          captured = JSON.parse(opts.body as string);
          return Promise.resolve(new Response(JSON.stringify({ status: false }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const env = baseEnv({
      PAYSTACK_SETTLEMENT_CURRENCY: "KES",
      RATE_CACHE: makeKV(130.0),
    });
    await initialize(VALID_TOKEN, 200, env);
    expect((captured as { amount: number }).amount).toBe(Math.round(200 * 130.0 * 1.05));
  });

  it("respects PAYSTACK_FX_BUFFER_PCT when set", async () => {
    // 200 USD × 130.0 × 1.10 (10% buffer) = 28,600
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        if (String(url).includes("paystack")) {
          captured = JSON.parse(opts.body as string);
          return Promise.resolve(new Response(JSON.stringify({ status: false }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const env = baseEnv({
      PAYSTACK_SETTLEMENT_CURRENCY: "KES",
      PAYSTACK_FX_BUFFER_PCT: "10",
      RATE_CACHE: makeKV(130.0),
    });
    await initialize(VALID_TOKEN, 200, env);
    expect((captured as { amount: number }).amount).toBe(Math.round(200 * 130.0 * 1.1));
  });

  it("uses PAYMENT_FX_FALLBACK_RATE when KV is empty", async () => {
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        if (String(url).includes("paystack")) {
          captured = JSON.parse(opts.body as string);
          return Promise.resolve(new Response(JSON.stringify({ status: false }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const env = baseEnv({
      PAYSTACK_SETTLEMENT_CURRENCY: "KES",
      PAYMENT_FX_FALLBACK_RATE: "125.0",
      RATE_CACHE: makeKV(null),
    });
    await initialize(VALID_TOKEN, 200, env);
    expect((captured as { amount: number }).amount).toBe(Math.round(200 * 125.0 * 1.05));
  });

  it("returns fx_conversion_not_wired when no rate is available", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const env = baseEnv({
      PAYSTACK_SETTLEMENT_CURRENCY: "KES",
      RATE_CACHE: makeKV(null),
      PAYMENT_FX_FALLBACK_RATE: undefined,
    });
    const result = await initialize(VALID_TOKEN, 200, env);
    expect(result).toEqual({ ok: false, reason: "fx_conversion_not_wired" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("sends the settlement currency to Paystack, not the display currency", async () => {
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        if (String(url).includes("paystack")) {
          captured = JSON.parse(opts.body as string);
          return Promise.resolve(new Response(JSON.stringify({ status: false }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const env = baseEnv({
      PAYMENT_CURRENCY: "USD",
      PAYSTACK_SETTLEMENT_CURRENCY: "KES",
      RATE_CACHE: makeKV(130.0),
    });
    await initialize(VALID_TOKEN, 200, env);
    expect((captured as { currency: string }).currency).toBe("KES");
  });
});
