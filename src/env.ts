// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker Env type — extends the generated Cloudflare.Env from
// worker-configuration.d.ts (produced by `wrangler types`) with secrets
// that are set via `wrangler secret put` and therefore absent from the
// auto-generated interface. `wrangler types` reads only wrangler.toml; in
// CI environments without CF auth it cannot discover the remote secret
// store, so these would be untyped without this file.
//
// Regenerate worker-configuration.d.ts whenever wrangler.toml changes:
//   npx wrangler types

export interface Env extends Cloudflare.Env {
  // Optional deployment tuning — set via `wrangler secret put`, absent from
  // the auto-generated Cloudflare.Env since they are not committed vars.
  PAYSTACK_SETTLEMENT_CURRENCY?: string;
  PAYSTACK_FX_BUFFER_PCT?: string; // default "5" applied in code
  PAYMENT_FX_FALLBACK_RATE?: string;
  CF_AE_API_TOKEN?: string;
  // Secrets set via `wrangler secret put` — not in wrangler.toml, so absent
  // from the CI-generated Cloudflare.Env. Declaring here keeps typecheck
  // passing regardless of whether wrangler types had CF auth.
  ADMIN_USERNAME: string; // optional secret; Worker falls back to "admin" when unset
  ADMIN_PASSWORD: string;
  PAYSTACK_SECRET_KEY: string;
  PAYSTACK_PUBLIC_KEY: string; // set but not read server-side; hosted checkout only
  PAYSTACK_CALLBACK_URL: string;
  PAYSTACK_RECEIPT_EMAIL_DOMAIN: string;
}
