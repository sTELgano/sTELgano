# Changelog

All notable changes to sTELgano are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
sTELgano uses [Semantic Versioning](https://semver.org/).

Breaking changes to the sTELgano-std-1 protocol are noted explicitly — a
breaking protocol change increments the major version and requires a migration.

---

## [Unreleased]

### Added (v2 — Cloudflare Workers, `staging` branch)

- **Cloudflare Analytics Engine** — replaces D1 `country_metrics` / `daily_metrics` UPSERT tables with fire-and-forget `writeDataPoint()` calls; no row locking, scales to concurrent bursts. Events: `room_free`, `room_paid`, `room_expired_free`, `room_expired_paid`, `message_sent`. Country ISO code in `blob2`, never co-located with any `room_hash`.
- **Admin dashboard AE reads** — `queryCountryMetrics()` and `queryDailyMetrics()` in `src/lib/analytics.ts` query the CF GraphQL API using `CF_ACCOUNT_ID` (var) and `CF_AE_API_TOKEN` (secret); both return `[]` gracefully when credentials are absent.
- **Room creation rate limiting** — `RATE_LIMITER_ROOM_CREATE` CF native rate-limiter binding (3/IP/min) checked inside `RoomDO.handleJoin()` on first join only; fail-open; client IP forwarded from Worker via `X-Client-IP` header.
- **`wrangler.test.toml`** — separate test config omitting `[[analytics_engine_datasets]]` to sidestep an esbuild deadlock in wrangler 3.x's mock-AE middleware.

### Changed (v2 — Cloudflare Workers, `staging` branch)

- D1 migrations 0002 (`country_metrics`) and 0003 (`daily_metrics`) deleted; replaced by Analytics Engine.
- `RATE_LIMITER_ROOM_CREATE` period corrected from invalid `3600` to `60` (CF Workers Rate Limiting only supports `period: 10 | 60`).
- Test pool now references `wrangler.test.toml`; test rate limiter uses `limit = 9999` to prevent false hits.

### Removed (v2 — Cloudflare Workers, `staging` branch)

- `src/lib/country_metrics.ts`, `src/lib/daily_metrics.ts` — replaced by `src/lib/analytics.ts`.
- `test/worker/country_metrics.test.ts`, `test/worker/daily_metrics.test.ts` — tests for deleted modules.

---

### Added (v1 — Phoenix/Elixir, `main` branch)
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
- `Stelgano.Monetization.FxRate` — in-memory GenServer caching one `base→quote` exchange rate, refreshed every 24h from Fawazahmed0's keyless public currency-api CDN. Started conditionally via `Paystack.child_specs/0` only when `PAYSTACK_SETTLEMENT_CURRENCY` differs from `PAYMENT_CURRENCY`.
- Paystack settlement-currency conversion: UI keeps showing `PAYMENT_CURRENCY` (e.g. USD) while the adapter converts amounts to `PAYSTACK_SETTLEMENT_CURRENCY` (e.g. KES) at payment-initialize time, with a `PAYSTACK_FX_BUFFER_PCT` (default 5%) buffer to absorb FX drift and a `PAYMENT_FX_FALLBACK_RATE` seed for cold-start resilience.

### Changed
- Replaced Heroicons with Lucide Icons (`lucide_icons` Elixir package)
- Removed theme toggle — dark-only design (glassmorphism is inherently dark-first)
- Switched message deletion from soft-delete (`deleted_at` column) to immediate hard-delete for N=1 invariant
- Removed `deleted_at` column from messages table (migration `20260416000001`)
- Updated UI copy throughout to use "steg number" terminology consistently
- Improved code quality: added type specs, fixed Credo linting issues, refactored pipe chains
- `Rooms.join_room/2` no longer auto-creates the `Room` row. Room creation is now an explicit step via `Rooms.create_room/3`, invoked from the plan-selection flow in `ChatLive.handle_event("continue_free", ...)`. Removes a resource-exhaustion surface where any client probing arbitrary `room_hash` values would pollute the `rooms` table. `find_or_create_room/1` is replaced by `get_active_room/1` (read-only) + `create_room/3` (explicit insert).
- `AnonRoomChannel.join/3` now validates all hex64 inputs (room_hash, sender_hash) **before** touching the DB. Previously, a malformed `sender_hash` on a non-existent room would leak `:not_found` instead of `:invalid_sender`; the reordered validator surfaces `:invalid_sender` without any DB work.

### Security
- Paystack's `/transaction/initialize` now uses a placeholder email derived from the token_hash, with the `@domain` part sourced from a new required env var `PAYSTACK_RECEIPT_EMAIL_DOMAIN`. Previously, the domain was hardcoded to `stelgano.com` — any operator who didn't own that domain would have had their payment receipts delivered to whoever did. The env var must be set to a domain the operator controls (typically `PHX_HOST`); `runtime.exs` raises on boot if monetization is enabled without it.
- `ChatLive.handle_event/3` clauses for `continue_free`, `choose_paid`, and `go_to_upgrade` now carry pattern-matched state guards (`:new_channel` / `:chat`) with catch-all fallbacks. Stray client events from other states are ignored instead of crashing on missing assigns or echoing data from the wrong flow.
- `ChatLive.handle_event("prefill_phone", …)` and `StegNumberLive.handle_event("restore_number", …)` now validate the handoff phone length (`byte_size <= 32`) and whitelist the handoff tier to `"free" | "paid" | nil`. Values arrive from client-controlled `sessionStorage` and were previously stored and echoed back unchecked.

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
