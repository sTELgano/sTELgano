// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-function tests for the analytics helper: bucketing, coalescing,
// the fire-and-forget producers, and date-range parsing. No Worker
// runtime needed — these are deterministic transforms.

import { describe, expect, it } from "vitest";

import {
  coalesce,
  conversionBucket,
  type DateRange,
  enqueueMetric,
  enqueueMetrics,
  extensionBucket,
  lifespanBucket,
  type MetricMessage,
  pageRoute,
  parseDateRange,
  priceLabel,
  referrerCategory,
  ttfmBucket,
  utcDay,
  utcHour,
} from "../../src/lib/daily_metrics";

// A queue test double that records what was sent.
function fakeQueue() {
  const sent: MetricMessage[] = [];
  const batches: MetricMessage[][] = [];
  const queue = {
    send: async (m: MetricMessage) => {
      sent.push(m);
    },
    sendBatch: async (msgs: Iterable<{ body: MetricMessage }>) => {
      batches.push([...msgs].map((x) => x.body));
    },
  } as unknown as Queue<MetricMessage>;
  return { sent, batches, queue };
}

const HEX64 = /[a-f0-9]{64}/i;

describe("utcDay", () => {
  it("buckets an epoch-ms timestamp to a UTC date", () => {
    expect(utcDay(Date.UTC(2026, 5, 7, 12, 30))).toBe("2026-06-07");
  });
  it("is exclusive at the next midnight (UTC)", () => {
    expect(utcDay(Date.UTC(2026, 5, 7, 23, 59, 59, 999))).toBe("2026-06-07");
    expect(utcDay(Date.UTC(2026, 5, 8, 0, 0, 0, 0))).toBe("2026-06-08");
  });
});

describe("lifespanBucket", () => {
  it("places boundary values in the upper bucket", () => {
    expect(lifespanBucket(0)).toBe("<1h");
    expect(lifespanBucket(0.99)).toBe("<1h");
    expect(lifespanBucket(1)).toBe("1-24h");
    expect(lifespanBucket(23.9)).toBe("1-24h");
    expect(lifespanBucket(24)).toBe("1-7d");
    expect(lifespanBucket(24 * 7)).toBe("7-30d");
    expect(lifespanBucket(24 * 30)).toBe("30-90d");
    expect(lifespanBucket(24 * 90)).toBe("90d+");
    expect(lifespanBucket(100_000)).toBe("90d+");
  });
});

describe("ttfmBucket", () => {
  it("places boundary values in the upper bucket", () => {
    expect(ttfmBucket(0)).toBe("<1m");
    expect(ttfmBucket(59)).toBe("<1m");
    expect(ttfmBucket(60)).toBe("1-10m");
    expect(ttfmBucket(600)).toBe("10-60m");
    expect(ttfmBucket(3600)).toBe("1-24h");
    expect(ttfmBucket(86_400)).toBe("1d+");
  });
});

describe("extensionBucket", () => {
  it("maps the Nth paid extension to an ordinal bucket, capped at x10+", () => {
    expect(extensionBucket(0)).toBe("x1"); // defensive: first purchase
    expect(extensionBucket(1)).toBe("x1");
    expect(extensionBucket(2)).toBe("x2");
    expect(extensionBucket(9)).toBe("x9");
    expect(extensionBucket(10)).toBe("x10+");
    expect(extensionBucket(50)).toBe("x10+");
  });
});

describe("priceLabel", () => {
  it("builds a stable currency_cents label", () => {
    expect(priceLabel("usd", 200)).toBe("USD_200");
    expect(priceLabel("KES", 10_000)).toBe("KES_10000");
  });
  it("defaults a blank currency and rounds cents", () => {
    expect(priceLabel("", 199.6)).toBe("USD_200");
  });
});

describe("conversionBucket", () => {
  it("buckets free→paid latency by hours", () => {
    expect(conversionBucket(0)).toBe("<1h");
    expect(conversionBucket(1)).toBe("1-24h");
    expect(conversionBucket(24)).toBe("1-3d");
    expect(conversionBucket(24 * 3)).toBe("3-7d");
    expect(conversionBucket(24 * 7)).toBe("7d+");
  });
});

describe("utcHour", () => {
  it("returns a zero-padded UTC hour label", () => {
    expect(utcHour(Date.UTC(2026, 5, 7, 9, 30))).toBe("09");
    expect(utcHour(Date.UTC(2026, 5, 7, 23, 59))).toBe("23");
    expect(utcHour(Date.UTC(2026, 5, 7, 0, 0))).toBe("00");
  });
});

describe("pageRoute", () => {
  it("normalizes known content routes and collapses blog slugs", () => {
    expect(pageRoute("/")).toBe("/");
    expect(pageRoute("/spec")).toBe("/spec");
    expect(pageRoute("/blog")).toBe("/blog");
    expect(pageRoute("/blog/zero-ops-global-scale")).toBe("/blog/:slug");
  });
  it("skips non-content paths (assets, api, admin, room, payment)", () => {
    for (const p of [
      "/admin",
      "/api/funnel",
      "/room/abc/ws",
      "/assets/app.css",
      "/healthz",
      "/x",
      "/c/promo",
      "/payment/callback",
      "/blog/a/b",
    ]) {
      expect(pageRoute(p)).toBeNull();
    }
  });
});

