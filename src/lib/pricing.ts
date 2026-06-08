// SPDX-License-Identifier: AGPL-3.0-only
//
// Geo-aware, income-tiered price resolution.
//
// Every country/territory maps to one of four World Bank-style income tiers —
// high, upper-middle, lower-middle, low. Each tier has a price. A country that
// maps to no tier falls back to PRICE_CENTS (the default, e.g. $5).
//
// The tier→price table is overridable per environment via the PRICE_TIERS env
// var (JSON keyed by tier: {"high":1200,"upper":800,"lower":400,"low":200}) so
// staging can charge pennies while production charges real money. A partial
// override (e.g. only "high") leaves the other tiers at their defaults.
//
// The country comes from CF-IPCountry at request time and is used ONLY to
// choose an amount — never stored against a token or room — so the blind-token
// privacy guarantee is unchanged (geo-pricing changes the charged number,
// nothing else).
//
// Resolution runs in the two server-side places that see CF-IPCountry:
//   - GET /api/config        → the price the client displays
//   - handlePaymentInitiate  → the price actually charged (stored on the token)
// Both read this one helper, so shown price and charged price can't diverge.

import type { Env } from "../env";

export interface ResolvedPrice {
  cents: number;
  currency: string;
}

export type IncomeTier = "high" | "upper" | "lower" | "low";

// Default price per tier in minor units (USD cents). PRICE_TIERS overrides it.
export const DEFAULT_TIER_CENTS: Record<IncomeTier, number> = {
  high: 1200, // $12 — high income
  upper: 800, //  $8 — upper-middle income
  lower: 400, //  $4 — lower-middle income
  low: 200, //    $2 — low income
};

