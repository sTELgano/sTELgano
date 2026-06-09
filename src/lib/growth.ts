// SPDX-License-Identifier: AGPL-3.0-only
//
// Week-over-week growth metrics for the admin dashboard — the figures an
// early-stage investor underwrites (rate of change, not absolute size).
//
// sTELgano is accountless and ephemeral, so the classic user-identity metrics
// (distinct WAU, per-user retention cohorts) cannot be computed without
// breaking the privacy model. What we CAN measure from the aggregate
// daily_metrics store is the growth *rate* of the events that prove the loop
// works: channels created (room_free), second parties joined, messages sent,
// and revenue. These are bucketed into ISO weeks (Monday-anchored, UTC) and
// run through the same WoW computation + YC grading the growth spec describes.
//
// All functions here are pure (no D1, no Date.now) so they unit-test cleanly;
// the caller passes the daily rows and a "now" timestamp.

import { utcDay } from "./daily_metrics";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00:00 UTC of the ISO week containing `ms`. */
export function mondayUtcMs(ms: number): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const isoOffset = (d.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun → days since Monday
  return dayStart - isoOffset * DAY_MS;
}

export interface WeekBucket {
  weekStart: string; // YYYY-MM-DD (Monday, UTC)
  value: number;
}

/**
 * Bucket daily `{ day, value }` rows into the last `weeks` ISO weeks, oldest
 * first, zero-filled. The final bucket is the current (partial) week. Rows
 * outside the window are ignored; `value` can be a count or a summed amount.
 */
export function weeklyBuckets(
  daily: ReadonlyArray<{ day: string; value: number }>,
  weeks: number,
  nowMs: number,
): WeekBucket[] {
  const currentMonday = mondayUtcMs(nowMs);
  const out: WeekBucket[] = [];
  const idx = new Map<string, number>();
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = utcDay(currentMonday - i * WEEK_MS);
    idx.set(ws, out.length);
    out.push({ weekStart: ws, value: 0 });
  }
  for (const row of daily) {
    const ms = Date.parse(`${row.day}T00:00:00Z`);
    if (Number.isNaN(ms)) continue;
    const ws = utcDay(mondayUtcMs(ms));
    const b = idx.get(ws);
    const bucket = b === undefined ? undefined : out[b];
    if (bucket) bucket.value += row.value;
  }
  return out;
}

export type GrowthGrade = "exceptional" | "healthy" | "positive" | "flat" | "insufficient";

export interface WoWResult {
  weeks: WeekBucket[]; // full series incl. current partial week
  avgWoW: number | null; // mean WoW % across completed weeks; null if <2 usable
  latest: number | null; // most recent completed WoW %
  grade: GrowthGrade;
}

/** YC's own read of an average WoW rate (the 5–7% "healthy" band). */
export function gradeWoW(avg: number | null): GrowthGrade {
  if (avg === null) return "insufficient";
  if (avg >= 10) return "exceptional";
  if (avg >= 5) return "healthy";
  if (avg >= 1) return "positive";
  return "flat";
}

/**
 * Week-over-week growth from a zero-filled weekly series. The current (last)
 * week is partial, so it's excluded from the average (a half-finished week
 * reads as a fake crash). Pairs where the previous week is 0 are skipped so
 * the 0→1 "first week" doesn't show as +∞%.
 */
export function wowGrowth(weeks: WeekBucket[]): WoWResult {
  const completed = weeks.slice(0, -1); // drop current partial week
  const changes: number[] = [];
  for (let i = 1; i < completed.length; i++) {
    const prev = completed[i - 1]?.value ?? 0;
    const curr = completed[i]?.value ?? 0;
    if (prev > 0) changes.push(((curr - prev) / prev) * 100);
  }
  const avgWoW = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  const latest = changes.length ? (changes[changes.length - 1] ?? null) : null;
  return { weeks, avgWoW, latest, grade: gradeWoW(avgWoW) };
}

/**
 * Trailing-30-day total vs the prior 30 days, and the month-over-month %.
 * For a pay-as-you-go model this is a transaction-volume run-rate — NOT MRR.
 * Returns null momPct when there's no prior-period baseline.
 */
export interface RunRate {
  last30: number;
  prior30: number;
  momPct: number | null;
}

