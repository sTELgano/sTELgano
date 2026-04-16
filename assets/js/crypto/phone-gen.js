// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @fileoverview phone-gen.js — sTELgano steg number generator.
 *
 * Generates internationally valid-format phone numbers in E.164 format using
 * `crypto.getRandomValues` — never `Math.random`.
 *
 * Country selection is weighted by internet-connected population so generated
 * numbers look plausible. Subscriber number ranges use fictional/unassigned
 * blocks where documented (e.g. UK 07700 900xxx, US 555-0100–0199) to avoid
 * accidental collision with real numbers.
 *
 * @module phone-gen
 */

"use strict";

/**
 * Country descriptors for steg number generation.
 *
 * Each entry:
 *   cc      — ITU-T E.164 country code (without +)
 *   name    — country name (display only)
 *   digits  — number of subscriber digits (after country code)
 *   prefix  — optional fixed prefix for a fictional/reserved range
 *   weight  — relative weight for random selection (higher = more likely)
 *   format  — function that formats the national number for display
 *
 * @type {Array<{cc: string, name: string, digits: number, prefix?: string, weight: number, format: (s:string)=>string}>}
 */
const COUNTRIES = [
  // UK — 07700 900xxx is the OFCOM reserved fictional range
  {
    cc: "44", name: "United Kingdom", digits: 10,
    prefix: "7700900",
    weight: 8,
    format: s => `+44 ${s.slice(0,4)} ${s.slice(4,7)} ${s.slice(7)}`
  },
  // US — 555-0100 to 555-0199 is the NANPA fictional range
  {
    cc: "1", name: "United States", digits: 10,
    prefix: "5550",
    weight: 12,
    format: s => `+1 (${s.slice(0,3)}) ${s.slice(3,6)}-${s.slice(6)}`
  },
  // Kenya — +254 7xx xxx xxx (mobile)
  {
    cc: "254", name: "Kenya", digits: 9,
    prefix: "7",
    weight: 4,
    format: s => `+254 ${s.slice(0,3)} ${s.slice(3,6)} ${s.slice(6)}`
  },
  // Nigeria — +234 8xx xxx xxxx (mobile)
  {
    cc: "234", name: "Nigeria", digits: 10,
    prefix: "8",
    weight: 6,
    format: s => `+234 ${s.slice(0,3)} ${s.slice(3,7)} ${s.slice(7)}`
  },
  // India — +91 9xxxx xxxxx
  {
    cc: "91", name: "India", digits: 10,
    prefix: "9",
    weight: 14,
    format: s => `+91 ${s.slice(0,5)} ${s.slice(5)}`
  },
  // Germany — +49 1xx xxxxxxxx
  {
    cc: "49", name: "Germany", digits: 11,
    prefix: "15",
    weight: 6,
    format: s => `+49 ${s.slice(0,3)} ${s.slice(3,7)} ${s.slice(7)}`
  },
  // Brazil — +55 11 9xxxx-xxxx
  {
    cc: "55", name: "Brazil", digits: 11,
    prefix: "11",
    weight: 8,
    format: s => `+55 ${s.slice(0,2)} ${s.slice(2,7)}-${s.slice(7)}`
  },
  // France — +33 6xx xxx xxx
  {
    cc: "33", name: "France", digits: 9,
    prefix: "6",
    weight: 5,
    format: s => `+33 ${s.slice(0,1)} ${s.slice(1,3)} ${s.slice(3,5)} ${s.slice(5,7)} ${s.slice(7)}`
  },
  // South Africa — +27 8x xxx xxxx
  {
    cc: "27", name: "South Africa", digits: 9,
    prefix: "8",
    weight: 4,
    format: s => `+27 ${s.slice(0,2)} ${s.slice(2,5)} ${s.slice(5)}`
  },
  // Japan — +81 9x-xxxx-xxxx
  {
    cc: "81", name: "Japan", digits: 10,
    prefix: "9",
    weight: 6,
    format: s => `+81 ${s.slice(0,2)}-${s.slice(2,6)}-${s.slice(6)}`
  },
  // Canada — same NANPA range as US
  {
    cc: "1", name: "Canada", digits: 10,
    prefix: "6045550",
    weight: 4,
    format: s => `+1 (${s.slice(0,3)}) ${s.slice(3,6)}-${s.slice(6)}`
  },
  // Australia — +61 4xx xxx xxx
  {
    cc: "61", name: "Australia", digits: 9,
    prefix: "4",
    weight: 4,
    format: s => `+61 ${s.slice(0,3)} ${s.slice(3,6)} ${s.slice(6)}`
  },
];

// Build cumulative weight table for weighted random selection
const TOTAL_WEIGHT = COUNTRIES.reduce((sum, c) => sum + c.weight, 0);
const CUMULATIVE = (() => {
  let acc = 0;
  return COUNTRIES.map(c => {
    acc += c.weight;
    return acc;
  });
})();

/**
 * Generates a cryptographically random integer in [0, max).
 *
 * Uses rejection sampling to avoid modulo bias.
 * @param {number} max
 * @returns {number}
 */
function randomInt(max) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  let val;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val >= limit);
  return val % max;
}

/**
 * Generates a string of `n` random decimal digits using crypto.getRandomValues.
 * @param {number} n
 * @returns {string}
 */
function randomDigits(n) {
  let result = "";
  for (let i = 0; i < n; i++) {
    result += randomInt(10).toString();
  }
  return result;
}

/**
 * Selects a country using weighted random selection.
 * @returns {typeof COUNTRIES[0]}
 */
function pickCountry() {
  const r = randomInt(TOTAL_WEIGHT);
  for (let i = 0; i < CUMULATIVE.length; i++) {
    if (r < CUMULATIVE[i]) return COUNTRIES[i];
  }
  return COUNTRIES[COUNTRIES.length - 1];
}

/**
 * Generates a single steg number.
 *
 * @returns {{ e164: string, display: string, country: string }}
 *   e164    — canonical E.164 form (e.g. "+447700900123")
 *   display — localised display form (e.g. "+44 7700 900 123")
 *   country — country name
 */
export function generateStegNumber() {
  const country = pickCountry();

  const prefix = country.prefix || "";
  const remaining = country.digits - prefix.length;
  const national = prefix + randomDigits(remaining);

  const e164 = `+${country.cc}${national}`;
  const display = country.format(national);

  return { e164, display, country: country.name };
}

/**
 * Normalises a phone number to digits-only (same algorithm as AnonCrypto.normalise).
 * @param {string} raw
 * @returns {string}
 */
export function normalisePhone(raw) {
  return (raw || "").replace(/\D/g, "");
}

/**
 * Validates that a string looks like a plausible E.164 phone number.
 * Accepts formats like "+254700123456", "254700123456", or "+1 555 000 0100".
 * @param {string} raw
 * @returns {boolean}
 */
export function isPlausiblePhone(raw) {
  const digits = normalisePhone(raw);
  // E.164 allows 7–15 digits (after country code); we require 7–15 total
  return digits.length >= 7 && digits.length <= 15;
}
