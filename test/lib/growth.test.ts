// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for src/lib/growth.ts — week-over-week growth + run-rate.
// All helpers are pure and take an explicit `nowMs`, so they're deterministic.

import { describe, expect, it } from "vitest";

import {
  buildCohortTriangle,
  gradeWoW,
  mondayUtcMs,
  runRate,
  type WeekBucket,
  weeklyActiveChannels,
  weeklyBuckets,
  wowGrowth,
} from "../../src/lib/growth";

const DAY = 86_400_000;
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("mondayUtcMs", () => {
  it("returns the Monday 00:00 UTC of the containing week", () => {
    // 2026-06-10 is a Wednesday → Monday is 2026-06-08.
    const wed = Date.UTC(2026, 5, 10, 15, 30);
    const mon = mondayUtcMs(wed);
    expect(new Date(mon).getUTCDay()).toBe(1); // Monday
    expect(dayStr(mon)).toBe("2026-06-08");
    expect(mon).toBeLessThanOrEqual(wed);
  });

  it("maps a Sunday back to the prior Monday (Monday-anchored, not Sunday)", () => {
    const sun = Date.UTC(2026, 5, 14); // 2026-06-14 Sunday
    expect(dayStr(mondayUtcMs(sun))).toBe("2026-06-08");
  });
});

describe("weeklyBuckets", () => {
  const now = Date.UTC(2026, 5, 10); // Wed; current Monday = 2026-06-08
  const curMon = mondayUtcMs(now);

  it("produces N zero-filled weekly buckets, oldest first, current week last", () => {
    const b = weeklyBuckets([], 4, now);
    expect(b).toHaveLength(4);
    expect(b.map((x) => x.value)).toEqual([0, 0, 0, 0]);
    expect(b[3]?.weekStart).toBe(dayStr(curMon)); // last = current week
    expect(b[0]?.weekStart).toBe(dayStr(curMon - 3 * 7 * DAY));
  });

  it("sums daily rows into the right week and ignores out-of-window days", () => {
    const rows = [
      { day: dayStr(curMon), value: 3 }, // this week
      { day: dayStr(curMon + 2 * DAY), value: 1 }, // also this week
      { day: dayStr(curMon - 7 * DAY), value: 5 }, // last week
      { day: dayStr(curMon - 21 * DAY), value: 2 }, // 3 weeks ago (oldest bucket)
      { day: dayStr(curMon - 100 * DAY), value: 99 }, // outside 4-week window
    ];
    const b = weeklyBuckets(rows, 4, now);
    expect(b.map((x) => x.value)).toEqual([2, 0, 5, 4]);
  });
});

describe("wowGrowth + gradeWoW", () => {
  const wk = (vals: number[]): WeekBucket[] =>
    vals.map((v, i) => ({ weekStart: `w${i}`, value: v }));

  it("averages completed weeks and excludes the current partial week", () => {
    // completed = [10,11,12]; current (13) dropped. changes: +10%, +9.09%.
    const r = wowGrowth(wk([10, 11, 12, 13]));
    expect(r.avgWoW).toBeCloseTo(9.545, 2);
    expect(r.latest).toBeCloseTo(9.0909, 2);
    expect(r.grade).toBe("healthy");
  });

  it("skips pairs where the previous week is 0 (no +∞ on the first week)", () => {
    // completed = [0,5,10]; (0→5) skipped, (5→10)=+100%.
    const r = wowGrowth(wk([0, 5, 10, 12]));
    expect(r.avgWoW).toBe(100);
    expect(r.grade).toBe("exceptional");
  });

  it("returns insufficient when there are no usable pairs", () => {
    const r = wowGrowth(wk([0, 0, 5, 6]));
    expect(r.avgWoW).toBeNull();
    expect(r.grade).toBe("insufficient");
  });

  it("grades the YC bands", () => {
    expect(gradeWoW(null)).toBe("insufficient");
    expect(gradeWoW(12)).toBe("exceptional");
    expect(gradeWoW(7)).toBe("healthy");
    expect(gradeWoW(5)).toBe("healthy");
    expect(gradeWoW(3)).toBe("positive");
    expect(gradeWoW(0.5)).toBe("flat");
    expect(gradeWoW(-4)).toBe("flat");
  });
});

