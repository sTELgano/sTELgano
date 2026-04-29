// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/analytics.ts — the GraphQL query helpers.
// Uses vi.stubGlobal to mock fetch; the write-side (writeEvent) is
// fire-and-forget against an AE binding unavailable in Node and is
// tested implicitly through the worker-runtime tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryCFCountryMetrics,
  queryCountryMetrics,
  queryDiasporaMetrics,
} from "../../src/lib/analytics";

const AE_FIELD = "stelgano_eventsAdaptiveGroups";

function makeResponse(groups: unknown[]): Response {
  const body = JSON.stringify({
    data: {
      viewer: {
        accounts: [{ [AE_FIELD]: groups }],
      },
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("queryCountryMetrics", () => {
  it("returns parsed rows grouped by blob2", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 10, dimensions: { blob1: "room_free", blob2: "KE" } },
          { count: 5, dimensions: { blob1: "room_paid", blob2: "KE" } },
          { count: 20, dimensions: { blob1: "room_free", blob2: "NG" } },
        ]),
      ),
    );

    const result = await queryCountryMetrics("acct", "token", "test_ds");
    // sorted by total descending: NG (20) > KE (15)
    expect(result).toHaveLength(2);
    expect(result[0]!.country_code).toBe("NG");
    expect(result[0]!.free_rooms).toBe(20);
    expect(result[0]!.paid_rooms).toBe(0);
    expect(result[1]!.country_code).toBe("KE");
    expect(result[1]!.free_rooms).toBe(10);
    expect(result[1]!.paid_rooms).toBe(5);
  });

  it("returns [] on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await queryCountryMetrics("acct", "token", "test_ds");
    expect(result).toEqual([]);
  });

  it("returns [] on empty groups", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse([])));

    const result = await queryCountryMetrics("acct", "token", "test_ds");
    expect(result).toEqual([]);
  });
});

describe("queryCFCountryMetrics", () => {
  it("returns parsed rows grouped by blob3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 15, dimensions: { blob1: "room_free", blob3: "US" } },
          { count: 3, dimensions: { blob1: "room_paid", blob3: "US" } },
          { count: 7, dimensions: { blob1: "room_free", blob3: "GB" } },
        ]),
      ),
    );

    const result = await queryCFCountryMetrics("acct", "token", "test_ds");
    // sorted by total: US (18) > GB (7)
    expect(result).toHaveLength(2);
    expect(result[0]!.country_code).toBe("US");
    expect(result[0]!.free_rooms).toBe(15);
    expect(result[0]!.paid_rooms).toBe(3);
    expect(result[1]!.country_code).toBe("GB");
    expect(result[1]!.free_rooms).toBe(7);
    expect(result[1]!.paid_rooms).toBe(0);
  });

  it("skips groups with absent blob3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 10, dimensions: { blob1: "room_free", blob3: "KE" } },
          { count: 5, dimensions: { blob1: "room_free", blob3: "" } },
          { count: 3, dimensions: { blob1: "room_free" } },
        ]),
      ),
    );

    const result = await queryCFCountryMetrics("acct", "token", "test_ds");
    // only KE should survive — empty string and missing blob3 are skipped
    expect(result).toHaveLength(1);
    expect(result[0]!.country_code).toBe("KE");
    expect(result[0]!.free_rooms).toBe(10);
  });
});

describe("queryDiasporaMetrics", () => {
  it("returns (steg_country, cf_country) pairs from blob2+blob3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 12, dimensions: { blob1: "room_free", blob2: "KE", blob3: "GB" } },
          { count: 4, dimensions: { blob1: "room_paid", blob2: "NG", blob3: "US" } },
        ]),
      ),
    );

    const result = await queryDiasporaMetrics("acct", "token", "test_ds");
    expect(result).toHaveLength(2);
    // KE:GB total=12, NG:US total=4 → KE:GB first
    expect(result[0]!.steg_country).toBe("KE");
    expect(result[0]!.cf_country).toBe("GB");
    expect(result[0]!.free_rooms).toBe(12);
    expect(result[0]!.paid_rooms).toBe(0);
    expect(result[1]!.steg_country).toBe("NG");
    expect(result[1]!.cf_country).toBe("US");
    expect(result[1]!.free_rooms).toBe(0);
    expect(result[1]!.paid_rooms).toBe(4);
  });

  it("skips rows where steg_country or cf_country is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 10, dimensions: { blob1: "room_free", blob2: "KE", blob3: "US" } },
          { count: 5, dimensions: { blob1: "room_free", blob2: "", blob3: "US" } },
          { count: 3, dimensions: { blob1: "room_free", blob2: "KE", blob3: "" } },
          { count: 2, dimensions: { blob1: "room_free" } },
        ]),
      ),
    );

    const result = await queryDiasporaMetrics("acct", "token", "test_ds");
    // only the KE:US row survives
    expect(result).toHaveLength(1);
    expect(result[0]!.steg_country).toBe("KE");
    expect(result[0]!.cf_country).toBe("US");
    expect(result[0]!.free_rooms).toBe(10);
  });

  it("correctly accumulates free and paid counts per pair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { count: 8, dimensions: { blob1: "room_free", blob2: "KE", blob3: "GB" } },
          { count: 3, dimensions: { blob1: "room_paid", blob2: "KE", blob3: "GB" } },
          { count: 5, dimensions: { blob1: "room_free", blob2: "KE", blob3: "GB" } },
        ]),
      ),
    );

    const result = await queryDiasporaMetrics("acct", "token", "test_ds");
    expect(result).toHaveLength(1);
    expect(result[0]!.steg_country).toBe("KE");
    expect(result[0]!.cf_country).toBe("GB");
    expect(result[0]!.free_rooms).toBe(13); // 8 + 5
    expect(result[0]!.paid_rooms).toBe(3);
  });

  it("returns [] on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await queryDiasporaMetrics("acct", "token", "test_ds");
    expect(result).toEqual([]);
  });
});