// ISO-3166 alpha-2 → income tier (World Bank FY2024 groupings; dependent
// territories inherit the tier of their economy). Exhaustive across inhabited
// countries and territories. Any code not listed uses PRICE_CENTS (the
// default) — uninhabited territories (AQ, BV, HM, GS, TF, UM) intentionally
// fall through. Moving a code between lists is the supported way to reprice.
const TIER_COUNTRIES: Record<IncomeTier, readonly string[]> = {
  high: [
    // Americas
    "US",
    "CA",
    "BM",
    "PR",
    "VI",
    "KY",
    "VG",
    "TC",
    "AI",
    "AW",
    "CW",
    "SX",
    "BQ",
    "BL",
    "MF",
    "GP",
    "MQ",
    "GF",
    "PM",
    "FK",
    "BS",
    "BB",
    "AG",
    "KN",
    "TT",
    "CL",
    "UY",
    "PA",
    "GY",
    "GL",
    // Europe
    "GB",
    "IE",
    "FR",
    "DE",
    "IT",
    "ES",
    "PT",
    "NL",
    "BE",
    "LU",
    "AT",
    "CH",
    "DK",
    "SE",
    "NO",
    "FI",
    "IS",
    "MT",
    "CY",
    "GR",
    "SI",
    "EE",
    "LV",
    "LT",
    "CZ",
    "SK",
    "PL",
    "HR",
    "HU",
    "RO",
    "AD",
    "MC",
    "LI",
    "SM",
    "VA",
    "FO",
    "IM",
    "JE",
    "GG",
    "GI",
    "AX",
    "SJ",
    // Middle East
    "IL",
    "AE",
    "QA",
    "KW",
    "SA",
    "BH",
    "OM",
    // Asia-Pacific
    "JP",
    "KR",
    "SG",
    "HK",
    "MO",
    "TW",
    "BN",
    "AU",
    "NZ",
    "GU",
    "MP",
    "PF",
    "NC",
    "PW",
    "NR",
    "CK",
    "NU",
    "WF",
    "NF",
    "PN",
    "CX",
    "CC",
    // Africa & Indian Ocean
    "SC",
    "RE",
    "YT",
    "SH",
    "IO",
  ],
  upper: [
    // Americas
    "MX",
    "BR",
    "AR",
    "CO",
    "PE",
    "EC",
    "PY",
    "CR",
    "DO",
    "JM",
    "SR",
    "BZ",
    "CU",
    "VE",
    "GT",
    "GD",
    "LC",
    "VC",
    "DM",
    "MS",
    "AS",
    // Europe & CIS
    "BG",
    "RS",
    "BA",
    "ME",
    "MK",
    "AL",
    "BY",
    "RU",
    "TR",
    "MD",
    "XK",
    // Asia
    "CN",
    "TH",
    "MY",
    "MN",
    "MV",
    "KZ",
    "TM",
    "AZ",
    "GE",
    "AM",
    "ID",
    // Africa
    "ZA",
    "BW",
    "NA",
    "GA",
    "GQ",
    "LY",
    "MU",
    // Pacific
    "FJ",
    "TO",
    "TV",
    "MH",
  ],
  lower: [
    // Asia
    "IN",
    "PK",
    "BD",
    "LK",
    "NP",
    "BT",
    "PH",
    "VN",
    "LA",
    "KH",
    "MM",
    "UZ",
    "KG",
    "TJ",
    "UA",
    "TL",
    // MENA
    "EG",
    "MA",
    "TN",
    "JO",
    "IR",
    "IQ",
    "LB",
    "DJ",
    "DZ",
    "PS",
    "MR",
    "EH",
    // Sub-Saharan Africa
    "NG",
    "KE",
    "GH",
    "CI",
    "SN",
    "CM",
    "ZM",
    "ZW",
    "TZ",
    "AO",
    "CG",
    "BJ",
    "ST",
    "KM",
    "LS",
    "SZ",
    "CV",
    // Latin America
    "BO",
    "HN",
    "NI",
    "SV",
    // Pacific
    "PG",
    "VU",
    "WS",
    "KI",
    "SB",
    "FM",
  ],
  low: [
    // Asia & MENA
    "AF",
    "YE",
    "KP",
    "SY",
    // Americas
    "HT",
    // Sub-Saharan Africa
    "ET",
    "CD",
    "UG",
    "RW",
    "MW",
    "MZ",
    "BF",
    "NE",
    "TD",
    "ML",
    "SO",
    "SS",
    "SD",
    "ER",
    "CF",
    "GM",
    "GW",
    "GN",
    "LR",
    "SL",
    "TG",
    "BI",
    "MG",
  ],
};

// Flatten to a lookup once at module load.
const COUNTRY_TIER: Record<string, IncomeTier> = (() => {
  const map: Record<string, IncomeTier> = {};
  for (const tier of Object.keys(TIER_COUNTRIES) as IncomeTier[]) {
    for (const cc of TIER_COUNTRIES[tier]) map[cc] = tier;
  }
  return map;
})();

// Per-tier prices, with optional env overrides layered over the defaults.
function tierPrices(env: Env): Record<IncomeTier, number> {
  const raw = (env as { PRICE_TIERS?: string }).PRICE_TIERS;
  if (!raw) return DEFAULT_TIER_CENTS;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: IncomeTier): number => {
      const v = o[k];
      return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_TIER_CENTS[k];
    };
    return { high: pick("high"), upper: pick("upper"), lower: pick("lower"), low: pick("low") };
  } catch {
    return DEFAULT_TIER_CENTS;
  }
}

/**
 * Resolve the paid-tier price for a request's country. Returns the country's
 * income-tier price, or the base PRICE_CENTS for any country not in a tier
 * (and for an empty/unknown country). Never throws on a pricing path.
 */
export function resolvePrice(country: string | null | undefined, env: Env): ResolvedPrice {
  const base = Number.parseInt(env.PRICE_CENTS ?? "200", 10) || 200;
  const currency = env.PAYMENT_CURRENCY || "USD";

  const tier = COUNTRY_TIER[(country ?? "").toUpperCase()];
  if (!tier) return { cents: base, currency };

  return { cents: tierPrices(env)[tier], currency };
}
