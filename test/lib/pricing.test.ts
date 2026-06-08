// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/pricing.ts — income-tiered, geo-aware pricing.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env";
import { DEFAULT_TIER_CENTS, resolvePrice } from "../../src/lib/pricing";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    PAYMENT_CURRENCY: "USD",
    PRICE_CENTS: "500",
    ...overrides,
  } as unknown as Env;
}

describe("resolvePrice", () => {
  it("prices each income tier from its default", () => {
    expect(resolvePrice("US", env()).cents).toBe(DEFAULT_TIER_CENTS.high); // 1200
    expect(resolvePrice("BR", env()).cents).toBe(DEFAULT_TIER_CENTS.upper); // 800
    expect(resolvePrice("KE", env()).cents).toBe(DEFAULT_TIER_CENTS.lower); // 400
    expect(resolvePrice("ET", env()).cents).toBe(DEFAULT_TIER_CENTS.low); // 200
  });

  it("falls back to base PRICE_CENTS for an uncategorised country", () => {
    expect(resolvePrice("ZZ", env()).cents).toBe(500);
  });

  it("falls back to base for an empty/null/undefined country", () => {
    expect(resolvePrice("", env()).cents).toBe(500);
    expect(resolvePrice(null, env()).cents).toBe(500);
    expect(resolvePrice(undefined, env()).cents).toBe(500);
  });

  it("is case-insensitive on the country code", () => {
    expect(resolvePrice("us", env()).cents).toBe(DEFAULT_TIER_CENTS.high);
  });

  it("applies per-tier overrides from PRICE_TIERS", () => {
    const e = env({ PRICE_TIERS: '{"high":50,"upper":40,"lower":20,"low":10}' });
    expect(resolvePrice("US", e).cents).toBe(50);
    expect(resolvePrice("BR", e).cents).toBe(40);
    expect(resolvePrice("KE", e).cents).toBe(20);
    expect(resolvePrice("ET", e).cents).toBe(10);
  });

  it("leaves un-overridden tiers at their defaults (partial override)", () => {
    const e = env({ PRICE_TIERS: '{"high":50}' });
    expect(resolvePrice("US", e).cents).toBe(50); // overridden
    expect(resolvePrice("BR", e).cents).toBe(DEFAULT_TIER_CENTS.upper); // default
  });

  it("ignores non-positive / non-integer tier overrides", () => {
    expect(resolvePrice("US", env({ PRICE_TIERS: '{"high":0}' })).cents).toBe(
      DEFAULT_TIER_CENTS.high,
    );
    expect(resolvePrice("US", env({ PRICE_TIERS: '{"high":-5}' })).cents).toBe(
      DEFAULT_TIER_CENTS.high,
    );
    expect(resolvePrice("US", env({ PRICE_TIERS: '{"high":12.5}' })).cents).toBe(
      DEFAULT_TIER_CENTS.high,
    );
    expect(resolvePrice("US", env({ PRICE_TIERS: '{"high":"50"}' })).cents).toBe(
      DEFAULT_TIER_CENTS.high,
    );
  });

  it("falls back to default tiers on malformed PRICE_TIERS (never throws)", () => {
    expect(resolvePrice("US", env({ PRICE_TIERS: "not json" })).cents).toBe(
      DEFAULT_TIER_CENTS.high,
    );
  });

  it("carries the configured currency", () => {
    expect(resolvePrice("US", env({ PAYMENT_CURRENCY: "GHS" })).currency).toBe("GHS");
  });

  it("defaults the base to 200 when PRICE_CENTS is unset (uncategorised country)", () => {
    expect(resolvePrice("ZZ", env({ PRICE_CENTS: undefined })).cents).toBe(200);
  });
});
