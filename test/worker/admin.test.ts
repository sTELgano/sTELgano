// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /admin — HTTP Basic Auth dashboard. Covers the auth gate only;
// the HTML body renders whatever D1 currently holds and isn't worth
// scraping. Credentials come from .dev.vars via the pool wrangler
// config: ADMIN_USERNAME="admin", ADMIN_PASSWORD="letmein".

// @ts-expect-error — see healthz.test.ts for why this expect-error lives here.
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { flushMetricBatch, type MetricMessage } from "../../src/lib/daily_metrics";

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

const AUTH = { authorization: basic("admin", "letmein") };

function seedMsg(
  partial: Partial<MetricMessage> & { metric: MetricMessage["metric"] },
): MetricMessage {
  return { stegCountry: "", cfCountry: "", dim: "", value: 0, ts: Date.now(), ...partial };
}

describe("GET /admin", () => {
  it("returns 401 + WWW-Authenticate when no auth header is sent", async () => {
    const res = await SELF.fetch("https://example.com/admin");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("returns 401 when credentials are wrong", async () => {
    const res = await SELF.fetch("https://example.com/admin", {
      headers: { authorization: basic("admin", "nope") },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on a malformed authorization header", async () => {
    const res = await SELF.fetch("https://example.com/admin", {
      headers: { authorization: "NotBasic xyz" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 + HTML when credentials match", async () => {
    const res = await SELF.fetch("https://example.com/admin", {
      headers: { authorization: basic("admin", "letmein") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Admin");
    expect(body).toContain("Dashboard");
  });

  it("sets no-store cache-control on successful admin responses", async () => {
    const res = await SELF.fetch("https://example.com/admin", {
      headers: { authorization: basic("admin", "letmein") },
    });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("GET /admin — D1-backed dashboard", () => {
  beforeEach(async () => {
    await (env.DB as D1Database).prepare("DELETE FROM daily_metrics").run();
  });

  it("renders the sidebar sections and an empty state with no NaN", async () => {
    const res = await SELF.fetch("https://example.com/admin", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const section of ["Overview", "Geography", "Engagement", "Security", "Funnel"]) {
      expect(body).toContain(section);
    }
    expect(body).toContain("No data yet");
    expect(body).not.toContain("NaN");
  });

  it("reflects seeded metrics for the selected range", async () => {
    await flushMetricBatch(env.DB as D1Database, [
      seedMsg({ metric: "room_free", stegCountry: "KE", cfCountry: "KE" }),
      seedMsg({ metric: "room_paid", stegCountry: "KE", cfCountry: "GB" }),
      seedMsg({ metric: "second_party_joined", stegCountry: "KE", cfCountry: "KE" }),
      seedMsg({ metric: "message_sent", stegCountry: "KE", cfCountry: "KE" }),
    ]);
    const res = await SELF.fetch("https://example.com/admin?days=7", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("KE"); // country appears in the geography table
    expect(body).toContain("GB");
    expect(body).not.toContain("NaN");
  });

  it("accepts explicit from/to and never 500s on malformed params", async () => {
    const ok = await SELF.fetch("https://example.com/admin?from=2026-01-01&to=2026-01-31", {
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch("https://example.com/admin?from=garbage&days=abc", {
      headers: AUTH,
    });
    expect(bad.status).toBe(200);
  });

  it("has no Analytics Engine remnants and no inline script (CSP-safe)", async () => {
    const res = await SELF.fetch("https://example.com/admin", { headers: AUTH });
    const body = await res.text();
    expect(body).not.toContain("Analytics Engine");
    expect(body).not.toContain("writeDataPoint");
    expect(body).not.toContain("<script");
  });
});
