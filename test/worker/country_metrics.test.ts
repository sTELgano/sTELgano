// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for src/lib/country_metrics — UPSERT-based aggregate counters
// with no per-room linkage. Hits real D1.

import { describe, expect, it } from "vitest";
// @ts-expect-error — see healthz.test.ts
import { env } from "cloudflare:test";

import { incrementFree, incrementPaid, list } from "../../src/lib/country_metrics";

async function findRow(code: string): Promise<{
  free_rooms: number;
  paid_rooms: number;
} | null> {
  return env.DB.prepare(
    "SELECT free_rooms, paid_rooms FROM country_metrics WHERE country_code = ?",
  )
    .bind(code)
    .first();
}

describe("incrementFree / incrementPaid", () => {
  it("creates a row on first bump", async () => {
    await incrementFree(env.DB, "AA");
    const row = await findRow("AA");
    expect(row).toEqual({ free_rooms: 1, paid_rooms: 0 });
  });

  it("increments existing rows in place (UPSERT)", async () => {
    await incrementFree(env.DB, "BB");
    await incrementFree(env.DB, "BB");
    await incrementPaid(env.DB, "BB");
    expect(await findRow("BB")).toEqual({ free_rooms: 2, paid_rooms: 1 });
  });

  it("normalises lowercase ISO codes to uppercase", async () => {
    await incrementFree(env.DB, "cc");
    expect(await findRow("CC")).toEqual({ free_rooms: 1, paid_rooms: 0 });
  });

  it("silently no-ops on invalid input (non-string, wrong length)", async () => {
    await incrementFree(env.DB, null);
    await incrementFree(env.DB, "USA"); // 3 chars
    await incrementFree(env.DB, "");
    // Spot-check: no row ever materialised.
    const rows = await env.DB.prepare(
      "SELECT country_code FROM country_metrics WHERE country_code IN ('USA', '')",
    ).all();
    expect(rows.results.length).toBe(0);
  });

  it("isolates counts per country", async () => {
    await incrementFree(env.DB, "DD");
    await incrementPaid(env.DB, "EE");
    expect(await findRow("DD")).toEqual({ free_rooms: 1, paid_rooms: 0 });
    expect(await findRow("EE")).toEqual({ free_rooms: 0, paid_rooms: 1 });
  });
});

describe("list", () => {
  it("returns rows sorted by total (free + paid) DESC", async () => {
    await incrementFree(env.DB, "FA");
    await incrementFree(env.DB, "FB");
    await incrementFree(env.DB, "FB");
    await incrementPaid(env.DB, "FB");

    const rows = await list(env.DB);
    const fa = rows.find((r) => r.country_code === "FA");
    const fb = rows.find((r) => r.country_code === "FB");
    expect(fa).toBeDefined();
    expect(fb).toBeDefined();
    // FB total (3) > FA total (1), so FB must precede FA in the list.
    const idxA = rows.findIndex((r) => r.country_code === "FA");
    const idxB = rows.findIndex((r) => r.country_code === "FB");
    expect(idxB).toBeLessThan(idxA);
  });
});
