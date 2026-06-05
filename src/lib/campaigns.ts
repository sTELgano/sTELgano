// SPDX-License-Identifier: AGPL-3.0-only
//
// D1 access for campaigns — the operator-authored definitions behind
// the conversion-funnel tracker. A campaign is just a title, an
// optional description, a same-origin destination path, and a short
// `slug` used in the public tracking link (HOST/c/<slug>).
//
// PRIVACY: nothing here references a user, a room, or an IP. Funnel
// counts live in Analytics Engine keyed by the slug (blob4); this
// table holds only the campaign metadata. See migrations/0005.

/** A campaign slug: lowercase alphanumerics + hyphens, 1–40 chars.
 *  Also the only shape accepted by the /c/:slug tracking route and the
 *  `campaign` field of /api/funnel beacons. */
export const SLUG_RE = /^[a-z0-9-]{1,40}$/;

export type Campaign = {
  id: string;
  slug: string;
  title: string;
  description: string;
  destination: string;
  archived: number; // 0 | 1 (SQLite has no boolean)
  created_at: string;
};

const SELECT_COLS = "id, slug, title, description, destination, archived, created_at";

/** Derives a URL-safe slug from a free-text title. Lowercases, strips
 *  anything outside [a-z0-9-], collapses runs of hyphens, trims, and
 *  caps at 40 chars. Returns "" when the title has no usable
 *  characters (caller falls back to a random slug). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/** Normalises a destination path to a safe same-origin path. Anything
 *  that doesn't start with a single "/" (protocol-relative "//host",
 *  absolute URLs, empty) collapses to "/" to prevent open redirects
 *  from the /c/:slug route. */
export function normaliseDestination(raw: string | null | undefined): string {
  const d = (raw ?? "").trim();
  // Must be a same-origin path: exactly one leading "/", and the next
  // character must not be "/" or "\" — browsers treat "//evil.com" and
  // "/\evil.com" as protocol-relative URLs, which would turn the
  // /c/:slug redirect into an open redirect.
  if (!d.startsWith("/") || d[1] === "/" || d[1] === "\\") return "/";
  return d.slice(0, 256);
}

export type CreateCampaignArgs = {
  title: string;
  description?: string;
  destination?: string;
};

/** Inserts a new campaign, generating a unique slug from the title
 *  (with a short random suffix on collision). Throws on an empty
 *  title. Returns the created row. */
export async function createCampaign(db: D1Database, args: CreateCampaignArgs): Promise<Campaign> {
  const title = args.title.trim();
  if (!title) throw new Error("title is required");

  const base = slugify(title) || `c-${randomSuffix()}`;
  const slug = await uniqueSlug(db, base);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const description = (args.description ?? "").trim().slice(0, 500);
  const destination = normaliseDestination(args.destination);

  const row = await db
    .prepare(
      `INSERT INTO campaigns (id, slug, title, description, destination, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       RETURNING ${SELECT_COLS}`,
    )
    .bind(id, slug, title.slice(0, 120), description, destination, now)
    .first<Campaign>();

  if (!row) throw new Error("createCampaign: INSERT RETURNING returned no row");
  return row;
}

/** Returns the active (non-archived) campaign with the given slug, or
 *  null. Used by the public /c/:slug tracking route. */
export async function getCampaignBySlug(db: D1Database, slug: string): Promise<Campaign | null> {
  if (!SLUG_RE.test(slug)) return null;
  return db
    .prepare(`SELECT ${SELECT_COLS} FROM campaigns WHERE slug = ? AND archived = 0`)
    .bind(slug)
    .first<Campaign>();
}

/** Lists all non-archived campaigns, newest first. Used by the admin
 *  dashboard. */
export async function listCampaigns(db: D1Database): Promise<Campaign[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLS} FROM campaigns WHERE archived = 0 ORDER BY created_at DESC`)
    .all<Campaign>();
  return results ?? [];
}

/** Soft-deletes a campaign by id. Returns rows changed (0 if absent). */
export async function archiveCampaign(db: D1Database, id: string): Promise<number> {
  const result = await db
    .prepare("UPDATE campaigns SET archived = 1 WHERE id = ? AND archived = 0")
    .bind(id)
    .run();
  return result.meta.changes ?? 0;
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

/** Finds a free slug starting from `base`, appending "-<suffix>" on
 *  collision. Bounded retries; falls back to a fully-random slug. */
async function uniqueSlug(db: D1Database, base: string): Promise<string> {
  let candidate = base.slice(0, 40);
  for (let i = 0; i < 5; i++) {
    const existing = await db
      .prepare("SELECT 1 FROM campaigns WHERE slug = ?")
      .bind(candidate)
      .first<{ 1: number }>();
    if (!existing) return candidate;
    candidate = `${base.slice(0, 33)}-${randomSuffix()}`.slice(0, 40);
  }
  return `c-${randomSuffix()}`;
}
