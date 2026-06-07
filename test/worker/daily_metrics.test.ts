// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker-runtime tests for the analytics store: the queue consumer's
// coalesced batched UPSERT (flushMetricBatch) and every dashboard read
// helper, exercised against a real workerd D1 instance.

// @ts-expect-error — see healthz.test.ts for why this expect-error lives here.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  flushMetricBatch,
  type MetricMessage,
  queryCfCountryRange,
  queryCountryRange,
  queryDailyTrend,
  queryDiasporaRange,
  queryFunnelRange,
  queryHistogram,
  queryPricing,
  queryRange,
  queryRevenueByCountry,
  queryTotals,
} from "../../src/lib/daily_metrics";

const DB = env.DB as D1Database;
// A fixed past month (June 2020), deliberately NOT today's date: storage
// isolation is off, so seeding in an unused year keeps these exact-count
// assertions immune to any real-dated stray metric writes from other suites.
const DAY = (d: number) => Date.UTC(2020, 5, d);

function msg(partial: Partial<MetricMessage> & { metric: MetricMessage["metric"] }): MetricMessage {
  return {
    stegCountry: "",
    cfCountry: "",
    dim: "",
    value: 0,
    ts: DAY(7),
    ...partial,
  };
}

beforeEach(async () => {
  await DB.prepare("DELETE FROM daily_metrics").run();
});

