// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/payment/initiate — starts a Paystack checkout session.
// These tests stop short of making a real Paystack call (the test
// dev.vars key is "sk_test_REPLACE_ME"). Instead they pin the
// pre-network validation: monetization gate, JSON parsing, token_hash
// shape. A live Paystack HTTP interaction is out of scope for unit
// tests — the adapter itself is covered by the pure-function tests
// in test/lib/paystack.test.ts.

// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const VALID_TOKEN_HASH = "c".repeat(64);

async function post(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/api/payment/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/payment/initiate", () => {
  it("returns 400 on unparseable JSON", async () => {
    const res = await post("not-json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("returns 400 when token_hash is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token_hash");
  });

  it("returns 400 when token_hash is not 64-char lowercase hex", async () => {
    const res = await post({ token_hash: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token_hash");
  });

  it("returns 400 when token_hash is uppercase hex", async () => {
    const res = await post({ token_hash: "A".repeat(64) });
    expect(res.status).toBe(400);
  });

  // With a well-formed payload the handler hits Paystack. The test
  // env has MONETIZATION_ENABLED=true but a placeholder sk_test_
  // key — so the request either reaches Paystack and gets rejected
  // (provider_error) or the outbound fetch fails (provider_unavailable).
  // Either way the server answers 502 with a mapped error code. The
  // assertion shape pins that the gate-passing branch returns a
  // 5xx+JSON, not a 200, until the Paystack adapter wiring is exercised
  // by integration tests with a real sandbox key.
  it("accepts a well-formed token_hash and reaches the provider branch", async () => {
    const res = await post({ token_hash: VALID_TOKEN_HASH });
    expect([502, 500]).toContain(res.status);
    const body = (await res.json()) as { error: string };
    expect(["provider_error", "provider_unavailable", "create_token_failed"]).toContain(body.error);
  });
});
