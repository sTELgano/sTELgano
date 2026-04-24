// SPDX-License-Identifier: AGPL-3.0-only
//
// Smoke test the workers pool is wired correctly. If this fails,
// every other worker-runtime test will too — fix this first.
//
// SELF is the test-harness binding that points at the Worker's
// default export. Calling SELF.fetch() hits our actual _worker.ts
// handler with a real workerd Request and real Response.

// @ts-expect-error — types ship with the vitest-pool-workers
// package but aren't in the default @cloudflare/workers-types
// resolution. Adding the triple-slash reference is a noisier fix;
// the expect-error is the minimal annotation.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("returns 200 with the literal body 'ok'", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("carries the always-on security headers", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