describe("flushMetricBatch", () => {
  it("inserts coalesced rows and is additive on re-run (UPSERT)", async () => {
    const batch = [
      msg({ metric: "message_sent", stegCountry: "KE", cfCountry: "KE" }),
      msg({ metric: "message_sent", stegCountry: "KE", cfCountry: "KE" }),
      msg({ metric: "room_free", stegCountry: "KE", cfCountry: "KE" }),
    ];
    await flushMetricBatch(DB, batch);

    let rows = await queryRange(DB, "2020-06-01", "2020-06-30");
    expect(rows.find((r) => r.metric === "message_sent")?.count).toBe(2);
    expect(rows.find((r) => r.metric === "room_free")?.count).toBe(1);

    // Re-running the same batch ADDS (does not duplicate rows).
    await flushMetricBatch(DB, batch);
    rows = await queryRange(DB, "2020-06-01", "2020-06-30");
    expect(rows.filter((r) => r.metric === "message_sent")).toHaveLength(1);
    expect(rows.find((r) => r.metric === "message_sent")?.count).toBe(4);
  });

  it("sums sum_value for distribution metrics", async () => {
    await flushMetricBatch(DB, [
      msg({ metric: "room_lifespan", dim: "1-24h", value: 2 }),
      msg({ metric: "room_lifespan", dim: "1-24h", value: 3 }),
    ]);
    const rows = await queryRange(DB, "2020-06-01", "2020-06-30");
    expect(rows[0]).toMatchObject({ metric: "room_lifespan", count: 2, sumValue: 5 });
  });

  it("applies the whole batch in a single db.batch() round-trip", async () => {
    let batchCalls = 0;
    const proxy = new Proxy(DB, {
      get(target, prop, recv) {
        if (prop === "batch") {
          return (stmts: D1PreparedStatement[]) => {
            batchCalls++;
            return (target as unknown as { batch: (s: unknown) => unknown }).batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;

    await flushMetricBatch(
      proxy,
      Array.from({ length: 50 }, (_, i) =>
        msg({ metric: "room_free", stegCountry: `C${i % 7}`, cfCountry: "KE" }),
      ),
    );
    expect(batchCalls).toBe(1);
  });

  it("is a no-op for an empty batch", async () => {
    await flushMetricBatch(DB, []);
    expect(await queryRange(DB, "2020-06-01", "2020-06-30")).toEqual([]);
  });

  it("propagates a D1 error so the queue retries the batch", async () => {
    const badDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        throw new Error("d1 unavailable");
      },
    } as unknown as D1Database;
    await expect(flushMetricBatch(badDb, [msg({ metric: "room_free" })])).rejects.toThrow();
  });
});

describe("read helpers", () => {
  beforeEach(async () => {
    await flushMetricBatch(DB, [
      // day 1
      msg({ metric: "room_free", stegCountry: "KE", cfCountry: "KE", ts: DAY(1) }),
      msg({ metric: "room_paid", stegCountry: "KE", cfCountry: "GB", ts: DAY(1) }),
      msg({ metric: "message_sent", stegCountry: "KE", cfCountry: "KE", ts: DAY(1) }),
      // day 7
      msg({ metric: "room_free", stegCountry: "US", cfCountry: "US", ts: DAY(7) }),
      msg({ metric: "message_sent", stegCountry: "US", cfCountry: "US", ts: DAY(7) }),
      msg({ metric: "message_sent", stegCountry: "US", cfCountry: "US", ts: DAY(7) }),
      // distributions + security (global)
      msg({ metric: "room_lifespan", dim: "1-24h", value: 10, ts: DAY(7) }),
      msg({ metric: "time_to_first_message", dim: "<1m", value: 30, ts: DAY(7) }),
      msg({ metric: "access_failed", ts: DAY(7) }),
      // funnel
      msg({ metric: "funnel_landing", dim: "promo", cfCountry: "KE", ts: DAY(7) }),
      msg({ metric: "funnel_landing", dim: "promo", cfCountry: "KE", ts: DAY(7) }),
      msg({ metric: "funnel_channel_opened", dim: "promo", cfCountry: "KE", ts: DAY(7) }),
      msg({ metric: "funnel_landing", ts: DAY(7) }), // dim '' → "direct"
    ]);
  });

  it("queryTotals sums count and sum_value per metric across the range", async () => {
    const totals = await queryTotals(DB, "2020-06-01", "2020-06-30");
    const by = (m: string) => totals.find((t) => t.metric === m);
    expect(by("room_free")?.count).toBe(2);
    expect(by("message_sent")?.count).toBe(3);
    expect(by("room_lifespan")).toMatchObject({ count: 1, sumValue: 10 });
  });

  it("queryDailyTrend returns per-day counts only for requested metrics", async () => {
    const trend = await queryDailyTrend(DB, "2020-06-01", "2020-06-30", [
      "room_free",
      "message_sent",
    ]);
    const cell = (day: string, m: string) =>
      trend.find((r) => r.day === day && r.metric === m)?.count ?? 0;
    expect(cell("2020-06-01", "room_free")).toBe(1);
    expect(cell("2020-06-07", "message_sent")).toBe(2);
    expect(trend.some((r) => r.metric === "room_paid")).toBe(false);
  });

  it("queryCountryRange / queryCfCountryRange split free vs paid by country", async () => {
    const steg = await queryCountryRange(DB, "2020-06-01", "2020-06-30");
    expect(steg.find((r) => r.country_code === "KE")).toMatchObject({
      free_rooms: 1,
      paid_rooms: 1,
    });
    expect(steg.find((r) => r.country_code === "US")).toMatchObject({
      free_rooms: 1,
      paid_rooms: 0,
    });

    const cf = await queryCfCountryRange(DB, "2020-06-01", "2020-06-30");
    expect(cf.find((r) => r.country_code === "GB")).toMatchObject({ paid_rooms: 1 });
  });

  it("queryDiasporaRange keys on (steg, cf) pairs", async () => {
    const rows = await queryDiasporaRange(DB, "2020-06-01", "2020-06-30");
    const pair = rows.find((r) => r.steg_country === "KE" && r.cf_country === "GB");
    expect(pair).toMatchObject({ paid_rooms: 1 });
  });

  it("queryHistogram returns bucket counts for a distribution metric", async () => {
    const hist = await queryHistogram(DB, "2020-06-01", "2020-06-30", "room_lifespan");
    expect(hist).toEqual([{ bucket: "1-24h", count: 1 }]);
  });

  it("queryFunnelRange rebuilds per-campaign funnels (dim → campaign, '' → direct)", async () => {
    const funnels = await queryFunnelRange(DB, "2020-06-01", "2020-06-30");
    const promo = funnels.find((f) => f.campaign === "promo");
    expect(promo?.steps.landing).toBe(2);
    expect(promo?.steps.channel_opened).toBe(1);
    expect(funnels.find((f) => f.campaign === "direct")?.steps.landing).toBe(1);
  });

  it("filters days inclusively at both ends", async () => {
    // Range starting on day 7 excludes the day-1 rows.
    const day7 = await queryTotals(DB, "2020-06-07", "2020-06-07");
    expect(day7.find((t) => t.metric === "room_free")?.count).toBe(1); // only the US/day-7 one
    const day1 = await queryTotals(DB, "2020-06-01", "2020-06-01");
    expect(day1.find((t) => t.metric === "message_sent")?.count).toBe(1);
  });

  it("queryPricing groups sales by price point with units + revenue", async () => {
    await flushMetricBatch(DB, [
      msg({ metric: "paid_sale", dim: "USD_200", value: 200, stegCountry: "KE", ts: DAY(2) }),
      msg({ metric: "paid_sale", dim: "USD_200", value: 200, stegCountry: "US", ts: DAY(2) }),
      msg({ metric: "paid_sale", dim: "USD_1000", value: 1000, stegCountry: "KE", ts: DAY(2) }),
    ]);
    const pricing = await queryPricing(DB, "2020-06-01", "2020-06-30");
    const at = (p: string) => pricing.find((r) => r.price === p);
    expect(at("USD_200")).toMatchObject({ units: 2, revenueMinor: 400 });
    expect(at("USD_1000")).toMatchObject({ units: 1, revenueMinor: 1000 });
  });

  it("queryRevenueByCountry groups sales by steg country", async () => {
    await flushMetricBatch(DB, [
      msg({ metric: "paid_sale", dim: "USD_200", value: 200, stegCountry: "KE", ts: DAY(2) }),
      msg({ metric: "paid_sale", dim: "USD_1000", value: 1000, stegCountry: "KE", ts: DAY(2) }),
      msg({ metric: "paid_sale", dim: "USD_200", value: 200, stegCountry: "US", ts: DAY(2) }),
    ]);
    const rev = await queryRevenueByCountry(DB, "2020-06-01", "2020-06-30");
    expect(rev.find((r) => r.country_code === "KE")).toMatchObject({
      units: 2,
      revenueMinor: 1200,
    });
    expect(rev.find((r) => r.country_code === "US")).toMatchObject({ units: 1, revenueMinor: 200 });
  });

  it("queryHistogram surfaces the extension-depth distribution", async () => {
    await flushMetricBatch(DB, [
      msg({ metric: "extension", dim: "x1", ts: DAY(2) }),
      msg({ metric: "extension", dim: "x1", ts: DAY(2) }),
      msg({ metric: "extension", dim: "x2", ts: DAY(2) }),
    ]);
    const hist = await queryHistogram(DB, "2020-06-01", "2020-06-30", "extension");
    expect(hist.find((b) => b.bucket === "x1")?.count).toBe(2);
    expect(hist.find((b) => b.bucket === "x2")?.count).toBe(1);
  });

  it("is injection-safe: a malicious date param cannot alter the table", async () => {
    const evil = "2020-06-01'; DROP TABLE daily_metrics;--";
    await expect(queryRange(DB, evil, "2020-06-30")).resolves.toBeDefined();
    // Table still exists and still holds the seeded rows.
    const all = await queryRange(DB, "2020-06-01", "2020-06-30");
    expect(all.length).toBeGreaterThan(0);
  });
});
