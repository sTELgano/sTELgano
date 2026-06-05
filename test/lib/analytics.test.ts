// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/analytics.ts — the SQL API query helpers.
// Uses vi.stubGlobal to mock fetch; the write-side (writeEvent) is
// fire-and-forget against an AE binding unavailable in Node and is
// tested implicitly through the worker-runtime tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FUNNEL_STEPS,
  isFunnelStep,
  queryCFCountryMetrics,
  queryCountryMetrics,
  queryDailyMetrics,
  queryDiasporaMetrics,
  queryFunnelMetrics,
  sumFunnels,
} from "../../src/lib/analytics";

function makeResponse(rows: unknown[]): Response {
  const body = JSON.stringify({ data: rows });
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
          { blob1: "room_free", blob2: "KE", cnt: 10 },
          { blob1: "room_paid", blob2: "KE", cnt: 5 },
          { blob1: "room_free", blob2: "NG", cnt: 20 },
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

  it("returns [] on empty rows", async () => {
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
          { blob1: "room_free", blob3: "US", cnt: 15 },
          { blob1: "room_paid", blob3: "US", cnt: 3 },
          { blob1: "room_free", blob3: "GB", cnt: 7 },
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

  it("skips rows with absent blob3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { blob1: "room_free", blob3: "KE", cnt: 10 },
          { blob1: "room_free", blob3: "", cnt: 5 },
          { blob1: "room_free", cnt: 3 },
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
          { blob1: "room_free", blob2: "KE", blob3: "GB", cnt: 12 },
          { blob1: "room_paid", blob2: "NG", blob3: "US", cnt: 4 },
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
          { blob1: "room_free", blob2: "KE", blob3: "US", cnt: 10 },
          { blob1: "room_free", blob2: "", blob3: "US", cnt: 5 },
          { blob1: "room_free", blob2: "KE", blob3: "", cnt: 3 },
          { blob1: "room_free", cnt: 2 },
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
          { blob1: "room_free", blob2: "KE", blob3: "GB", cnt: 8 },
          { blob1: "room_paid", blob2: "KE", blob3: "GB", cnt: 3 },
          { blob1: "room_free", blob2: "KE", blob3: "GB", cnt: 5 },
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

describe("queryDailyMetrics", () => {
  it("counts renewals (room_extended) separately from new paid rooms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { blob1: "room_free", day: "2026-06-04", cnt: 1 },
          { blob1: "room_paid", day: "2026-06-04", cnt: 1 },
          { blob1: "room_extended", day: "2026-06-04", cnt: 2 },
          { blob1: "message_sent", day: "2026-06-04", cnt: 5 },
        ]),
      ),
    );

    const result = await queryDailyMetrics("acct", "token", 30, "test_ds");
    expect(result).toHaveLength(1);
    const row = result[0]!;
    // One number created free, upgraded once (paid_new=1), extended twice
    // more (extensions=2) — NOT three paid rooms.
    expect(row.free_new).toBe(1);
    expect(row.paid_new).toBe(1);
    expect(row.extensions).toBe(2);
    expect(row.messages_sent).toBe(5);
  });

  it("returns [] on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await queryDailyMetrics("acct", "token", 30, "test_ds")).toEqual([]);
  });
});

describe("isFunnelStep", () => {
  it("accepts every declared step and rejects anything else", () => {
    for (const s of FUNNEL_STEPS) expect(isFunnelStep(s)).toBe(true);
    expect(isFunnelStep("room_free")).toBe(false);
    expect(isFunnelStep("")).toBe(false);
    expect(isFunnelStep(undefined)).toBe(false);
    expect(isFunnelStep(42)).toBe(false);
  });

  it("keeps landing first and extend_completed last (funnel order)", () => {
    expect(FUNNEL_STEPS[0]).toBe("landing");
    expect(FUNNEL_STEPS[FUNNEL_STEPS.length - 1]).toBe("extend_completed");
  });
});

describe("queryFunnelMetrics", () => {
  it("groups counts per campaign with every step key present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { blob2: "landing", blob4: "summer", cnt: 100 },
          { blob2: "chat_view", blob4: "summer", cnt: 60 },
          { blob2: "channel_opened", blob4: "summer", cnt: 25 },
          { blob2: "landing", blob4: "direct", cnt: 40 },
        ]),
      ),
    );

    const result = await queryFunnelMetrics("acct", "token", "test_ds");
    // sorted by landing desc → summer (100) before direct (40)
    expect(result).toHaveLength(2);
    expect(result[0]!.campaign).toBe("summer");
    expect(result[0]!.steps.landing).toBe(100);
    expect(result[0]!.steps.chat_view).toBe(60);
    expect(result[0]!.steps.channel_opened).toBe(25);
    // unseen steps default to 0
    expect(result[0]!.steps.extend_completed).toBe(0);
    expect(result[1]!.campaign).toBe("direct");
    expect(result[1]!.steps.landing).toBe(40);
  });

  it("buckets empty/absent campaign as 'direct' and ignores unknown steps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse([
          { blob2: "landing", blob4: "", cnt: 5 },
          { blob2: "landing", cnt: 3 },
          { blob2: "not_a_step", blob4: "summer", cnt: 99 },
        ]),
      ),
    );

    const result = await queryFunnelMetrics("acct", "token", "test_ds");
    expect(result).toHaveLength(1);
    expect(result[0]!.campaign).toBe("direct");
    expect(result[0]!.steps.landing).toBe(8); // 5 + 3
  });

  it("returns [] on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await queryFunnelMetrics("acct", "token", "test_ds")).toEqual([]);
  });
});

describe("sumFunnels", () => {
  it("sums each step across every campaign into one platform funnel", () => {
    const total = sumFunnels([
      {
        campaign: "summer",
        steps: {
          landing: 100,
          chat_view: 60,
          steg_generated: 40,
          channel_opened: 25,
          extend_started: 8,
          extend_completed: 5,
        },
      },
      {
        campaign: "direct",
        steps: {
          landing: 40,
          chat_view: 20,
          steg_generated: 10,
          channel_opened: 6,
          extend_started: 2,
          extend_completed: 1,
        },
      },
    ]);
    expect(total.landing).toBe(140);
    expect(total.chat_view).toBe(80);
    expect(total.channel_opened).toBe(31);
    expect(total.extend_completed).toBe(6);
  });

  it("returns an all-zero funnel for no input", () => {
    const total = sumFunnels([]);
    expect(total.landing).toBe(0);
    expect(total.extend_completed).toBe(0);
  });
});
