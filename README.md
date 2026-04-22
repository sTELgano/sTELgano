# sTELgano

**The messaging app hidden in your contacts.**

`sTELgano` — pronounced **stel-GAH-no**. A portmanteau of **stegano**graphy and **TEL**, the contact layer it hides inside.

sTELgano is a privacy-focused anonymous messaging app and open protocol. It protects you from the people in your life — a partner who picks up your phone, a family member with device access. Not from governments. We say this clearly, because honesty is the product.

Two people share a phone number saved in their contacts. Each picks their own PIN. No account. No history. One message at a time.

[![AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-green.svg)](LICENSE)
[![Elixir](https://img.shields.io/badge/elixir-~>%201.15-purple.svg)](https://elixir-lang.org)
[![Phoenix](https://img.shields.io/badge/phoenix-1.8-orange.svg)](https://phoenixframework.org)
[![sTELgano-std-1](https://img.shields.io/badge/protocol-sTELgano--std--1-10B981.svg)](https://stelgano.com/spec)

---

## How it works

1. **Generate a steg number** — pick a country destination and generate a random international phone number. You can use the dedicated `/steg-number` page or the integrated one-click generator within the `/chat` interface. All numbers are strictly formatted in E.164 (e.g. `+1212...`).
2. **Choose your own PIN** — never shared with anyone. The PIN never leaves your device.
3. **Open the channel** — enter your secret number and PIN. The interface automatically infers the country context and enforces international formatting. Your browser derives all keys locally via the Web Crypto API. The server sees only hashes and ciphertext.

### The N=1 invariant

At most one message exists on the server at any moment. When you reply, the previous message is permanently deleted in an atomic database transaction. No history. Anywhere.

### What the server stores vs. never stores

| Stores | Never stores |
|--------|-------------|
| SHA-256(phone + salt) — not reversible | Phone number |
| SHA-256(phone + PIN + salt) — not reversible | PIN |
| AES-256-GCM ciphertext | Encryption key |
| Anonymous sender identifier | Message plaintext |

---

## Cryptographic specification

Canonical implementation: [`assets/js/crypto/anon.js`](assets/js/crypto/anon.js)

```
room_hash   = SHA-256(normalise(phone) + ":" + ROOM_SALT)
access_hash = SHA-256(normalise(phone) + ":" + PIN + ":" + ACCESS_SALT)
enc_key     = PBKDF2(password: phone, salt: room_id + ENC_SALT,
                     iterations: 600_000, hash: SHA-256, keylen: 256 bits)
```

Encryption: AES-256-GCM, 96-bit random nonce per message, 128-bit auth tag.
600,000 PBKDF2 iterations — OWASP 2023 recommendation. Zero external libraries.

---

## Features

- **N=1 messaging** — at most one message per room, enforced atomically
- **Client-side crypto** — AES-256-GCM, PBKDF2 at 600k iterations, Web Crypto API only
- **Real-time** — Phoenix Channels for send, read receipts, edit/delete before read, typing indicators
- **Lock screen** — PIN re-entry to resume, session clear for panic situations
- **History Masking** — forces the browser history to only log the root path (`/`), leaving no trace of sensitive sub-pages
- **Vault Isolation** — uses non-standard field attributes to discourage browser password managers from saving credentials
- **Incognito Recommended** — integrated guidance to use private browsing for zero-trace local forensics
- **Panic route** — `GET /x` instantly clears all session data
- **Steg number generator** — integrated one-click generator drawer and dedicated `/steg-number` page; 19 curated countries, strict E.164 international formatting with real-time country inference.
- **Admin dashboard** — aggregate metrics at `/admin` (HTTP Basic Auth)
- **Privacy-preserving telemetry** — lifetime per-country counters + daily global counters; no per-room country metadata, no third-party analytics
- **Blog** — technical articles at `/blog`
- **Protocol spec** — sTELgano-std-1 specification at `/spec`
- **Pure web app** — no PWA, no service worker, no installable icon (see the passcode test rationale in the blog)
- **Self-hosted fonts** — Inter / Outfit / JetBrains Mono ship from `priv/static/fonts/`; no Google Fonts CDN pings
- **Nonce-based CSP** — `script-src` carries a per-request nonce rather than `'unsafe-inline'`
- **Rate limiting** — IP-based via PlugAttack, tighter limit for `/admin`
- **Security headers** — CSP, HSTS, CORP/COEP/COOP, no external scripts
- **Configurable monetization** — optional paid tier for extended steg number TTL, pluggable payment providers (Paystack ships built-in, bring your own Stripe/Flutterwave/etc.)
- **Privacy-preserving payments** — blind token protocol ensures the server cannot link a payment to a specific room

---

## Monetization (optional)

Monetization is fully optional and disabled by default. Self-hosters can run sTELgano without monetization — all rooms get unlimited TTL.

When enabled, steg numbers have a configurable free TTL (default 7 days). Users can purchase a dedicated number for 1 year via the steg number generator page. The payment flow uses a **blind token** design: the `extension_tokens` table has no `room_id` column, so the server cannot link a payment to a specific room.

Payment providers are pluggable via a behaviour (`Stelgano.Monetization.PaymentProvider`). Paystack ships built-in; implement the behaviour for Stripe, Flutterwave, M-Pesa, or any other gateway.

```elixir
# Self-hosted, no monetization (default)
config :stelgano, Stelgano.Monetization, enabled: false

# Production with Paystack
config :stelgano, Stelgano.Monetization,
  enabled: true,
  provider: Stelgano.Monetization.Providers.Paystack,
  free_ttl_days: 7,
  paid_ttl_days: 365,
  price_cents: 200,
  currency: "USD"
```

**Display-vs-settlement currency.** `PAYMENT_CURRENCY` is what the UI shows and what `PRICE_CENTS` is denominated in. When the Paystack merchant account only accepts a different currency, set `PAYSTACK_SETTLEMENT_CURRENCY` (e.g. `KES`) and the adapter converts the amount at payment-initialize time via `Stelgano.Monetization.FxRate` — an in-memory GenServer that fetches a single `base→quote` rate from Fawazahmed0's public currency-api CDN on boot and refreshes every 24h. A configurable buffer (`PAYSTACK_FX_BUFFER_PCT`, default 5%) absorbs FX drift, and `PAYMENT_FX_FALLBACK_RATE` seeds the cache so the first payment works even if the rate API is down. Settlement-currency config lives on the Paystack adapter — future Stripe/Flutterwave adapters own their own story (or don't need one).

---

## Self-hosting

```bash
git clone https://github.com/sTELgano/sTELgano
cd stelgano
mix setup        # deps + DB + migrations + assets
mix phx.server   # → http://localhost:4000
```

**Required environment variables (production):**

| Variable | Description |
|----------|-------------|
| `PHX_SERVER` | Set to `true` so the release binds the HTTP endpoint on boot |
| `SECRET_KEY_BASE` | Phoenix session signing (`mix phx.gen.secret`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PHX_HOST` | Production hostname |
| `ADMIN_PASSWORD` | Admin dashboard password |
| `MONETIZATION_ENABLED` | Set to `true` to enable paid tiers |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (required if monetization enabled) |
| `PAYSTACK_PUBLIC_KEY` | Paystack public key (required if monetization enabled) |
| `PAYSTACK_CALLBACK_URL` | Post-payment redirect URL (e.g. `https://stelgano.com/payment/callback`) |
| `PAYSTACK_RECEIPT_EMAIL_DOMAIN` | **Domain you control** — used as the `@domain` of the anonymous placeholder email we send to Paystack on initialize. Paystack mails receipts to this address; if the domain isn't yours, a third party receives them. Typically your `PHX_HOST`. Required when monetization is enabled. |

Optional: `PORT` (default 4000), `POOL_SIZE` (default 10), `ADMIN_USERNAME` (default `admin`), salt overrides (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`), monetization tuning (`FREE_TTL_DAYS`, `PAID_TTL_DAYS`, `PRICE_CENTS`, `PAYMENT_CURRENCY`), settlement-currency conversion (`PAYSTACK_SETTLEMENT_CURRENCY`, `PAYSTACK_FX_BUFFER_PCT`, `PAYMENT_FX_FALLBACK_RATE`). See [.env.example](.env.example) for the full reference.

### Deployment (droplet + systemd)

The repo ships a reference deployment pipeline for a plain DigitalOcean droplet (or any SSH-reachable Linux host):

- [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — GitHub Actions workflow that builds a release with `mix release`, tarballs it, scp's the tarball to your server, runs `Stelgano.Release.migrate()`, and bounces the systemd unit.
- [deploy/stelgano.service](deploy/stelgano.service) — systemd unit template. Copy to `/etc/systemd/system/stelgano.service` on the droplet; reads env from `/opt/stelgano/.env` (use [.env.example](.env.example) as the template).

Required GitHub Actions secrets: `DO_HOST`, `DO_USERNAME`, `DO_SSH_KEY` (`DO_SSH_PORT` optional, defaults to 22). On the droplet, give the deploy user passwordless sudo for `systemctl {start,stop,is-active} stelgano` and `journalctl -u stelgano`. Front the app with nginx or Caddy on `:443` proxying to `127.0.0.1:4000`.

---

## Development

```bash
mix setup              # deps + DB create/migrate + seed + assets
mix phx.server         # dev server at http://localhost:4000
mix test               # run all tests
mix precommit          # compile (warnings-as-errors) + unlock unused deps + format + credo --strict + test
mix credo --strict     # static analysis
mix dialyzer           # type checking
mix sobelow --config   # Phoenix security scanning
```

---

## Routes

| Path | Description |
|------|-------------|
| `/` | Homepage |
| `/chat` | Anonymous chat (no URL params; phone handoff via sessionStorage) |
| `/steg-number` | Steg number generator |
| `/spec` | Protocol specification |
| `/blog` | Blog index |
| `/security`, `/privacy`, `/terms`, `/about` | Static pages |
| `/admin` | Admin dashboard (HTTP Basic Auth) |
| `/payment/callback` | Post-payment redirect (monetization) |
| `/api/webhooks/paystack` | Paystack webhook endpoint |
| `/x` | Panic route (instant session clear) |

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [COMMERCIAL.md](COMMERCIAL.md)

## Licence

[AGPL-3.0](LICENSE). Commercial licences available — see [COMMERCIAL.md](COMMERCIAL.md).
