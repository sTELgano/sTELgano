// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-function tests for the server-rendered SVG/markup chart helpers.
// Each renderer must be total: empty / all-zero input yields a graceful
// placeholder, never NaN or a thrown error, and labels are escaped.

import { describe, expect, it } from "vitest";

import {
  esc,
  renderBarRow,
  renderFunnelBars,
  renderHistogram,
  renderTrendChart,
} from "../../src/lib/charts";

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("renderTrendChart", () => {
  it("renders an SVG with one polyline per non-empty series", () => {
    const out = renderTrendChart(
      [
        { label: "Free", color: "#64748b", points: [1, 2, 3] },
        { label: "Paid", color: "#10B981", points: [0, 1, 4] },
      ],
      ["2026-06-01", "2026-06-02", "2026-06-03"],
    );
    expect(out).toContain("<svg");
    expect(out.match(/<polyline/g)).toHaveLength(2);
    expect(out).toContain("Free");
    expect(out).toContain("2026-06-01");
    expect(out).not.toContain("NaN");
  });

  it("shows a placeholder when there is no data or a flat zero series", () => {
    expect(renderTrendChart([], [])).toContain("No data");
    expect(renderTrendChart([{ label: "x", points: [0, 0, 0] }], ["a", "b", "c"])).toContain(
      "No data",
    );
    expect(renderTrendChart([{ label: "x", points: [5] }], ["a"])).toContain("No data");
  });

  it("never emits NaN for ragged or single-point series", () => {
    const out = renderTrendChart([{ label: "x", points: [3, 7] }], ["a", "b"]);
    expect(out).not.toContain("NaN");
  });
});

describe("renderBarRow", () => {
  it("scales width to max and escapes the label", () => {
    const out = renderBarRow("<KE>", 5, 10);
    expect(out).toContain("width:50%");
    expect(out).toContain("&lt;KE&gt;");
    expect(out).toContain(">5<");
  });
  it("renders a 0% bar when max is 0 (no divide-by-zero)", () => {
    const out = renderBarRow("x", 0, 0);
    expect(out).toContain("width:0%");
    expect(out).not.toContain("NaN");
  });
});

describe("renderHistogram", () => {
  it("renders one bar per bucket", () => {
    const out = renderHistogram([
      { label: "<1h", count: 2 },
      { label: "1-24h", count: 8 },
    ]);
    expect(out).toContain("&lt;1h"); // label is HTML-escaped
    expect(out).toContain("1-24h");
    expect(out).not.toContain("NaN");
  });
  it("shows a placeholder when every bucket is zero", () => {
    expect(renderHistogram([{ label: "<1h", count: 0 }])).toContain("No data");
    expect(renderHistogram([])).toContain("No data");
  });
});

describe("renderFunnelBars", () => {
  it("renders bars with conversion % and flags the steepest drop as friction", () => {
    const out = renderFunnelBars([
      { label: "Landing", count: 100 },
      { label: "Chat", count: 90 },
      { label: "Generated", count: 20 }, // steepest drop here
      { label: "Opened", count: 18 },
    ]);
    expect(out).toContain("Landing");
    expect(out).toContain("friction");
    expect(out).not.toContain("NaN");
  });
  it("shows a placeholder when the top step is zero", () => {
    expect(renderFunnelBars([{ label: "Landing", count: 0 }])).toContain("No funnel data");
    expect(renderFunnelBars([])).toContain("No funnel data");
  });
});
