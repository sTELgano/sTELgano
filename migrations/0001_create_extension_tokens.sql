-- SPDX-License-Identifier: AGPL-3.0-only
--
-- D1 (SQLite) port of v1's extension_tokens table.
-- Original: elixir/priv/repo/migrations/20260417000002_create_extension_tokens.exs
--
-- PRIVACY GUARANTEE (preserved from v1): this table intentionally has NO
-- room_id, room_hash, or access_hash column. The server cannot link a
-- payment to a specific room. The correlation between a token and a
-- room exists only ephemerally in memory during the redemption channel
-- event handler.
--
-- SQLite type notes vs. Postgres:
--   - id: TEXT (UUID hex string) — SQLite has no UUID type
--   - timestamps: TEXT (ISO 8601) — SQLite has no native datetime
--   - amount_cents stays INTEGER

CREATE TABLE extension_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  provider_ref TEXT,
  paid_at TEXT,
  redeemed_at TEXT,
  expires_at TEXT NOT NULL,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX extension_tokens_token_hash_idx ON extension_tokens(token_hash);
CREATE INDEX extension_tokens_status_idx ON extension_tokens(status);
CREATE INDEX extension_tokens_expires_at_idx ON extension_tokens(expires_at);
