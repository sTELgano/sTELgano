// SPDX-License-Identifier: AGPL-3.0-only
//
// live_counters — tier-aware active-room snapshot (migration 0007).

// @ts-expect-error — see healthz.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  convertActiveToPaid,
  decrementActiveRooms,
  getActiveRooms,
  incrementActiveRooms,
} from "../../src/lib/live_counters";

const DB = env.DB as D1Database;

beforeEach(async () => {
  await DB.prepare(
    "UPDATE live_counters SET active_rooms = 0, free_active = 0, paid_active = 0 WHERE id = 1",
  ).run();
});

describe("live_counters by tier", () => {
  it("increments by tier and reports total/free/paid", async () => {
    await incrementActiveRooms(DB, "free");
    await incrementActiveRooms(DB, "free");
    await incrementActiveRooms(DB, "paid");
    expect(await getActiveRooms(DB)).toEqual({ total: 3, free: 2, paid: 1 });
  });

  it("moves a count free → paid on conversion without changing the total", async () => {
    await incrementActiveRooms(DB, "free");
    await convertActiveToPaid(DB);
    expect(await getActiveRooms(DB)).toEqual({ total: 1, free: 0, paid: 1 });
  });

  it("decrements the right tier and floors at zero", async () => {
    await incrementActiveRooms(DB, "paid");
    await decrementActiveRooms(DB, "paid");
    expect(await getActiveRooms(DB)).toEqual({ total: 0, free: 0, paid: 0 });
    // Underflow guard: decrementing an empty tier never goes negative.
    await decrementActiveRooms(DB, "free");
    expect(await getActiveRooms(DB)).toEqual({ total: 0, free: 0, paid: 0 });
  });

  it("balances a full free→paid→expire lifecycle to zero", async () => {
    await incrementActiveRooms(DB, "free"); // created free
    await convertActiveToPaid(DB); // extended to paid
    await decrementActiveRooms(DB, "paid"); // expired (now paid)
    expect(await getActiveRooms(DB)).toEqual({ total: 0, free: 0, paid: 0 });
  });
});
