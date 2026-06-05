// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the pure helpers in src/lib/campaigns.ts. The D1 CRUD
// (createCampaign / getCampaignBySlug / archiveCampaign) is exercised
// against a real in-memory D1 in test/worker/campaigns.test.ts.

import { describe, expect, it } from "vitest";

import { normaliseDestination, SLUG_RE, slugify } from "../../src/lib/campaigns";

describe("slugify", () => {
  it("lowercases and hyphenates a free-text title", () => {
    expect(slugify("Instagram Launch Push")).toBe("instagram-launch-push");
  });

  it("strips punctuation and collapses hyphen runs", () => {
    expect(slugify("Summer!! 2026 — Big   Sale")).toBe("summer-2026-big-sale");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  it("caps length at 40 chars with no trailing hyphen", () => {
    const out = slugify("a".repeat(60));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("-")).toBe(false);
  });

  it("returns '' for a title with no usable characters", () => {
    expect(slugify("!!!  ---")).toBe("");
    expect(slugify("世界")).toBe("");
  });

  it("always produces a value matching SLUG_RE (when non-empty)", () => {
    for (const t of ["Hello World", "A/B Test #3", "  spaced  "]) {
      const s = slugify(t);
      if (s) expect(SLUG_RE.test(s)).toBe(true);
    }
  });
});

describe("normaliseDestination", () => {
  it("keeps a valid same-origin path", () => {
    expect(normaliseDestination("/chat")).toBe("/chat");
    expect(normaliseDestination("/")).toBe("/");
  });

  it("rejects absolute URLs and protocol-relative paths (open-redirect guard)", () => {
    expect(normaliseDestination("https://evil.com")).toBe("/");
    expect(normaliseDestination("//evil.com")).toBe("/");
    expect(normaliseDestination("evil.com")).toBe("/");
    // Browsers also treat a leading "/\" as protocol-relative.
    expect(normaliseDestination("/\\evil.com")).toBe("/");
    expect(normaliseDestination("/\\\\evil.com")).toBe("/");
  });

  it("defaults empty / nullish input to '/'", () => {
    expect(normaliseDestination("")).toBe("/");
    expect(normaliseDestination("   ")).toBe("/");
    expect(normaliseDestination(null)).toBe("/");
    expect(normaliseDestination(undefined)).toBe("/");
  });
});
