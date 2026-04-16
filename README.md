# sTELgano

**Hidden in the contact layer.**

sTELgano is a privacy-focused anonymous messaging app and open protocol. It protects you from the people in your life — a partner who picks up your phone, a family member with device access. Not from governments. We say this clearly, because honesty is the product.

Two people share a phone number saved in their contacts. Each picks their own PIN. No account. No history. One message at a time.

[![AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-green.svg)](LICENSE)
[![Elixir](https://img.shields.io/badge/elixir-~>%201.15-purple.svg)](https://elixir-lang.org)
[![Phoenix](https://img.shields.io/badge/phoenix-1.8-orange.svg)](https://phoenixframework.org)
[![sTELgano-std-1](https://img.shields.io/badge/protocol-sTELgano--std--1-10B981.svg)](https://stelgano.com/spec)

---

## How it works

1. **Generate a steg number** — pick a country, generate a random international phone number at `/steg-number`. The number is copied to your clipboard. Save it in the other person's contacts alongside their real number. It looks like every other number.
2. **Choose your own PIN** — never shared with anyone. The PIN never leaves your device.
3. **Open the channel** — click "Open channel" and enter your PIN. Your browser derives all keys locally via the Web Crypto API. The server sees only hashes and ciphertext.

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
- **Panic route** — `GET /x` instantly clears all session data
- **Steg number generator** — 19 curated countries, E.164 format, clipboard copy
- **Admin dashboard** — aggregate metrics at `/admin` (HTTP Basic Auth)
- **Blog** — technical articles at `/blog`
- **Protocol spec** — sTELgano-std-1 specification at `/spec`
- **Service worker** — privacy-first caching (network-only for sensitive routes)
- **Rate limiting** — IP-based via PlugAttack
- **Security headers** — CSP, HSTS, CORP/COEP/COOP, no external scripts

---

## Self-hosting

```bash
git clone https://github.com/stelgano/stelgano
cd stelgano
mix setup        # deps + DB + migrations + assets
mix phx.server   # → http://localhost:4000
```

**Required environment variables (production):**

| Variable | Description |
|----------|-------------|
| `SECRET_KEY_BASE` | Phoenix session signing (`mix phx.gen.secret`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PHX_HOST` | Production hostname |
| `ADMIN_PASSWORD` | Admin dashboard password |

Optional salt overrides for self-hosters: `ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`.

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
| `/chat` | Anonymous chat (accepts `?phone=<e164>`) |
| `/steg-number` | Steg number generator |
| `/spec` | Protocol specification |
| `/blog` | Blog index |
| `/security`, `/privacy`, `/terms`, `/about` | Static pages |
| `/admin` | Admin dashboard (HTTP Basic Auth) |
| `/x` | Panic route (instant session clear) |

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [COMMERCIAL.md](COMMERCIAL.md)

## Licence

[AGPL-3.0](LICENSE). Commercial licences available — see [COMMERCIAL.md](COMMERCIAL.md).
