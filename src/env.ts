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
  // Secrets set via `wrangler secret put` — not in wrangler.toml, so
  // absent from the auto-generated Cloudflare.Env in
  // worker-configuration.d.ts. Re-run `npx wrangler types` after any
  // wrangler.toml change to keep that file in sync.
  PAYSTACK_SETTLEMENT_CURRENCY?: string;
  PAYSTACK_FX_BUFFER_PCT?: string;
  PAYMENT_FX_FALLBACK_RATE?: string;
  CF_AE_API_TOKEN?: string;
  // RATE_CACHE is declared in wrangler.toml but typed as optional here
  // so code handles self-hosters who skip the KV provisioning step.
  // Remove this override once `wrangler types` has been re-run after
  // the [[kv_namespaces]] entry lands in wrangler.toml.
  RATE_CACHE?: KVNamespace;
}
