// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/webhooks/paystack — Paystack hits this after a successful
// charge with an HMAC-SHA512 signature over the raw body.
//
// Security properties this file pins:
//   1. Bad signature → 401 (explicitly named: bad sigs should loudly
//      fail so operators notice attempted forgery).
//   2. Good signature + non-charge.success event → 200 silent-swallow.
//      We never want the response body to leak what event types we
//      care about.
//   3. Good signature + unknown reference → 200 silent-swallow, same
//      reasoning (don't leak which references exist).
//   4. Malformed JSON body with valid signature → 200 silent-swallow.
//
// No test here exercises the happy path of markPaid — that would need
// a mock Paystack /transaction/verify backend, which is worth doing but
// is better as a local integration test than a unit one.

import { describe, expect, it } from "vitest";
// @ts-expect-error — see healthz.test.ts
import { SELF } from "cloudflare:test";

const SECRET = "sk_test_REPLACE_ME"; // matches .dev.vars

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postSigned(rawBody: string, signature: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/webhooks/paystack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paystack-signature": signature,
    },
    body: rawBody,
  });
}

describe("POST /api/webhooks/paystack", () => {
  it("returns 401 when the signature is missing", async () => {
    const res = await SELF.fetch("https://example.com/api/webhooks/paystack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "charge.success", data: { reference: "x" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });

  it("returns 401 when the signature does not match the body", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
    const res = await postSigned(raw, "deadbeef");
    expect(res.status).toBe(401);
  });

  it("returns 200 for a signed but non-charge.success event", async () => {
    const raw = JSON.stringify({ event: "charge.failed", data: { reference: "x" } });
    const sig = await hmacHex(SECRET, raw);
    const res = await postSigned(raw, sig);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns 200 for a signed charge.success with unknown reference", async () => {
    // Signature passes → body is parsed → verifyTransaction fails
    // (because the test Paystack key isn't real) → handler silently
    // swallows with status:ok. The important property is that the
    // response gives no oracle for "is this reference in our DB".
    const raw = JSON.stringify({
      event: "charge.success",
      data: { reference: "never-seen-" + crypto.randomUUID() },
    });
    const sig = await hmacHex(SECRET, raw);
    const res = await postSigned(raw, sig);
    expect(res.status).toBe(200);
  });

  it("returns 200 for signed but unparseable body (no oracle leak)", async () => {
    const raw = "not-json-at-all";
    const sig = await hmacHex(SECRET, raw);
    const res = await postSigned(raw, sig);
    expect(res.status).toBe(200);
  });

  it("returns 200 for a signed charge.success with no reference field", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: {} });
    const sig = await hmacHex(SECRET, raw);
    const res = await postSigned(raw, sig);
    expect(res.status).toBe(200);
  });
});
