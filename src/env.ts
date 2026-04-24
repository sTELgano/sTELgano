// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker bindings declared in wrangler.toml. Imported by every module
// that touches the runtime (Hono routes, Durable Object, future D1
// migrations) so the type is the single source of truth.

export interface Env {
  /** Static asset binding from wrangler.toml [assets]. */
  ASSETS: Fetcher;

  /** Durable Object namespace for the room class. */
  ROOM: DurableObjectNamespace;

  /** D1 database for aggregate metrics + extension tokens. */
  DB: D1Database;

  // ---- Plain vars (set in wrangler.toml [vars]) ----
  PHX_HOST: string;
  PAYMENT_CURRENCY: string;
  PRICE_CENTS: string;
  FREE_TTL_DAYS: string;
  PAID_TTL_DAYS: string;
  MONETIZATION_ENABLED: string;

  // ---- Secrets (`wrangler secret put`) — undefined until set. ----
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_CALLBACK_URL?: string;
  PAYSTACK_RECEIPT_EMAIL_DOMAIN?: string;
  PAYSTACK_SETTLEMENT_CURRENCY?: string;
  PAYSTACK_FX_BUFFER_PCT?: string;
  PAYMENT_FX_FALLBACK_RATE?: string;
}
