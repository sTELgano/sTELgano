-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Campaigns table — marketing-attribution metadata for the conversion
-- funnel tracker. Each campaign owns a short `slug` used in the public
-- tracking link (stelgano.com/c/<slug>). Visits and downstream funnel
-- steps are counted in Analytics Engine (blob4 = campaign slug); this
-- table holds only the operator-authored campaign definition.
--
-- PRIVACY: this table carries NO user data — no room_hash, phone,
-- access_hash, or IP. It is operator content, written exclusively
-- through the Basic-Auth-gated /admin POST routes. The funnel counts
-- themselves live in Analytics Engine as aggregate data points, never
-- joined to any individual room.
--
-- SQLite type notes (mirrors 0001_create_extension_tokens.sql):
--   - id: TEXT (UUID hex string)
--   - archived: INTEGER (0/1) — SQLite has no boolean type
--   - timestamps: TEXT (ISO 8601)

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '/',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX campaigns_slug_idx ON campaigns(slug);
CREATE INDEX campaigns_archived_idx ON campaigns(archived);
