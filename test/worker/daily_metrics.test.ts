// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for src/lib/daily_metrics — per-day global counters with no
// country dimension and no per-room linkage.

// @ts-expect-error — see healthz.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  incrementFreeExpired,
  incrementFreeNew,
  incrementPaidExpired,
  incrementPaidNew,
  listRecent,
} from "../../src/lib/daily_metrics";

const TODAY = new Date().toISOString().slice(0, 10);

async function todayRow(): Promise<{
  free_new: number;
  paid_new: number;
  free_expired: number;
  paid_expired: number;
} | null> {
  return env.DB.prepare(
    "SELECT free_new, paid_new, free_expired, paid_expired FROM daily_metrics WHERE day = ?",
  )
    .bind(TODAY)
    .first();
}

describe("daily_metrics increment helpers", () => {
  it("creates today's row on first bump", async () => {
    // Reset any prior state from same-file tests by deleting today's row.
    await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(TODAY).run();

    await incrementFreeNew(env.DB);
    expect(await todayRow()).toEqual({
      free_new: 1,
      paid_new: 0,
      free_expired: 0,
      paid_expired: 0,
    });
  });

  it("UPSERT-bumps each column independently", async () => {
    await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(TODAY).run();

    await incrementFreeNew(env.DB);
    await incrementPaidNew(env.DB);
    await incrementFreeExpired(env.DB, 3);
    await incrementPaidExpired(env.DB, 2);

    expect(await todayRow()).toEqual({
      free_new: 1,
      paid_new: 1,
      free_expired: 3,
      paid_expired: 2,
    });
  });

  it("supports batched bumps via the count argument (expiries)", async () => {
    await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(TODAY).run();

    await incrementFreeExpired(env.DB, 10);
    await incrementFreeExpired(env.DB, 5);
    expect((await todayRow())?.free_expired).toBe(15);
  });

  it("rejects negative counts", async () => {
    await expect(incrementFreeExpired(env.DB, -1)).rejects.toThrow(/non-negative/);
  });

  it("treats count=0 as a no-op (no row created)", async () => {
    await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(TODAY).run();
    await incrementFreeExpired(env.DB, 0);
    expect(await todayRow()).toBeNull();
  });
});

describe("listRecent", () => {
  it("returns today's row when default 30-day window includes it", async () => {
    await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(TODAY).run();
    await incrementFreeNew(env.DB);
    const rows = await listRecent(env.DB);
    const today = rows.find((r) => r.day === TODAY);
    expect(today).toBeDefined();
    expect(today?.free_new).toBe(1);
  });

  it("excludes days older than the cutoff", async () => {
    // Insert a row dated 60 days ago — outside the default 30-day
    // window — and confirm listRecent doesn't return it.
    const oldDay = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO daily_metrics (day, free_new, paid_new, free_expired, paid_expired, updated_at)
       VALUES (?, 99, 0, 0, 0, ?)`,
    )
      .bind(oldDay, now)
      .run();

    const rows = await listRecent(env.DB, 30);
    expect(rows.find((r) => r.day === oldDay)).toBeUndefined();
  });

  it("rejects non-positive day windows", async () => {
    await expect(listRecent(env.DB, 0)).rejects.toThrow(/positive/);
    await expect(listRecent(env.DB, -1)).rejects.toThrow(/positive/);
  });

  it("returns rows in newest-first order", async () => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const newer = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10);
    const now = new Date().toISOString();
    for (const day of [old, newer]) {
      await env.DB.prepare("DELETE FROM daily_metrics WHERE day = ?").bind(day).run();
      await env.DB.prepare(
        `INSERT INTO daily_metrics (day, free_new, paid_new, free_expired, paid_expired, updated_at)
         VALUES (?, 1, 0, 0, 0, ?)`,
      )
        .bind(day, now)
        .run();
    }
    const rows = await listRecent(env.DB, 30);
    const idxOld = rows.findIndex((r) => r.day === old);
    const idxNew = rows.findIndex((r) => r.day === newer);
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeLessThan(idxOld);
  });
});
