// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign conversion-funnel tracking — D1 CRUD layer plus the public
// routes (/c/:slug tracking redirect, /api/funnel beacon) and the
// Basic-Auth-gated admin create/archive routes. Runtime tests against a
// real in-memory D1 (schema from migrations/0005) and the live worker
// via SELF.

// @ts-expect-error — see healthz.test.ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  archiveCampaign,
  createCampaign,
  getCampaignBySlug,
  listCampaigns,
} from "../../src/lib/campaigns";

function basic(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

describe("campaigns D1 CRUD", () => {
  it("creates a campaign, derives a slug, and reads it back", async () => {
    const c = await createCampaign(env.DB, {
      title: "Instagram Launch Push",
      description: "IG story",
      destination: "/chat",
    });
    expect(c.slug).toBe("instagram-launch-push");
    expect(c.destination).toBe("/chat");
    expect(c.archived).toBe(0);

    const found = await getCampaignBySlug(env.DB, "instagram-launch-push");
    expect(found?.id).toBe(c.id);
  });

  it("disambiguates a duplicate title with a suffixed slug", async () => {
    const a = await createCampaign(env.DB, { title: "Dup Title" });
    const b = await createCampaign(env.DB, { title: "Dup Title" });
    expect(a.slug).toBe("dup-title");
    expect(b.slug).not.toBe(a.slug);
    expect(b.slug.startsWith("dup-title-")).toBe(true);
  });

  it("normalises an unsafe destination to '/'", async () => {
    const c = await createCampaign(env.DB, {
      title: "Open Redirect Attempt",
      destination: "https://evil.com",
    });
    expect(c.destination).toBe("/");
  });

  it("archive hides the campaign from getCampaignBySlug and listCampaigns", async () => {
    const c = await createCampaign(env.DB, { title: "To Be Archived" });
    const changed = await archiveCampaign(env.DB, c.id);
    expect(changed).toBe(1);
    expect(await getCampaignBySlug(env.DB, c.slug)).toBeNull();
    const list = await listCampaigns(env.DB);
    expect(list.find((x) => x.id === c.id)).toBeUndefined();
  });

  it("throws on an empty title", async () => {
    await expect(createCampaign(env.DB, { title: "   " })).rejects.toThrow(/title/);
  });
});

describe("GET /c/:slug — tracking link", () => {
  it("302-redirects to the campaign destination carrying ?c=<slug>", async () => {
    const c = await createCampaign(env.DB, { title: "Track Me", destination: "/chat" });
    const res = await SELF.fetch(`https://example.com/c/${c.slug}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/chat?c=${c.slug}`);
  });

  it("redirects unknown slugs home with no leak", async () => {
    const res = await SELF.fetch("https://example.com/c/does-not-exist", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("redirects an invalid (uppercase) slug home", async () => {
    const res = await SELF.fetch("https://example.com/c/NOPE", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("POST /api/funnel — beacon", () => {
  it("accepts a valid step and returns 204", async () => {
    const res = await SELF.fetch("https://example.com/api/funnel", {
      method: "POST",
      body: JSON.stringify({ step: "chat_view", campaign: "summer" }),
    });
    expect(res.status).toBe(204);
  });

  it("rejects an unknown step with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/funnel", {
      method: "POST",
      body: JSON.stringify({ step: "room_free", campaign: "summer" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/funnel", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("tolerates a missing/invalid campaign (defaults to direct) → 204", async () => {
    const res = await SELF.fetch("https://example.com/api/funnel", {
      method: "POST",
      body: JSON.stringify({ step: "landing", campaign: "NOT A SLUG" }),
    });
    expect(res.status).toBe(204);
  });
});

describe("admin campaign routes — Basic Auth gate", () => {
  it("rejects unauthenticated create with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/campaigns", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "Nope" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("creates a campaign from an authenticated form post (303) and persists it", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/campaigns", {
      method: "POST",
      headers: {
        authorization: basic("admin", "letmein"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "Form Created", destination: "/chat" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");

    const found = await getCampaignBySlug(env.DB, "form-created");
    expect(found?.title).toBe("Form Created");
    expect(found?.destination).toBe("/chat");
  });

  it("rejects unauthenticated archive with 401", async () => {
    const c = await createCampaign(env.DB, { title: "Archive Guard" });
    const res = await SELF.fetch(`https://example.com/api/admin/campaigns/${c.id}/archive`, {
      method: "POST",
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    // still present
    expect(await getCampaignBySlug(env.DB, c.slug)).not.toBeNull();
  });

  it("archives via an authenticated post (303)", async () => {
    const c = await createCampaign(env.DB, { title: "Archive Me Auth" });
    const res = await SELF.fetch(`https://example.com/api/admin/campaigns/${c.id}/archive`, {
      method: "POST",
      headers: { authorization: basic("admin", "letmein") },
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(await getCampaignBySlug(env.DB, c.slug)).toBeNull();
  });
});

describe("GET /admin — campaigns section render", () => {
  it("renders the overall funnel, the campaign, and its tracking link", async () => {
    const c = await createCampaign(env.DB, { title: "Dashboard Render Check" });
    const res = await SELF.fetch("https://example.com/admin", {
      headers: { authorization: basic("admin", "letmein") },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Overall platform funnel");
    expect(body).toContain("Dashboard Render Check");
    expect(body).toContain(`/c/${c.slug}`);
  });
});
