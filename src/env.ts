// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker Env type — extends the generated Cloudflare.Env from
// worker-configuration.d.ts (produced by `wrangler types`) with the
// three optional secrets that aren't declared in wrangler.toml and
// therefore absent from the auto-generated interface.
//
// Regenerate worker-configuration.d.ts whenever wrangler.toml changes:
//   npx wrangler types

export interface Env extends Cloudflare.Env {
  // Optional secrets set via `wrangler secret put`; not in wrangler.toml
  // so not included in the generated Cloudflare.Env.
  PAYSTACK_SETTLEMENT_CURRENCY?: string;
  PAYSTACK_FX_BUFFER_PCT?: string;
  PAYMENT_FX_FALLBACK_RATE?: string;
}
