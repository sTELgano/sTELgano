// SPDX-License-Identifier: AGPL-3.0-only
//
// Fetches /api/config and patches text on static pages where pricing
// and TTL values would otherwise be hardcoded to build-time defaults.
// Also hides [data-monetization-only] sections when monetization is off.
//
// Loaded as `<script type="module" src="/assets/config-patch.js">` on:
//   - pricing.html   (price, free TTL, paid TTL, monetization gate)
//   - privacy.html   (monetization gate for Payments section)
//   - payment/callback.html (paid TTL days)

interface ApiConfig {
  monetization_enabled: boolean;
  free_ttl_days: number;
  paid_ttl_days: number;
  price_cents: number;
  currency: string;
}

async function patchConfig(): Promise<void> {
  let config: ApiConfig;
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    config = (await r.json()) as ApiConfig;
  } catch {
    return;
  }

  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: config.currency,
  }).format(config.price_cents / 100);

  for (const el of document.querySelectorAll<HTMLElement>("[data-config]")) {
    switch (el.dataset.config) {
      case "free-ttl":
        el.textContent = config.monetization_enabled
          ? `${config.free_ttl_days} days, then recycled`
          : "Unlimited — no expiry";
        break;
      case "paid-ttl":
        el.textContent = `${config.paid_ttl_days} days, your number alone`;
        break;
      case "paid-ttl-days":
        el.textContent = String(config.paid_ttl_days);
        break;
      case "price":
        el.textContent = price;
        break;
    }
  }

  if (!config.monetization_enabled) {
    for (const el of document.querySelectorAll<HTMLElement>("[data-monetization-only]")) {
      el.hidden = true;
    }
  }
}

patchConfig();
