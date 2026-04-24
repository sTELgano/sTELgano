// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /admin — HTTP Basic Auth dashboard. Covers the auth gate only;
// the HTML body renders whatever D1 currently holds and isn't worth
// scraping. Credentials come from .dev.vars via the pool wrangler
// config: ADMIN_USERNAME="admin", ADMIN_PASSWORD="letmein".

// @ts-expect-error — see healthz.test.ts for why this expect-error lives here.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
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
