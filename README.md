<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# sTELgano

**The messaging app hidden in your contacts.**

`sTELgano` — pronounced **stel-GAH-no**. A portmanteau of **stegano**graphy and **TEL**, the contact layer it hides inside.

sTELgano is a privacy-focused anonymous messaging app and open protocol. It protects you from the people in your life — a partner who picks up your phone, a family member with device access. Not from governments. We say this clearly, because honesty is the product.

Two people share a phone number saved in their contacts. Each picks their own PIN. No account. No history. One message at a time.

[![AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-green.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com)
[![sTELgano-std-1](https://img.shields.io/badge/protocol-sTELgano--std--1-10B981.svg)](https://stelgano.com/spec)

---

## How it works

1. **Generate a steg number** — pick a country and generate a random international phone number from the integrated drawer inside `/chat`. All numbers are strictly formatted in E.164 (e.g. `+1212...`).
2. **Choose your own PIN** — never shared with anyone. The PIN never leaves your device.
3. **Open the channel** — enter your secret number and PIN. Your browser derives all keys locally via the Web Crypto API. The server sees only hashes and ciphertext.

### The N=1 invariant

At most one message exists on the server at any moment. When you reply, the previous message is permanently deleted in an atomic operation. No history. Anywhere.

### What the server stores vs. never stores

| Stores | Never stores |
|--------|-------------|
| SHA-256(phone + salt) — not reversible | Phone number |
| SHA-256(phone + PIN + salt) — not reversible | PIN |
| AES-256-GCM ciphertext | Encryption key |
| Anonymous sender identifier | Message plaintext |

---

## Cryptographic specification

Canonical implementation: [src/client/crypto/anon.ts](src/client/crypto/anon.ts)

```
room_hash   = SHA-256(normalise(phone) + ":" + ROOM_SALT)
access_hash = SHA-256(normalise(phone) + ":" + PIN + ":" + ACCESS_SALT)
enc_key     = PBKDF2(password: phone, salt: room_id + ENC_SALT,
                     iterations: 600_000, hash: SHA-256, keylen: 256 bits)
```

Encryption: AES-256-GCM, 96-bit random nonce per message, 128-bit auth tag.
600,000 PBKDF2 iterations — OWASP 2023 recommendation. Zero external libraries.

---

## Architecture

**Runtime:** Cloudflare Workers + Assets + Durable Objects + D1.

- **Worker** (`_worker.ts`) — routes all requests, applies security headers (CSP, HSTS), handles HTTP API and WebSocket upgrades. `run_worker_first = true` ensures even static assets pass through the security-header middleware.
- **RoomDO** (Durable Object) — one instance per room, single-threaded. Enforces the N=1 invariant by construction. Uses hibernatable WebSockets to keep idle rooms cheap. SQLite-backed storage for per-room state.
- **D1** — extension tokens, country metrics, daily metrics. No per-room country metadata — server-blindness invariant preserved.
- **Static assets** (`public/`) — HTML pages, bundled JS, CSS, fonts. Uploaded to Cloudflare's asset store on deploy.

**Real-time:** WebSocket connections upgrade to the room's Durable Object. The client sends `join`, `send_message`, `read_receipt`, `edit_message`, `delete_message`, `typing`, `expire_room`, and `redeem_extension` events.

---

## Features

- **N=1 messaging** — at most one message per room, enforced atomically by the Durable Object's single-threaded runtime
- **Client-side crypto** — AES-256-GCM, PBKDF2 at 600k iterations, Web Crypto API only
- **Real-time** — Durable Object WebSockets for send, read receipts, edit/delete before read, typing indicators
- **Lock screen** — PIN re-entry to resume, session clear for panic situations
- **History Masking** — forces the browser history to only log the root path (`/`), leaving no trace of sensitive sub-pages
- **Vault Isolation** — uses non-standard field attributes to discourage browser password managers from saving credentials
- **Panic route** — `GET /x` instantly clears all session data, redirects to `/?p=1`
- **Steg number generator** — integrated one-click generator drawer inside `/chat`; 19 curated countries, strict E.164 formatting with real-time country inference
- **Admin dashboard** — aggregate metrics at `/admin` (HTTP Basic Auth)
- **Privacy-preserving telemetry** — lifetime per-country counters + daily global counters; no per-room country metadata, no third-party analytics
- **Blog** — technical articles at `/blog`
- **Protocol spec** — sTELgano-std-1 specification at `/spec`
- **Pure web app** — no PWA, no service worker, no installable icon (see the passcode test rationale in the blog)
- **Self-hosted fonts** — Inter / Outfit / JetBrains Mono ship from `public/fonts/`; no Google Fonts CDN pings
- **Nonce-based CSP** — per-request nonce injected into the HTML at the Worker level; no `'unsafe-inline'` for scripts
- **Rate limiting** — IP-based, tighter limits for `/admin` and WebSocket upgrades
- **Security headers** — CSP, HSTS, X-Frame-Options, X-Robots-Tag
- **Configurable monetization** — optional paid tier for extended steg number TTL, pluggable payment providers (Paystack ships built-in)
- **Privacy-preserving payments** — blind token protocol; the server cannot link a payment to a specific room
- **Daily token cleanup** — Cron Trigger at 03:00 UTC sweeps expired extension tokens from D1

---

## Monetization (optional)

Monetization is fully optional and disabled by default. Self-hosters can run sTELgano without monetization — all rooms get unlimited TTL.

When enabled, steg numbers have a configurable free TTL (default 7 days). Users can purchase a dedicated number for 1 year. The payment flow uses a **blind token** design: the `extension_tokens` table has no `room_id` column, so the server cannot link a payment to a specific room.

---

## Self-hosting

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (free tier works)

### Local development

```bash
git clone https://github.com/sTELgano/sTELgano
cd stelgano
npm install
npm run build          # compile HTML, icons, client JS, CSS
npm run dev            # wrangler dev → http://localhost:8787
```

### Production deploy

```bash
wrangler d1 create stelgano          # create D1 database, note the ID
# paste database_id into wrangler.toml

wrangler d1 migrations apply stelgano --remote   # apply schema
wrangler deploy                                   # deploy Worker
```

### Environment variables (production)

Set via `wrangler secret put <NAME>` for secrets, or in `wrangler.toml [vars]` for non-sensitive values.

| Variable | Required | Purpose |
|----------|----------|---------|
| `PHX_HOST` | Yes | Production hostname (used for CORS and `check_origin`) |
| `ADMIN_PASSWORD` | Yes | Admin dashboard password (HTTP Basic Auth) |
| `ADMIN_USERNAME` | No | Admin dashboard username (default: `admin`) |
| `MONETIZATION_ENABLED` | No | Set to `true` to enable paid tiers |
| `PAYSTACK_SECRET_KEY` | If monetization | Paystack secret key |
| `PAYSTACK_PUBLIC_KEY` | If monetization | Paystack public key |
| `PAYSTACK_CALLBACK_URL` | If monetization | Post-payment redirect URL |
| `PAYSTACK_RECEIPT_EMAIL_DOMAIN` | If monetization | Operator-controlled domain for anonymous placeholder emails sent to Paystack |
| `PAYMENT_CURRENCY` | No | ISO 4217 display currency (default: `USD`) |
| `PRICE_CENTS` | No | Price in smallest display-currency unit (default: `200`) |
| `FREE_TTL_DAYS` | No | Free tier TTL in days (default: `7`) |
| `PAID_TTL_DAYS` | No | Paid tier TTL in days (default: `365`) |

---

## Development

```bash
npm run dev          # local dev server (wrangler dev)
npm run typecheck    # TypeScript type checking (tsc --noEmit)
npm run lint         # Biome linter
npm run format       # Biome formatter (write)
npm run format:check # Biome formatter (check only)
npm run check        # Biome check (lint + format combined)
npm run check:fix    # Biome check with auto-fix
npm run precommit    # typecheck + check + test (run before pushing)
npm test             # vitest run (pure-function + worker-runtime suites)
npm run test:watch   # vitest watch mode
npm run build        # compile all client assets to public/
```

The test suite has two projects (see `vitest.workspace.ts`):
- **Pure-function** (`vitest.config.ts`) — Node environment, no Workers runtime needed
- **Worker-runtime** (`vitest.workers.config.ts`) — runs under real workerd via `@cloudflare/vitest-pool-workers`

---

## Routes

| Path | Description |
|------|-------------|
| `/` | Homepage |
| `/chat` | Anonymous chat (no URL params; steg number generator integrated as slide-in drawer) |
| `/pricing` | Pricing page |
| `/spec` | Protocol specification |
| `/blog` | Blog index |
| `/blog/:slug` | Individual blog post |
| `/security`, `/privacy`, `/terms`, `/about` | Static pages |
| `/admin` | Admin dashboard (HTTP Basic Auth) |
| `/payment/callback` | Post-payment redirect (monetization) |
| `/api/room/:hash/exists` | Room existence check (GET) |
| `/api/payment/initiate` | Start payment flow (POST) |
| `/api/webhooks/paystack` | Paystack webhook endpoint (HMAC-SHA512 verified) |
| `/x` | Panic route (instant session clear → redirect to `/?p=1`) |
| `/.well-known/security.txt` | Security disclosure |
| `/.well-known/apple-developer-merchantid-domain-association` | Apple Pay merchant verification |
| `/robots.txt` | Crawler policy |
| `/healthz` | Health check (Worker-only, not in assets) |

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [COMMERCIAL.md](COMMERCIAL.md)

## Licence

[AGPL-3.0](LICENSE). Commercial licences available — see [COMMERCIAL.md](COMMERCIAL.md).
