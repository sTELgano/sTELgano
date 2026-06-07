// SPDX-License-Identifier: AGPL-3.0-only
//
// charts — pure, dependency-free SVG/markup renderers for the admin
// dashboard. Server-rendered strings only: no JavaScript, no <script>,
// no external chart library, so they slot under the strict CSP. Kept in
// their own module (no Worker imports) so they're unit-testable in the
// pure Vitest project.
//
// Every renderer is total: empty / all-zero input yields a graceful
// placeholder rather than NaN or a blank box.

const ACCENT = "#10B981";

/** Minimal HTML/SVG-text escape for untrusted labels. */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A finite number or 0 — guards every value that reaches an SVG attribute. */
function num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function placeholder(msg = "No data yet for this range"): string {
  return `<p class="py-6 text-sm text-slate-500 italic">${esc(msg)}</p>`;
}

export type TrendSeries = { label: string; color?: string; points: number[] };

/** Multi-series day trend as an inline SVG line chart with a legend.
 *  `labels` are x-axis day strings (first/mid/last are shown). */
export function renderTrendChart(
  series: TrendSeries[],
  labels: string[] = [],
  opts: { width?: number; height?: number } = {},
): string {
  const clean = series.filter((s) => s.points.length > 0);
  const n = Math.max(...clean.map((s) => s.points.length), 0);
  const max = Math.max(0, ...clean.flatMap((s) => s.points.map(num)));
  if (clean.length === 0 || n < 2 || max <= 0) return placeholder();

  const w = opts.width ?? 640;
  const h = opts.height ?? 200;
  const padX = 8;
  const padTop = 12;
  const padBottom = 26;
  const chartW = w - padX * 2;
  const chartH = h - padTop - padBottom;
  const stepX = chartW / (n - 1);
  const x = (i: number) => padX + i * stepX;
  const y = (v: number) => padTop + chartH - (num(v) / max) * chartH;

  const paths = clean
    .map((s) => {
      const color = s.color ?? ACCENT;
      const pts = s.points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      return `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}" />`;
    })
    .join("");

  // x-axis: first, middle, last labels only (avoids clutter).
  const tickIdx = [0, Math.floor((n - 1) / 2), n - 1];
  const ticks = tickIdx
    .map((i) => {
      const lbl = labels[i] ?? "";
      if (!lbl) return "";
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      return `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="#64748b" text-anchor="${anchor}">${esc(lbl)}</text>`;
    })
    .join("");

  const legend = clean
    .map((s) => {
      const color = s.color ?? ACCENT;
      return `<span class="inline-flex items-center gap-1.5 text-[10px] font-mono text-slate-400"><span class="inline-block size-2 rounded-full" style="background:${color}"></span>${esc(s.label)}</span>`;
    })
    .join("");

  return `
    <div class="space-y-3">
      <div class="flex flex-wrap gap-x-4 gap-y-1">${legend}</div>
      <svg viewBox="0 0 ${w} ${h}" class="w-full h-auto" role="img" aria-label="Daily trend (peak ${max})">
        <line x1="${padX}" y1="${(padTop + chartH).toFixed(1)}" x2="${w - padX}" y2="${(padTop + chartH).toFixed(1)}" stroke="#1e293b" stroke-width="1" />
        ${paths}
        ${ticks}
      </svg>
    </div>`;
}

/** One labelled horizontal bar row (label · bar · value). `max` scales the
 *  bar; a zero max renders an empty bar rather than dividing by zero. */
export function renderBarRow(label: string, value: number, max: number, color = ACCENT): string {
  const v = num(value);
  const pct = max > 0 ? Math.min(100, Math.round((v / max) * 100)) : 0;
  return `
    <div class="flex items-center gap-3 py-1.5">
      <div class="w-20 shrink-0 font-mono text-xs text-white truncate">${esc(label)}</div>
      <div class="flex-1 h-2.5 rounded-full bg-white/5 overflow-hidden">
        <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="w-12 shrink-0 text-right font-mono text-xs text-slate-300">${v}</div>
    </div>`;
}

export type Bucket = { label: string; count: number };

/** Ordered bucket histogram as a column of horizontal bars. */
export function renderHistogram(buckets: Bucket[]): string {
  const total = buckets.reduce((a, b) => a + num(b.count), 0);
  if (total <= 0) return placeholder();
  const max = Math.max(0, ...buckets.map((b) => num(b.count)));
  return `<div class="space-y-1">${buckets.map((b) => renderBarRow(b.label, b.count, max)).join("")}</div>`;
}

export type FunnelStepCell = { label: string; count: number };

/** Funnel as stacked horizontal bars (each scaled to the top step) with
 *  step-to-step conversion %, and the steepest drop flagged as friction. */
export function renderFunnelBars(steps: FunnelStepCell[]): string {
  const top = num(steps[0]?.count ?? 0);
  if (steps.length === 0 || top <= 0) return placeholder("No funnel data yet for this range");

  let worstIdx = -1;
  let worstDrop = 0;
  for (let i = 1; i < steps.length; i++) {
    const prev = num(steps[i - 1]?.count ?? 0);
    const cur = num(steps[i]?.count ?? 0);
    if (prev <= 0) continue;
    const drop = (prev - cur) / prev;
    if (drop > worstDrop) {
      worstDrop = drop;
      worstIdx = i;
    }
  }

  const rows = steps
    .map((s, i) => {
      const count = num(s.count);
      const pctTop = top > 0 ? Math.min(100, Math.round((count / top) * 100)) : 0;
      const prev = num(steps[i - 1]?.count ?? 0);
      const conv = i === 0 ? 100 : prev > 0 ? Math.round((count / prev) * 100) : 0;
      const friction = i === worstIdx && worstDrop > 0;
      const convBadge =
        i === 0
          ? ""
          : `<span class="font-mono text-[10px] ${friction ? "text-amber-400 font-bold" : "text-slate-500"}">${conv}%${friction ? " · friction" : ""}</span>`;
      return `
        <div class="space-y-1">
          <div class="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-500">
            <span>${esc(s.label)}</span>${convBadge}
          </div>
          <div class="flex items-center gap-3">
            <div class="flex-1 h-3 rounded-full bg-white/5 overflow-hidden">
              <div class="h-full rounded-full" style="width:${pctTop}%;background:${friction ? "#f59e0b" : ACCENT}"></div>
            </div>
            <div class="w-12 shrink-0 text-right font-mono text-xs text-white">${count}</div>
          </div>
        </div>`;
    })
    .join("");

  return `<div class="space-y-3">${rows}</div>`;
}
