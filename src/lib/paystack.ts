// SPDX-License-Identifier: AGPL-3.0-only
//
// Paystack payment-provider adapter.
//
// Direct port of elixir/lib/stelgano/monetization/providers/paystack.ex.
// Same endpoints, same request shape, same HMAC-SHA512 webhook
// verification. Only difference: runs on Workers (fetch + Web
// Crypto instead of Req + :crypto.mac).
//
// Privacy: the Paystack transaction reference IS the token_hash.
// No room_hash, steg number, or user identifier is sent to
// Paystack. The `email` field is a placeholder derived from the
// token_hash prefix, under a receipt-email domain the operator
// controls (so receipt mails bounce or land in the operator's own
// mailserver — never a third party's).
//
// FX conversion: when PAYSTACK_SETTLEMENT_CURRENCY differs from
// PAYMENT_CURRENCY, initialize() reads the cached rate from the
// RATE_CACHE KV namespace (written daily by the refreshRate() cron),
// applies PAYSTACK_FX_BUFFER_PCT (default 5%), and rounds to the
// nearest integer minor unit before submitting to Paystack.
// Falls back to PAYMENT_FX_FALLBACK_RATE if KV is empty.
// Returns fx_conversion_not_wired only when neither source yields a rate.

import type { Env } from "../env";
import { getRate } from "./fx_rate";

const PAYSTACK_API = "https://api.paystack.co";
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;

export type InitializeResult =
  | { ok: true; checkoutUrl: string }
  | { ok: false; reason: InitializeError };

export type InitializeError =
  | "missing_config"
  | "invalid_token_hash"
  | "fx_conversion_not_wired"
  | "provider_error"
  | "provider_unavailable";

/** Opens a Paystack checkout session for the given token_hash. The
 *  hash IS the transaction reference, so Paystack correlates the
 *  webhook back to our row by matching on `reference`.
 *
 *  Returns { ok: true, checkoutUrl } on success. The client redirects
 *  the browser to the URL; Paystack collects payment details on
 *  their hosted page, then redirects back to PAYSTACK_CALLBACK_URL
 *  with `?reference=<tokenHash>` appended. */
export async function initialize(
  tokenHash: string,
  amountCents: number,
  env: Env,
): Promise<InitializeResult> {
  if (!TOKEN_HASH_RE.test(tokenHash)) {
    return { ok: false, reason: "invalid_token_hash" };
  }
  if (
    !env.PAYSTACK_SECRET_KEY ||
    !env.PAYSTACK_CALLBACK_URL ||
    !env.PAYSTACK_RECEIPT_EMAIL_DOMAIN
  ) {
    return { ok: false, reason: "missing_config" };
  }

  const displayCurrency = env.PAYMENT_CURRENCY || "USD";
  const settlementCurrency = env.PAYSTACK_SETTLEMENT_CURRENCY || displayCurrency;

  let amountToCharge = amountCents;
  if (settlementCurrency !== displayCurrency) {
    const rate = await getRate(
      env.RATE_CACHE,
      displayCurrency.toLowerCase(),
      settlementCurrency.toLowerCase(),
      env.PAYMENT_FX_FALLBACK_RATE,
    );
    if (rate === null) {
      return { ok: false, reason: "fx_conversion_not_wired" };
    }
    const bufferPct = parseFloat(env.PAYSTACK_FX_BUFFER_PCT ?? "5");
    const buffer = Number.isFinite(bufferPct) ? bufferPct : 5;
    amountToCharge = Math.round(amountCents * rate * (1 + buffer / 100));
  }

  const body = {
    email: placeholderEmail(tokenHash, env.PAYSTACK_RECEIPT_EMAIL_DOMAIN),
    reference: tokenHash,
    amount: amountToCharge,
    currency: settlementCurrency,
    callback_url: env.PAYSTACK_CALLBACK_URL,
    channels: ["card", "bank", "ussd", "mobile_money"],
  };

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }

  type InitResp = {
    status?: boolean;
    data?: { authorization_url?: string };
    message?: string;
  };

  let parsed: InitResp;
  try {
    parsed = (await response.json()) as InitResp;
  } catch {
    return { ok: false, reason: "provider_error" };
  }

  if (
    response.status === 200 &&
    parsed.status === true &&
    parsed.data &&
    typeof parsed.data.authorization_url === "string"
  ) {
    return { ok: true, checkoutUrl: parsed.data.authorization_url };
  }

  return { ok: false, reason: "provider_error" };
}

/** Paystack's /transaction/initialize requires an email and mails a
 *  receipt to it. We supply `anonymous+<first8-of-token>@<domain>`
 *  so the user is never prompted. The domain MUST be operator-owned
 *  — a third-party domain would receive every transaction receipt.
 *  Typically set to the deployment's HOST with no MX record. */
function placeholderEmail(tokenHash: string, domain: string): string {
  return `anonymous+${tokenHash.slice(0, 8)}@${domain}`;
}

/** HMAC-SHA512(payload, secret) → lowercase hex. Used to verify
 *  the `x-paystack-signature` header on incoming webhook POSTs.
 *  Web Crypto is constant-time inside the comparison step; we
 *  also use constant-time-ish string compare on the caller side. */
export async function hmacSha512Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish string compare on already-hex-encoded strings.
 *  Not cryptographically perfect (length check short-circuits, but
 *  for fixed-length HMAC outputs that's fine). */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Calls Paystack's /transaction/verify/:reference and returns
 *  true iff the transaction exists and is `success`. Used for
 *  defence-in-depth double-verification in the webhook handler. */
export async function verifyTransaction(reference: string, env: Env): Promise<boolean> {
  if (!env.PAYSTACK_SECRET_KEY) return false;
  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
    });
  } catch {
    return false;
  }
  if (response.status !== 200) return false;

  type VerifyResp = { status?: boolean; data?: { status?: string } };
  let parsed: VerifyResp;
  try {
    parsed = (await response.json()) as VerifyResp;
  } catch {
    return false;
  }
  return parsed.status === true && parsed.data?.status === "success";
}
