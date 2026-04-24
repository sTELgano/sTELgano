// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the "easy-to-drop" surfaces flagged in the v1 → v2 feature
// parity audit: panic route, robots.txt, and the .well-known files
// (security.txt + Apple Pay merchant-id verification).

// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /x — panic route", () => {
  it("returns a 302 redirect to /?p=1", async () => {
    const res = await SELF.fetch("https://example.com/x", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?p=1");
  });

  it("does not cache the redirect (no-store)", async () => {
    const res = await SELF.fetch("https://example.com/x", { redirect: "manual" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("GET /robots.txt", () => {
  it("serves the robots file and disallows functional paths", async () => {
    const res = await SELF.fetch("https://example.com/robots.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Disallow: /chat");
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /x");
  });
});

describe("GET /.well-known/*", () => {
  it("serves security.txt with operator contact info", async () => {
    const res = await SELF.fetch("https://example.com/.well-known/security.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Contact:");
    expect(body).toContain("Expires:");
  });

  it("serves the Apple Pay merchant-id domain association file", async () => {
    // Paystack's Apple Pay channel relies on this file being served at
    // exactly this path. If it 404s, Apple Pay breaks while the
    // other channels (card/bank/ussd/mobile_money) stay functional.
    const res = await SELF.fetch(
      "https://example.com/.well-known/apple-developer-merchantid-domain-association",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
