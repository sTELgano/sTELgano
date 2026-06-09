// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side conversion-funnel beacons.
//
// The first and only client telemetry in the app — deliberately tiny
// and privacy-preserving. A beacon carries ONLY { step, campaign }; the
// server adds CF-IPCountry. No phone, room_hash, access_hash, cookie,
// or device id ever leaves the page through this path.
//
// Each step fires at most once per browser session (a sessionStorage
// guard), so the admin funnel counts approximate unique sessions
// reaching each stage rather than raw page-reload noise.
//
// Campaign attribution is read from sessionStorage (key
// "stelegano_campaign"), seeded by the homepage bootstrap or
// captureCampaign() below from the ?c=<slug> query param that the
// /c/<slug> tracking link forwards. Absent attribution → "direct".

export type FunnelStep =
  | "landing"
  | "chat_view"
  | "steg_generated"
  | "new_channel_view"
  | "setup_confirmed"
  | "channel_opened"
  | "extend_started"
  | "extend_completed";

const CAMPAIGN_KEY = "stelegano_campaign";
const FIRED_PREFIX = "stelegano_funnel:";
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

// Page-local dedup guard. sessionStorage handles once-per-session across
// page loads; this Set guarantees once-per-page even when sessionStorage
// is unavailable (private mode), so a step can't fire twice on one page.
const firedThisPage = new Set<string>();

function readCampaign(): string {
  try {
    const c = sessionStorage.getItem(CAMPAIGN_KEY);
    return c && SLUG_RE.test(c) ? c : "direct";
  } catch {
    return "direct";
  }
}

/** Reads a ?c=<slug> campaign param off the current URL, persists it
 *  for the rest of the session, and strips it from the address bar
 *  (mirrors the ?p=1 panic-flag handling). Idempotent and safe to call
 *  on any page the tracking link might land on. */
export function captureCampaign(): void {
  try {
    const u = new URL(window.location.href);
    const c = u.searchParams.get("c");
    if (c && SLUG_RE.test(c)) {
      sessionStorage.setItem(CAMPAIGN_KEY, c);
      // The /c/<slug> redirect already counted this landing server-side;
      // mark it fired so no client beacon double-counts the same session.
      sessionStorage.setItem(`${FIRED_PREFIX}landing`, "1");
      u.searchParams.delete("c");
      window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    }
  } catch {
    // sessionStorage / URL unavailable — attribution silently degrades.
  }
}

/** Fires a funnel beacon for `step`, at most once per session. */
export function fireFunnel(step: FunnelStep): void {
  if (firedThisPage.has(step)) return;
  firedThisPage.add(step);

  const firedKey = FIRED_PREFIX + step;
  try {
    if (sessionStorage.getItem(firedKey)) return;
    sessionStorage.setItem(firedKey, "1");
  } catch {
    // sessionStorage disabled — the page-local Set above still dedups.
  }

  const body = JSON.stringify({ step, campaign: readCampaign() });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/funnel", body);
      return;
    }
  } catch {
    // sendBeacon blocked — fall through to fetch.
  }
  try {
    void fetch("/api/funnel", {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    });
  } catch {
    // Best-effort; a dropped beacon just under-counts one step.
  }
}