describe("runRate", () => {
  const now = Date.UTC(2026, 5, 10); // 2026-06-10; last30 from 2026-05-12

  it("splits trailing-30 vs prior-30 and computes MoM %", () => {
    const rows = [
      { day: "2026-06-09", value: 100 }, // last30
      { day: "2026-06-01", value: 50 }, // last30
      { day: "2026-05-12", value: 10 }, // last30 (boundary)
      { day: "2026-05-11", value: 20 }, // prior30 (boundary)
      { day: "2026-04-12", value: 5 }, // prior30 (boundary)
      { day: "2026-04-11", value: 999 }, // older → ignored
    ];
    const r = runRate(rows, now);
    expect(r.last30).toBe(160);
    expect(r.prior30).toBe(25);
    expect(r.momPct).toBeCloseTo(540, 5);
  });

  it("returns null MoM when there is no prior-period baseline", () => {
    const r = runRate([{ day: "2026-06-09", value: 10 }], now);
    expect(r.last30).toBe(10);
    expect(r.prior30).toBe(0);
    expect(r.momPct).toBeNull();
  });
});

describe("buildCohortTriangle", () => {
  const now = Date.UTC(2026, 5, 10); // current Monday = 2026-06-08
  const sizes: WeekBucket[] = [
    { weekStart: "2026-06-01", value: 10 },
    { weekStart: "2026-06-08", value: 4 }, // current week
  ];

  it("computes retention % per cohort and nulls un-observable / sizeless cells", () => {
    const active = [
      { dim: "2026-06-01+0", count: 10 }, // 100%
      { dim: "2026-06-01+1", count: 5 }, // 50% (offset week 2026-06-08, observable)
      { dim: "2026-06-08+0", count: 4 }, // 100%
    ];
    const rows = buildCohortTriangle(active, sizes, now, 2);
    expect(rows[0]).toEqual({ cohortWeek: "2026-06-01", size: 10, cells: [100, 50, null] });
    // off2 of the 06-01 cohort is week 06-15 (future) → null
    expect(rows[1]).toEqual({ cohortWeek: "2026-06-08", size: 4, cells: [100, null, null] });
  });

  it("nulls every cell for a zero-size cohort (no divide-by-zero)", () => {
    const rows = buildCohortTriangle([], [{ weekStart: "2026-06-01", value: 0 }], now, 2);
    expect(rows[0]?.cells).toEqual([null, null, null]);
  });

  it("ignores malformed dims", () => {
    const active = [
      { dim: "garbage", count: 9 },
      { dim: "2026-06-01+x", count: 9 },
      { dim: "2026-06-01+0", count: 10 },
    ];
    const rows = buildCohortTriangle(active, sizes, now, 1);
    expect(rows[0]?.cells[0]).toBe(100);
  });
});

describe("weeklyActiveChannels (WAC)", () => {
  const now = Date.UTC(2026, 5, 10); // current Monday = 2026-06-08

  it("sums cohort_active beacons by their calendar week", () => {
    const active = [
      { dim: "2026-06-01+0", count: 3 }, // active in week 06-01
      { dim: "2026-06-01+1", count: 2 }, // active in week 06-08 (06-01 + 1wk)
      { dim: "2026-06-08+0", count: 5 }, // active in week 06-08
    ];
    const b = weeklyActiveChannels(active, 4, now);
    // oldest→current: 05-18, 05-25, 06-01, 06-08
    expect(b.map((x) => x.value)).toEqual([0, 0, 3, 7]);
    expect(b[3]?.weekStart).toBe("2026-06-08");
  });

  it("ignores malformed dims and out-of-window weeks", () => {
    const active = [
      { dim: "bad", count: 9 },
      { dim: "2026-06-08+0", count: 4 },
      { dim: "2026-01-05+0", count: 99 }, // far outside the 4-week window
    ];
    const b = weeklyActiveChannels(active, 4, now);
    expect(b.map((x) => x.value)).toEqual([0, 0, 0, 4]);
  });
});
