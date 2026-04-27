// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/fx_rate.ts.
// Mocks fetch (for refreshRate) and KVNamespace (for getRate/refreshRate)
// so no real network or Workers runtime is needed.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRate, refreshRate } from "../../src/lib/fx_rate";

// ---------------------------------------------------------------------------
// KV mock
// ---------------------------------------------------------------------------

function makeMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Fawazahmed0 API response mock
// ---------------------------------------------------------------------------

function makeApiResponse(base: string, rates: Record<string, number>): Response {
  return new Response(JSON.stringify({ date: "2025-01-01", [base]: rates }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getRate()
// ---------------------------------------------------------------------------

describe("getRate", () => {
  it("returns rate from KV when the key is present", async () => {
    const kv = makeMockKV({ "fx:usd:kes": "130.5" });
    const rate = await getRate(kv, "USD", "KES");
    expect(rate).toBe(130.5);
  });

  it("is case-insensitive for base and quote", async () => {
    const kv = makeMockKV({ "fx:usd:kes": "130.5" });
    expect(await getRate(kv, "usd", "kes")).toBe(130.5);
    expect(await getRate(kv, "USD", "KES")).toBe(130.5);
    expect(await getRate(kv, "Usd", "Kes")).toBe(130.5);
  });

  it("falls back to fallback string when KV key is absent", async () => {
    const kv = makeMockKV({});
    const rate = await getRate(kv, "USD", "KES", "128.0");
    expect(rate).toBe(128.0);
  });

  it("returns null when KV is absent and no fallback given", async () => {
    const kv = makeMockKV({});
    const rate = await getRate(kv, "USD", "KES");
    expect(rate).toBeNull();
  });

  it("returns null when both KV and fallback are absent", async () => {
    expect(await getRate(undefined, "USD", "KES")).toBeNull();
    expect(await getRate(undefined, "USD", "KES", undefined)).toBeNull();
  });

  it("skips undefined KV and uses fallback directly", async () => {
    const rate = await getRate(undefined, "USD", "KES", "130.0");
    expect(rate).toBe(130.0);
  });

  it("ignores a non-positive cached value and falls back", async () => {
    const kv = makeMockKV({ "fx:usd:kes": "-5" });
    const rate = await getRate(kv, "USD", "KES", "130.0");
    expect(rate).toBe(130.0);
  });

  it("ignores NaN cached value and falls back", async () => {
    const kv = makeMockKV({ "fx:usd:kes": "not-a-number" });
    const rate = await getRate(kv, "USD", "KES", "130.0");
    expect(rate).toBe(130.0);
  });

  it("ignores non-positive fallback and returns null", async () => {
    const kv = makeMockKV({});
    expect(await getRate(kv, "USD", "KES", "0")).toBeNull();
    expect(await getRate(kv, "USD", "KES", "-1")).toBeNull();
  });

  it("ignores NaN fallback and returns null", async () => {
    const rate = await getRate(undefined, "USD", "KES", "bad");
    expect(rate).toBeNull();
  });

  it("prefers KV over fallback when both are present", async () => {
    const kv = makeMockKV({ "fx:usd:kes": "130.5" });
    const rate = await getRate(kv, "USD", "KES", "999.0");
    expect(rate).toBe(130.5);
  });
});

// ---------------------------------------------------------------------------
// refreshRate()
// ---------------------------------------------------------------------------

describe("refreshRate", () => {
  it("fetches from the Fawazahmed0 API and returns the rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeApiResponse("usd", { kes: 130.5 })));
    const kv = makeMockKV();
    const rate = await refreshRate(kv, "USD", "KES");
    expect(rate).toBe(130.5);
  });

  it("writes the rate to KV under the correct key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeApiResponse("usd", { kes: 130.5 })));
    const kv = makeMockKV();
    await refreshRate(kv, "USD", "KES");
    expect(kv.put).toHaveBeenCalledWith("fx:usd:kes", "130.5", expect.objectContaining({ expirationTtl: 25 * 3600 }));
  });

  it("uses lowercase base/quote for KV key regardless of input case", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeApiResponse("usd", { kes: 130.5 })));
    const kv = makeMockKV();
    await refreshRate(kv, "USD", "KES");
    expect(kv.put).toHaveBeenCalledWith("fx:usd:kes", expect.any(String), expect.any(Object));
  });

  it("returns null on network error (fetch throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const kv = makeMockKV();
    const rate = await refreshRate(kv, "USD", "KES");
    expect(rate).toBeNull();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns null on non-2xx HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 500 })));
    const kv = makeMockKV();
    const rate = await refreshRate(kv, "USD", "KES");
    expect(rate).toBeNull();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns null when quote is absent from the API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeApiResponse("usd", { eur: 0.92 })),
    );
    const kv = makeMockKV();
    const rate = await refreshRate(kv, "USD", "KES");
    expect(rate).toBeNull();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns null on malformed (non-JSON) API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    const kv = makeMockKV();
    const rate = await refreshRate(kv, "USD", "KES");
    expect(rate).toBeNull();
  });

  it("returns null when the rate value is zero or negative", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeApiResponse("usd", { kes: 0 })));
    const kv = makeMockKV();
    expect(await refreshRate(kv, "USD", "KES")).toBeNull();
  });

  it("makes the rate available via getRate after a successful refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeApiResponse("usd", { kes: 130.5 })));
    const kv = makeMockKV();
    await refreshRate(kv, "USD", "KES");
    const rate = await getRate(kv, "USD", "KES");
    expect(rate).toBe(130.5);
  });
});
