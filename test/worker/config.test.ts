// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /api/config — exposes monetization/TTL/price settings to the client.
// The price is geo-resolved (per CF-IPCountry), so the response MUST carry
// `cache-control: no-store` to keep a shared cache from serving one country's
// price to another.

// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /api/config", () => {
  it("returns the config JSON and opts out of shared caching", async () => {
    const res = await SELF.fetch("https://example.com/api/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Geo-varying → must not be cached by any shared cache.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      price_cents: number;
      currency: string;
      free_ttl_days: number;
      paid_ttl_days: number;
    };
    expect(typeof body.price_cents).toBe("number");
    expect(body.price_cents).toBeGreaterThan(0);
    expect(body.currency).toBe("USD");
    expect(body.free_ttl_days).toBeGreaterThan(0);
    expect(body.paid_ttl_days).toBeGreaterThan(0);
  });

  it("resolves the price from CF-IPCountry (high-income tier)", async () => {
    // The test env (wrangler.test.toml) sets PRICE_CENTS=200 and no PRICE_TIERS,
    // so a high-income country resolves to the default high tier (1200) while an
    // uncategorised request falls back to the base (200).
    const us = await SELF.fetch("https://example.com/api/config", {
      cf: { country: "US" },
    } as RequestInit);
    const usBody = (await us.json()) as { price_cents: number };
    expect(usBody.price_cents).toBe(1200);
  });
});