export function runRate(
  daily: ReadonlyArray<{ day: string; value: number }>,
  nowMs: number,
): RunRate {
  const todayStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  // last30 = [today-29 .. today]; prior30 = [today-59 .. today-30].
  const lastFrom = utcDay(todayStart - 29 * DAY_MS);
  const priorFrom = utcDay(todayStart - 59 * DAY_MS);
  const priorTo = utcDay(todayStart - 30 * DAY_MS);
  let last30 = 0;
  let prior30 = 0;
  for (const r of daily) {
    if (r.day >= lastFrom) last30 += r.value;
    else if (r.day >= priorFrom && r.day <= priorTo) prior30 += r.value;
  }
  const momPct = prior30 > 0 ? ((last30 - prior30) / prior30) * 100 : null;
  return { last30, prior30, momPct };
}

// --- Channel retention cohorts ---------------------------------------------
//
// The app is accountless, so the cohort *entity* is the channel, not a user:
// rows = channels created in week W; columns = the share still active k weeks
// later. "Active" = the channel's Durable Object emitted a cohort_active
// beacon that week (deduped once/week in the DO). Week 0 ≈ 100% by
// construction (a beacon fires at creation). Cells whose offset week hasn't
// happened yet are null (not observable), as are cohorts with size 0.

export interface CohortRow {
  cohortWeek: string; // YYYY-MM-DD (Monday, UTC)
  size: number; // channels created that week (room_free)
  cells: Array<number | null>; // retention % by offset 0..maxOffset
}

/**
 * Build the cohort retention triangle from aggregate cohort_active counts
 * (dim = "<cohortMonday>+<offset>") and the per-week channel-creation sizes.
 * Pure — caller supplies `nowMs`.
 */
export function buildCohortTriangle(
  active: ReadonlyArray<{ dim: string; count: number }>,
  weeklySizes: ReadonlyArray<WeekBucket>,
  nowMs: number,
  maxOffset: number,
): CohortRow[] {
  const currentMonday = utcDay(mondayUtcMs(nowMs));
  // cohortWeek → (offset → count)
  const byCohort = new Map<string, Map<number, number>>();
  for (const a of active) {
    const plus = a.dim.lastIndexOf("+");
    if (plus <= 0) continue;
    const cw = a.dim.slice(0, plus);
    const off = Number(a.dim.slice(plus + 1));
    if (!Number.isInteger(off) || off < 0) continue;
    const m = byCohort.get(cw) ?? new Map<number, number>();
    m.set(off, (m.get(off) ?? 0) + a.count);
    byCohort.set(cw, m);
  }

  return weeklySizes.map((wk) => {
    const cohortMs = Date.parse(`${wk.weekStart}T00:00:00Z`);
    const offsets = byCohort.get(wk.weekStart);
    const cells: Array<number | null> = [];
    for (let off = 0; off <= maxOffset; off++) {
      const offWeek = utcDay(cohortMs + off * WEEK_MS);
      const observable = offWeek <= currentMonday;
      if (!observable || wk.value === 0) {
        cells.push(null);
        continue;
      }
      const act = offsets?.get(off) ?? 0;
      cells.push(Math.round((act / wk.value) * 100));
    }
    return { cohortWeek: wk.weekStart, size: wk.value, cells };
  });
}

/**
 * Weekly Active Channels (WAC) — the accountless WAU analog. cohort_active
 * fires at most once per channel per ISO week, so summing those beacons by
 * their CALENDAR week (creation week + offset) yields the distinct active
 * channels per week, then run through the same weekly bucketing as the other
 * growth metrics.
 *
 * Caveat: the DO caps cohort_active at offset 12, so a channel older than 12
 * weeks stops being counted — a mild WAC undercount that grows with product
 * age (negligible early on). Surface this where WAC is shown.
 */
export function weeklyActiveChannels(
  active: ReadonlyArray<{ dim: string; count: number }>,
  weeks: number,
  nowMs: number,
): WeekBucket[] {
  const daily: Array<{ day: string; value: number }> = [];
  for (const a of active) {
    const plus = a.dim.lastIndexOf("+");
    if (plus <= 0) continue;
    const cohortMonday = a.dim.slice(0, plus);
    const offset = Number(a.dim.slice(plus + 1));
    if (!Number.isInteger(offset) || offset < 0) continue;
    const ms = Date.parse(`${cohortMonday}T00:00:00Z`);
    if (Number.isNaN(ms)) continue;
    // The beacon's calendar week = creation-week Monday + offset weeks. That's
    // already a Monday, so weeklyBuckets maps it to itself.
    daily.push({ day: utcDay(ms + offset * WEEK_MS), value: a.count });
  }
  return weeklyBuckets(daily, weeks, nowMs);
}
