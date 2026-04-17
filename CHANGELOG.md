# Changelog

All notable changes to sTELgano are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
sTELgano uses [Semantic Versioning](https://semver.org/).

Breaking changes to the sTELgano-std-1 protocol are noted explicitly — a
breaking protocol change increments the major version and requires a migration.

---

## [Unreleased]

### Added
- Initial implementation of sTELgano-std-1 protocol
- Room creation and access control with brute-force lockout (10 attempts, 30-minute lockout)
- N=1 atomic messaging invariant enforced at database transaction level
- AES-256-GCM client-side encryption via Web Crypto API (zero external libraries)
- PBKDF2-HMAC-SHA256 key derivation at 600,000 iterations (OWASP 2023 recommendation)
- Steg number generator: cryptographically random E.164 numbers via `phone-number-generator-js` with 19 curated countries
- Phoenix Channel real-time: send, read receipts, edit before read, delete before read, typing indicator
- Lock screen with PIN re-entry (re-derives encryption key without re-joining channel)
- Multi-device access: deterministic key derivation across devices
- Room TTL support with optional `ttl_expires_at` and automated expiry via Oban
- Room expiry with atomic message deletion
- Public pages: homepage, `/security` (full crypto spec), `/privacy`, `/terms`, `/about`
- `/spec` — sTELgano-std-1 protocol specification page
- `/blog` — blog section with index and slug-based article routing
- `/steg-number` generator page with clipboard copy and room availability check
- `/x` — panic route for instant session clear
- Admin dashboard at `/admin` with HTTP Basic Auth and aggregate metrics (active chats, new today, messages today, total 90 days)
- Service worker with privacy-first caching (network-only for `/chat`, `/steg-number`, `/admin`)
- Rate limiting via PlugAttack (30 WebSocket upgrades/min, 200 HTTP requests/min per IP)
- Security headers: CSP, HSTS, X-Frame-Options, CORP/COEP/COOP, Permissions-Policy
- Oban background job for hourly TTL room expiry (`ExpireTtlRooms`)
- AGPL-3.0 licence
- Docker multi-stage build
- CI/CD via GitHub Actions (quality gates + deploy)
- CONTRIBUTING.md, SECURITY.md, COMMERCIAL.md, CODE_OF_CONDUCT.md, AGENTS.md, CLAUDE.md

- Configurable monetization system with blind token payment protocol
- `Stelgano.Monetization` module — config, token lifecycle, and privacy-preserving redemption
- `Stelgano.Monetization.PaymentProvider` behaviour — pluggable payment gateway interface
- Paystack payment provider adapter (`Stelgano.Monetization.Providers.Paystack`)
- `extension_tokens` table — **no room_id column** (privacy by structural design)
- Room `tier` field (`free`/`paid`) with conditional TTL on room creation
- `redeem_extension` channel event for blind token redemption after payment
- Payment callback page at `/payment/callback`
- Paystack webhook controller at `/api/webhooks/paystack` with HMAC-SHA512 signature verification
- `ExpireUnredeemedTokens` Oban job — daily cleanup of stale payment tokens
- Payment initiation UI on `/steg-number` page (conditional on monetization enabled)
- Client-side `generateExtensionToken()` in `anon.js` for random secret + SHA-256 hash generation
- Auto-redemption in `chat.js` — redeems extension token on channel join if present in sessionStorage
- `PaymentInitiator` JS hook for steg number page
- TTL expiry warning bar in chat UI (2-day warning, 12-hour critical)
- New channel detection — prompts plan selection when user enters a number that creates a new room
- Re-enabled manual phone entry in chat for returning to existing channels
- Raw body reader plug for webhook signature verification

### Changed
- Replaced Heroicons with Lucide Icons (`lucide_icons` Elixir package)
- Removed theme toggle — dark-only design (glassmorphism is inherently dark-first)
- Switched message deletion from soft-delete (`deleted_at` column) to immediate hard-delete for N=1 invariant
- Removed `deleted_at` column from messages table (migration `20260416000001`)
- Updated UI copy throughout to use "steg number" terminology consistently
- Improved code quality: added type specs, fixed Credo linting issues, refactored pipe chains

---

## Version policy

| Increment | Meaning |
|-----------|---------|
| **Major** (X.0.0) | Breaking change to sTELgano-std-1 protocol (existing rooms inaccessible) |
| **Minor** (0.X.0) | New features, backwards-compatible |
| **Patch** (0.0.X) | Bug fixes, security patches, no behaviour change |

Protocol version is tracked separately in `assets/js/crypto/anon.js` via the
salt constants (e.g. `stelegano-room-v1-2026`). A protocol version bump always
accompanies a major application version bump.