describe("referrerCategory", () => {
  const host = "stelgano.com";
  it("classifies common sources, never storing the URL", () => {
    expect(referrerCategory(null, host)).toBe("direct");
    expect(referrerCategory("https://www.google.com/search?q=x", host)).toBe("search");
    expect(referrerCategory("https://t.co/abc", host)).toBe("social");
    expect(referrerCategory("https://news.ycombinator.com/", host)).toBe("other");
    expect(referrerCategory("garbage", host)).toBe("other");
  });
  it("marks same-site navigation internal (callers skip it)", () => {
    expect(referrerCategory("https://stelgano.com/blog", host)).toBe("internal");
    expect(referrerCategory("https://staging.stelgano.com/", host)).toBe("internal");
  });
});

describe("coalesce", () => {
  const ts = Date.UTC(2026, 5, 7, 10);

  it("merges messages with the same composite key, summing count and value", () => {
    const rows = coalesce([
      { metric: "message_sent", stegCountry: "KE", cfCountry: "KE", ts },
      { metric: "message_sent", stegCountry: "KE", cfCountry: "KE", ts },
      { metric: "message_sent", stegCountry: "KE", cfCountry: "KE", ts, value: 5 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: "message_sent", count: 3, sumValue: 5 });
  });

  it("keeps distinct keys separate (country, dim, day, metric)", () => {
    const rows = coalesce([
      { metric: "room_free", stegCountry: "KE", cfCountry: "KE", ts },
      { metric: "room_free", stegCountry: "US", cfCountry: "US", ts },
      { metric: "room_free", stegCountry: "KE", cfCountry: "GB", ts },
      { metric: "room_lifespan", dim: "<1h", ts },
      { metric: "room_lifespan", dim: "1-24h", ts },
      { metric: "room_free", stegCountry: "KE", cfCountry: "KE", ts: Date.UTC(2026, 5, 8) },
    ]);
    expect(rows).toHaveLength(6);
  });

  it("returns [] for an empty batch", () => {
    expect(coalesce([])).toEqual([]);
  });
});

describe("enqueueMetric", () => {
  it("is a no-op when the queue binding is absent", () => {
    expect(() => enqueueMetric(undefined, "room_free")).not.toThrow();
  });

  it("builds a normalised message with defaults and an injected clock", () => {
    const { sent, queue } = fakeQueue();
    enqueueMetric(queue, "room_free", { nowMs: 123 });
    expect(sent).toEqual([
      { metric: "room_free", stegCountry: "", cfCountry: "", dim: "", value: 0, ts: 123 },
    ]);
  });

  it("passes through country, dim and value", () => {
    const { sent, queue } = fakeQueue();
    enqueueMetric(queue, "time_to_first_message", {
      stegCountry: "KE",
      cfCountry: "GB",
      dim: "1-10m",
      value: 90,
      nowMs: 1,
    });
    expect(sent[0]).toMatchObject({ stegCountry: "KE", cfCountry: "GB", dim: "1-10m", value: 90 });
  });

  it("never carries an identifier (privacy shape)", () => {
    const { sent, queue } = fakeQueue();
    enqueueMetric(queue, "message_sent", { stegCountry: "KE", cfCountry: "KE", nowMs: 1 });
    const keys = Object.keys(sent[0]!).sort();
    expect(keys).toEqual(["cfCountry", "dim", "metric", "stegCountry", "ts", "value"]);
    expect(JSON.stringify(sent[0])).not.toMatch(HEX64);
  });
});

describe("enqueueMetrics", () => {
  it("is a no-op when the queue is absent or items are empty", () => {
    const { batches, queue } = fakeQueue();
    expect(() => enqueueMetrics(undefined, [{ metric: "room_free" }])).not.toThrow();
    enqueueMetrics(queue, []);
    expect(batches).toHaveLength(0);
  });

  it("sends one batch with a shared timestamp", () => {
    const { batches, queue } = fakeQueue();
    enqueueMetrics(
      queue,
      [
        { metric: "room_expired_free" },
        { metric: "room_lifespan", value: 2, dim: "1-24h" },
        { metric: "room_expired_empty" },
      ],
      777,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]!.every((m) => m.ts === 777)).toBe(true);
    expect(batches[0]![1]).toMatchObject({ metric: "room_lifespan", value: 2, dim: "1-24h" });
  });
});

describe("parseDateRange", () => {
  const today = Date.UTC(2026, 5, 7); // 2026-06-07

  const range = (qs: string): DateRange => parseDateRange(new URLSearchParams(qs), today);

  it("defaults to the last 30 days", () => {
    const r = range("");
    expect(r.to).toBe("2026-06-07");
    expect(r.from).toBe("2026-05-09");
    expect(r.days).toBe(30);
  });

  it("honours ?days= and clamps to [1, 366]", () => {
    expect(range("days=7").days).toBe(7);
    expect(range("days=0").days).toBe(1);
    expect(range("days=99999").days).toBe(366);
    expect(range("days=-5").days).toBe(1);
  });

  it("accepts an explicit from/to window (inclusive day count)", () => {
    const r = range("from=2026-06-01&to=2026-06-07");
    expect(r.from).toBe("2026-06-01");
    expect(r.to).toBe("2026-06-07");
    expect(r.days).toBe(7);
  });

  it("swaps a reversed range", () => {
    const r = range("from=2026-06-07&to=2026-06-01");
    expect(r.from).toBe("2026-06-01");
    expect(r.to).toBe("2026-06-07");
  });

  it("clamps an over-long span to 366 days", () => {
    const r = range("from=2020-01-01&to=2026-06-07");
    expect(r.days).toBe(366);
    expect(r.to).toBe("2026-06-07");
  });

  it("falls back to the default on malformed or injected input", () => {
    expect(range("from=not-a-date&to=2026-06-07").days).toBe(30);
    expect(range("from=2026-06-01';DROP TABLE daily_metrics;--&to=2026-06-07").days).toBe(30);
    expect(range("days=abc").days).toBe(30);
  });
});
