// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for extension_tokens. Ports
// elixir/lib/stelgano/monetization/extension_token.ex and the lifecycle
// helpers in elixir/lib/stelgano/monetization.ex.
//
// PRIVACY GUARANTEE (preserved from v1): no row in this table holds a
// reference to a room. The correlation between a paid token and a
// specific room exists only ephemerally inside the redeem_extension
// handler in src/room.ts (Phase 7).
//
// Lifecycle:
//   pending --paid--> paid --redeemed--> redeemed
//      \                \
//       expired (sweep)  expired (sweep)

const HEX64_RE = /^[a-f0-9]{64}$/;

export type TokenStatus = "pending" | "paid" | "redeemed";

export type ExtensionToken = {
  id: string;
  token_hash: string;
  status: TokenStatus;
  amount_cents: number;
  currency: string;
  provider_ref: string | null;
  paid_at: string | null;
  redeemed_at: string | null;
  expires_at: string;
  inserted_at: string;
  updated_at: string;
};

export type CreatePendingArgs = {
  tokenHash: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
};

/** Creates a new pending token. Validates token_hash is 64-char lowercase
 *  hex (SHA-256 digest of the client-side extension_secret), amount > 0,
 *  Throws on invalid input. Currency is validated by the payment
 *  provider (Paystack rejects unsupported codes directly). */
export async function createPending(
  db: D1Database,
  args: CreatePendingArgs,
): Promise<ExtensionToken> {
  if (!HEX64_RE.test(args.tokenHash)) {
    throw new Error("token_hash must be lowercase hex SHA-256 digest");
  }
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error("amount_cents must be a positive integer");
  }
  if (!args.currency || !/^[A-Z]{3}$/.test(args.currency)) {
    throw new Error("currency must be a 3-letter ISO 4217 code");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO extension_tokens
        (id, token_hash, status, amount_cents, currency, expires_at, inserted_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .bind(id, args.tokenHash, args.amountCents, args.currency, args.expiresAt, now, now)
    .run();

  const row = await findByTokenHash(db, args.tokenHash);
  if (!row) {
    // Should be impossible — we just inserted it. Throw rather than
    // returning a fake row so the caller hears about real DB problems.
    throw new Error("createPending: token disappeared after insert");
  }
  return row;
}

/** Returns the token with the given hash, or null if not found. */
export async function findByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<ExtensionToken | null> {
  if (!HEX64_RE.test(tokenHash)) return null;
  return db
    .prepare(
      `SELECT id, token_hash, status, amount_cents, currency, provider_ref,
              paid_at, redeemed_at, expires_at, inserted_at, updated_at
       FROM extension_tokens WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<ExtensionToken>();
}

/** Marks a token as paid, optionally recording the provider's reference
 *  (e.g. the Paystack reference returned from /transaction/verify).
 *  Returns the number of rows updated (0 if the token doesn't exist or
 *  is already past pending). */
export async function markPaid(
  db: D1Database,
  tokenHash: string,
  providerRef?: string,
): Promise<number> {
  if (!HEX64_RE.test(tokenHash)) return 0;
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE extension_tokens
       SET status = 'paid', paid_at = ?, provider_ref = ?, updated_at = ?
       WHERE token_hash = ? AND status = 'pending'`,
    )
    .bind(now, providerRef ?? null, now, tokenHash)
    .run();
  return result.meta.changes ?? 0;
}

/** Marks a paid token as redeemed. Returns number of rows updated.
 *  Idempotent at the SQL layer — a second call returns 0. */
export async function markRedeemed(db: D1Database, tokenHash: string): Promise<number> {
  if (!HEX64_RE.test(tokenHash)) return 0;
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE extension_tokens
       SET status = 'redeemed', redeemed_at = ?, updated_at = ?
       WHERE token_hash = ? AND status = 'paid'`,
    )
    .bind(now, now, tokenHash)
    .run();
  return result.meta.changes ?? 0;
}

/** Deletes tokens whose expires_at is past `cutoffIso`. Used by the
 *  daily Cron Trigger that replaces the v1 ExpireUnredeemedTokens Oban
 *  job. Returns the number of rows deleted. */
export async function deleteExpired(db: D1Database, cutoffIso: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM extension_tokens WHERE expires_at < ?")
    .bind(cutoffIso)
    .run();
  return result.meta.changes ?? 0;
}
