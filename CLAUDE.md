# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

sTELgano is a privacy-focused anonymous messaging app and open protocol (sTELgano-std-1) built on **Cloudflare Workers + Durable Objects**, written in TypeScript. It implements *contact-layer steganography* — two people share a "steg number" (a random phone number saved in each other's contacts) and each picks a PIN. All cryptography happens client-side via the Web Crypto API. The server only sees SHA-256 hashes and AES-256-GCM ciphertext.

**Core invariant (N=1):** At most one message exists per room at any time. Replies atomically delete the previous message. No history exists anywhere.

**Threat model:** Protects against intimate-access attackers (partner, family member with device access). Explicitly does NOT protect against governments or law enforcement. This honesty is stated throughout the product.

**Passcode test:** Every design decision must pass: "A suspicious partner unlocks your phone and opens sTELgano. What do they see?" Answer: a blank entry screen with two fields. Nothing else.

**v1 note:** A prior Elixir/Phoenix implementation existed and is referenced in comments and the migration blog post. It has been removed from the repository. This codebase (Workers v2) is the only active implementation.

## Common commands

```bash
npm run dev            # wrangler dev → http://localhost:8787
npm run build          # compile all client assets to public/
npm run typecheck      # tsc --noEmit
npm run precommit      # typecheck + biome check + test (run before pushing)
npm test               # vitest run (both pure-function and worker-runtime suites)
npm run test:watch     # vitest watch mode
npm run lint           # Biome linter
npm run check          # Biome lint + format check
npm run check:fix      # Biome check with auto-fix
npm run types          # npx wrangler types (regenerate worker-configuration.d.ts)
npm run d1:migrate:local   # wrangler d1 migrations apply stelgano --local
npm run d1:migrate:remote  # wrangler d1 migrations apply stelgano --remote
```

## Architecture

### Worker entry point: `_worker.ts`

Routes all requests through a single `fetch()` handler. Responsibilities:
- Applies security headers (CSP with per-request nonce, HSTS, X-Frame-Options, X-Robots-Tag) to every response including static assets (`run_worker_first = true` in `wrangler.toml`)
- Rate-limits `/admin` (20/IP/min) and WebSocket upgrades (30/IP/min) via native CF rate limiter bindings
- Serves the admin dashboard and all JSON API routes (`/api/payment/initiate`, `/api/room/:hash/exists`, `/api/webhooks/paystack`)
- Upgrades WebSocket connections and forwards them to the correct `RoomDO` instance via `stub.fetch()`, injecting `X-Client-IP` for per-IP rate limiting inside the DO
- Runs the daily Cron Trigger (`0 3 * * *`): sweeps expired extension tokens from D1
- Runs the `queue()` consumer for `METRICS_QUEUE`: coalesces each batch and applies it as one transactional `db.batch()` UPSERT into `daily_metrics` (the sole analytics writer)

### Durable Object: `src/room.ts` — `RoomDO`

One instance per `room_hash`. Single-threaded execution enforces the N=1 invariant by construction (no locks needed). Hibernatable WebSockets keep idle rooms cheap.

**Persisted state** (one storage key per room, SQLite-backed):
- `isInitialized` — true after first join
- `roomId` — random UUID used as PBKDF2 salt for the shared enc key; independent from DO id scheme
- `tier` — `"free"` | `"paid"`
- `ttlExpiresAtMs` — epoch ms; DO alarm fires here and self-destructs the room
- `accessRecords` — up to 2 entries (one per party), each with `accessHash`, `failedAttempts`, `lockedUntilMs`
- `currentMessage` — N=1; at most one `StoredMessage` at any time

**Join flow:**
1. First join initialises the room (rate-limited by `RATE_LIMITER_ROOM_CREATE`, 3/IP/min). **Every number starts `"free"` (weekly TTL)** — any `extension_secret` in the join payload is ignored at creation. A paid (yearly) number is reached only via the `redeem_extension` event the client sends right after joining; that single path (with its proactive Paystack verification) handles both brand-new paid numbers and extensions, so the server never races the webhook at creation time.
2. Second-party slot registration is also rate-limited by `RATE_LIMITER_ROOM_CREATE` to prevent slot exhaustion attacks.
3. Subsequent joins check `accessHash` against stored records; 10 failed attempts → 30-min lockout.

**Events handled:** `join`, `send_message`, `read_receipt`, `edit_message`, `delete_message`, `typing`, `expire_room`, `redeem_extension`

**Timing floor:** `JOIN_TIME_FLOOR_MS = 500` — every join reply is padded to at least 500 ms with jitter so reply timing cannot classify `room_hash` values as existing vs. non-existing.

### Protocol constants: `src/protocol.ts`

Single source of truth for all values shared between the Worker and the client WebSocket protocol: event type unions, `HEX64_RE`, `MAX_CIPHERTEXT_BYTES` (8 192), `MAX_ACCESS_ATTEMPTS` (10), `LOCKOUT_MINUTES` (30), `JOIN_TIME_FLOOR_MS` (500), `FREE_TTL_DAYS`, `PAID_TTL_DAYS`.

### Client-side state machine: `src/client/state.ts`

`ChatState` drives the entire browser-side UI as a pure TypeScript state machine. States:

```
entry → deriving → [new_channel?] → connecting → chat
                                              ↓
                                           locked
                                           expired (terminal)
```

- `entry` — phone + PIN form. Phone is read-only when a steg number was just generated (generator drawer) or when returning from Paystack checkout (`stelegano_handoff_phone` in sessionStorage). Manual entries remain editable.
- `deriving` — three-dot loading while `room_hash`, `access_hash`, `sender_hash` are computed; hits `/api/room/:hash/exists` to decide whether to show `new_channel`.
- `new_channel` — plan selection (free/paid) when monetization is enabled and the room doesn't exist yet. No DO has been created at this point — the room is created on join, not before.
- `connecting` — PBKDF2 key derivation (600 000 iterations, runs in a dedicated Web Worker to keep the UI responsive)
- `chat` — active chat; turn-based input (can type when room is empty or last message is from the other party)
- `locked` — PIN re-entry after auto-lock; re-derives the key without re-joining the WebSocket
- `expired` — terminal; room was destroyed server-side

### Client-side crypto: `src/client/crypto/anon.ts`

**Single source of truth** for all cryptographic constants and operations. Zero external libraries. Changing any constant is a breaking change (all existing rooms become inaccessible).

```
room_hash   = SHA-256(normalise(phone) + ":" + ROOM_SALT)
access_hash = SHA-256(normalise(phone) + ":" + PIN + ":" + ACCESS_SALT)
enc_key     = PBKDF2(password: phone, salt: room_id + ENC_SALT,
                     iterations: 600_000, hash: SHA-256, keylen: 256 bits)
sender_hash = SHA-256(normalise(phone) + ":" + access_hash + ":" + room_hash + ":" + SENDER_SALT)
```

PIN is NOT part of enc_key (both users need the same key but have different PINs). The access_hash IS part of sender_hash so two users with the same phone but different PINs produce different sender identities.

**PBKDF2 runs in a dedicated Web Worker** (`src/client/workers/pbkdf2.ts` → `public/assets/pbkdf2_worker.js`) to keep the UI responsive during the 600 000-iteration derivation.

`phone-number-generator-js` npm package — steg number generator (E.164 format, 227 countries). The generator is an integrated drawer inside `/chat` (no separate page).

### UI renderer: `src/client/chat.ts`

Renders the entire chat UI from `ChatState`. Uses surgical DOM updates (`diffChildren` / `entriesMatch`) to avoid re-rendering unchanged sections. Key sub-components:

- Generator drawer — slide-in panel with country selector + number generator. `id="generator-panel-container"` and `id="generator-apply-footer"` updated independently.
- Entry form — phone + PIN fields, eye-icon visibility toggle, tier selection
- Chat surface — message bubbles, input textarea, header controls (extend, lock, expire)
- Lock overlay — renders over chat on `locked` state without destroying the chat DOM

### WebSocket client: `src/client/room_client.ts`

Manages the WebSocket connection lifecycle: connect, send typed events, handle server replies and broadcasts. Implements client-side ref tracking (request/reply correlation).

### Telemetry: `src/lib/daily_metrics.ts` (D1, queued aggregator)

Analytics live entirely in D1 — exact and permanent (no sampling, no 90-day cap). Analytics Engine has been removed. The chat hot path never touches the database: handlers call `enqueueMetric()` / `enqueueMetrics()` (fire-and-forget, fail-open) which `send()` to the `METRICS_QUEUE` Cloudflare Queue. The `queue()` consumer in `_worker.ts` is the **only writer** — it coalesces each batch in memory by composite key (`coalesce()`) and applies it in one transactional `db.batch()` UPSERT (`flushMetricBatch()`). D1 write rate is therefore batches/sec, not events/sec.

**Storage** — `daily_metrics` table (migration `0006`), one row per `(day × metric × steg_country × cf_country × dim)`:
- `day` — `YYYY-MM-DD` UTC, bucketed from each event's emit `ts` (the timestamp is used only to choose the day, then discarded)
- `metric` — a `MetricKey`:
  - **lifecycle** (free = weekly TTL, paid = yearly TTL): `room_free`, `room_paid`, `room_extended`, `room_rejoin`, `room_expired_free`, `room_expired_paid`, `room_expired_empty` (never messaged), `room_expired_solo` (never got a 2nd party), `room_lifespan` (dim = bucket), `cohort_active` (dim = `<creation-week Monday>+<offset weeks>`; emitted by the DO once per channel per ISO week — feeds the admin retention-cohort triangle and Weekly Active Channels, an aggregate-only WAU analog)
  - **engagement**: `message_sent`, `message_edited`, `message_deleted`, `message_read`, `second_party_joined`, `time_to_first_message` (dim = bucket), `activity_hour` (dim = UTC hour `00`–`23`, global — intra-day activity)
  - **monetization**: `extension` (dim = ordinal `x1`,`x2`,…`x10+` — the Nth paid extension of a number, tracked in DO state never by hash), `paid_sale` (dim = price label e.g. `USD_200`, `sum_value` = revenue in minor units), `time_to_paid` (`sum_value` = hours, dim = bucket — free→paid conversion latency), `payment_initiated` / `payment_paid` (dim = price label — server-side payment funnel), `redeem_failed` (dim = reason)
  - **acquisition**: `page_view` (dim = normalized route), `referrer` (dim = `search`|`social`|`other`|`direct`; internal navigation not counted)
  - **security/abuse/reliability**: `access_failed`, `access_lockout`, `join_rate_limited` (dim = `create`|`slot`), `ws_rate_limited`, `admin_rate_limited`, `cron_sweep` (count = cron runs, `sum_value` = tokens swept)
  - **funnel**: one `funnel_<step>` per `FunnelStep` (dim = campaign slug)

Active-room counts are split by tier in `live_counters` (`free_active` / `paid_active`, migration `0007`): the DO increments by tier at creation, moves free→paid on conversion, and decrements the right tier at expiry — so the dashboard shows live weekly vs. yearly numbers, not just a total.
- `steg_country` / `cf_country` — ISO-3166 alpha-2 (client-derived steg country / server-side CF-IPCountry), or `""`
- `dim` — extra dimension: campaign slug for `funnel_*`, a coarse distribution bucket for `room_lifespan` / `time_to_first_message`, else `""`
- `count` — event count; `sum_value` — summed numeric (seconds/hours) for distributions, so `avg = sum_value / count`

**Admin dashboard reads** (`_worker.ts`): `queryTotals`, `queryDailyTrend`, `queryCountryRange`, `queryCfCountryRange`, `queryDiasporaRange`, `queryHistogram`, `queryFunnelRange`, `queryPricing`, `queryRevenueByCountry` — all parameterized (`.bind()`, never string-interpolated) and date-range driven (`parseDateRange`, default last 30 days, span clamped ≤366). The sidebar dashboard has Overview / Geography / Engagement / **Monetization** (sales, revenue, payment funnel, extension-depth, sales-by-price, revenue-by-country) / Funnel & Campaigns / Security sections. Charts are server-rendered inline SVG (`src/lib/charts.ts`), CSP-safe (no JS). Distribution metrics carry a bucket in `dim`, giving histograms **and** averages from one row family.

*Expiry and security metrics are intentionally global (no country dimension)* — room records never carry a country code, to preserve server-blindness. The queue is at-least-once; a redelivered acked batch can over-count rarely and slightly — negligible for analytics, far better than sampling. Queue outage is fail-open (a dropped metric never blocks a chat event).

**Capacity & swappable backend.** The dimensions are bounded (≤19 metrics × sparse country pairs × ~16 buckets / operator campaigns), so at realistic cardinality the table grows ~0.5–2 GB/yr — years of headroom under D1's 10 GB cap, with daily grain kept forever (no downsampling). Per-country sharding was rejected: it breaks cross-country/diaspora aggregation, D1 location is region-level (not per-country) so it gives no residency benefit for anonymized aggregates, and a skewed key leaves one hot shard still near the cap. If the table ever approaches the limit, the **producer → queue → consumer seam makes the backend swappable**: only two things change — the `queue()` consumer's write target (POST the coalesced batch to a columnar store like Tinybird/ClickHouse instead of `db.batch()`) and the dashboard read helpers (query that store instead of D1). The DO instrumentation, queue, metric catalog, and the anonymized aggregate schema stay identical. Columnar compression (~20–50× on this shape) makes 10 GB hold the equivalent of hundreds of GB. Whatever the backend, keep sending **only aggregates** — never per-event rows with timestamps (that reintroduces a re-identification trail).

### Monetization: `src/lib/extension_tokens.ts` + `src/lib/paystack.ts`

Fully optional (disabled by default). When enabled, steg numbers have a free TTL (default 7 days). Users can purchase a dedicated number (default 1 year) via a **blind token** protocol.

**Privacy guarantee:** The `extension_tokens` D1 table has **no `room_id` column**. The server cannot link a payment to a specific room. Correlation exists only ephemerally in memory during the `redeem_extension` event; the token row is deleted immediately after successful redemption.

**Payment flow:**
1. Client generates random `extension_secret`, computes `token_hash = SHA-256(secret)`
2. `POST /api/payment/initiate` creates a pending token in D1, calls Paystack `/transaction/initialize`
3. Paystack webhook (`POST /api/webhooks/paystack`, HMAC-SHA512 verified) marks token `paid`
4. Client sends `extension_secret` via WebSocket `redeem_extension` event
5. Server hashes it, finds matching paid token, extends room TTL; token row deleted immediately

**Token lifecycle:** `pending` → `paid` → deleted-on-redemption. Daily cron at 03:00 UTC sweeps any tokens whose `expires_at` has passed (30-day window matches v1).

**Paystack placeholder email:** `anonymous+<token_hash[0..7]>@<PAYSTACK_RECEIPT_EMAIL_DOMAIN>`. Domain must be operator-controlled (no MX record — receipts bounce).

**Currency:** Charges are submitted to Paystack in `PAYMENT_CURRENCY` (default `USD`). Any conversion to the operator's payout currency is handled by Paystack at settlement — the Worker performs no FX.

### Security

- **Security headers** — applied in `_worker.ts` to every response including static assets: CSP (per-request nonce, `default-src 'self'`, no `'unsafe-inline'` for scripts), HSTS, X-Frame-Options, X-Robots-Tag, Cache-Control: no-store.
- **CSP nonce** — generated per-request in the Worker, injected into HTML at serve time. The only inline script (panic-flag bootstrap) carries this nonce.
- **Rate limiting** — three native CF rate-limiter bindings (`[[unsafe.bindings]]` in `wrangler.toml`):
  - `RATE_LIMITER_ADMIN` — 20/IP/min on `/admin`
  - `RATE_LIMITER_WS` — 30/IP/min on WebSocket upgrade requests
  - `RATE_LIMITER_ROOM_CREATE` — 3/IP/min inside RoomDO on new-room creation AND second-slot registration. IP forwarded via `X-Client-IP` header. Fail-open (CF outage never blocks traffic).
- **Admin auth** — HTTP Basic Auth enforced by the Worker before serving `/admin`.
- **Panic route** — `GET /x` clears all sessionStorage and redirects to `/?p=1`. The bootstrap inline script detects `?p=1`, calls `sessionStorage.clear()`, and strips the flag from the URL via `history.replaceState`.

### Routes

- `/` — homepage; `/security`, `/privacy`, `/terms`, `/about` — static pages
- `/spec` — sTELgano-std-1 protocol specification
- `/blog` — blog index; `/blog/:slug` — individual blog posts
- `/chat` — anonymous chat. No URL parameters accepted. The steg number generator lives inside this page as a slide-in drawer. Phone may be pre-populated only via the `stelegano_handoff_phone` sessionStorage key (set by the client before redirecting to Paystack, read & deleted on return).
- `/admin` — admin dashboard (HTTP Basic Auth)
- `/payment/callback` — post-payment redirect from Paystack
- `/api/room/:hash/exists` — room existence probe (GET, used by the client to route first-time vs. returning joins)
- `/api/payment/initiate` — start payment flow (POST)
- `/api/webhooks/paystack` — Paystack webhook (HMAC-SHA512 verified)
- `/.well-known/security.txt` — security disclosure info
- `/robots.txt`, `/healthz` — crawler policy and health check

## Key conventions

- All IDs are random UUIDs (`crypto.randomUUID()`); all timestamps are ISO-8601 strings
- Fetch externally via the native `fetch()` API — no HTTP client libraries
- Tailwind CSS v4 — no `tailwind.config.js`; uses `@import "tailwindcss"` syntax in `src/client/app.css`
- Write Tailwind-based components manually — do NOT use daisyUI components
- No inline `<script>` tags in HTML (except the panic-flag bootstrap which carries the CSP nonce) — all JS is bundled and referenced via `<script type="module">`
- No third-party analytics, tracking pixels, or external scripts — CSP enforces this
- **No PWA. sTELgano is a pure web app.** No `manifest.json`, no service worker, no installable icon. Every PWA surface is a passcode-test failure.
- AGPL-3.0 licence; all source files need SPDX header: `// SPDX-License-Identifier: AGPL-3.0-only`
- UI terminology: "steg number" (technical), "the number in your contacts" (user-facing); "channel" not "conversation"
- "Room" is used only in internal code/DO storage, not user-facing copy
- **Commit messages never include `Co-Authored-By: Claude` or any AI/agent attribution** — write clean subject + body only. Past projects had to squash many commits to strip accumulated AI attribution; we don't repeat that here.
- **Files under `project/launch_content*.md` are gitignored by policy** — they're local planning drafts. Confirm any new `launch_content*.md` variant is in `.gitignore` before any `git add`.
- Run `npm run types` after changing `wrangler.toml` to regenerate `worker-configuration.d.ts`. The file is gitignored (machine-generated). Secrets set via `wrangler secret put` must be declared manually in `src/env.ts` since `wrangler types` cannot discover them without CF auth.

## Database

**D1 (SQLite at the edge).** Migrations in [`migrations/`](migrations/):
- `0001_create_extension_tokens.sql` — `extension_tokens` table (blind payment token store; no `room_id` column by design)
- `0004_live_counters.sql` — `live_counters` table (active-room snapshot for the admin dashboard)
- `0007_live_counters_by_tier.sql` — adds `free_active` / `paid_active` columns to `live_counters` (active rooms split by tier)
- `0005_create_campaigns.sql` — `campaigns` table (operator-authored campaign metadata for funnel attribution)
- `0006_create_daily_metrics.sql` — `daily_metrics` table (the analytics store; aggregate counts/sums per day × metric × country × dim, written by the metrics-queue consumer)

Room state (access records, current message, TTL, tier) lives entirely in DO Storage (SQLite per-DO), not in D1. D1 carries only global data that needs to outlive a specific DO instance.

Apply migrations: `npm run d1:migrate:local` (dev) / `npm run d1:migrate:remote` (prod).

## Environment variables (production)

Non-sensitive vars in `wrangler.toml [vars]`; secrets set via `wrangler secret put <NAME>`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `HOST` | Yes | Production hostname (CORS, `check_origin`, Paystack email domain) |
| `ADMIN_PASSWORD` | Yes | Admin dashboard password |
| `ADMIN_USERNAME` | No | Admin dashboard username (default: `admin`) |
| `PAYMENT_CURRENCY` | No | ISO 4217 display currency (default: `USD`) |
| `PRICE_CENTS` | No | Price in smallest display-currency unit (default: `200`) |
| `FREE_TTL_DAYS` | No | Free tier TTL in days (default: `7`) |
| `PAID_TTL_DAYS` | No | Paid tier TTL in days (default: `365`) |
| `MONETIZATION_ENABLED` | No | Set to `"true"` to enable paid tiers |
| `PAYSTACK_SECRET_KEY` | If monetization | Paystack secret key |
| `PAYSTACK_PUBLIC_KEY` | If monetization | Paystack public key (not read server-side; hosted checkout only) |
| `PAYSTACK_CALLBACK_URL` | If monetization | Post-payment redirect URL |
| `PAYSTACK_RECEIPT_EMAIL_DOMAIN` | If monetization | Operator-controlled domain for anonymous placeholder emails |

Salts (`ROOM_SALT`, `ACCESS_SALT`, `SENDER_SALT`, `ENC_SALT`) are public constants in `src/client/crypto/anon.ts`; rotating them is a breaking change.

## Deployment

CI/CD via GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):
- **staging** — `wrangler deploy --env staging` on every push to `staging` branch; deploys to `stelgano-staging` Worker at `staging.stelgano.com`
- **production** — requires a PR from `staging` → `main`; merging triggers `wrangler deploy` to the `stelgano` Worker at `stelgano.com`

No server process, no SSH, no systemd. Cloudflare manages the runtime. Rollback via the CF dashboard (version-based rollouts).

D1 migrations run as part of the deploy workflow before the Worker goes live.

## Testing

Two Vitest projects (see `vitest.workspace.ts`):
- **Pure-function** (`vitest.config.ts`) — Node/jsdom environment; tests for client-side state machine, crypto helpers, protocol utilities
- **Worker-runtime** (`vitest.workers.config.ts`) — runs under real `workerd` via `@cloudflare/vitest-pool-workers`; tests for RoomDO, D1 helpers, Worker routes, rate limiting

Run `npm run precommit` before pushing — runs typecheck + Biome check + full test suite.

## Design system

Dark-first glassmorphism UI. All surfaces use `backdrop-filter: blur(16px)` with translucent dark backgrounds. Accent colour is emerald green (`#10B981`).

**Fonts:** Outfit (display/headings), Inter (body/UI), JetBrains Mono (code/hashes). **Self-hosted** — Latin-normal WOFF2 files live in [`public/fonts/`](public/fonts/). Not loaded from Google Fonts CDN — doing so would leak IP + UA + timestamp to Google.

**Key CSS tokens:** `--color-primary` (#10B981), `--bg-dark` (#030712), `--text-main` (#f9fafb), `--text-muted` (#9ca3af), `--color-surface` (rgba(17,24,39,0.6)), `--color-surface-border` (rgba(255,255,255,0.1)).

**Component classes:** `.glass-panel`, `.glass-input`, `.glass-button`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, `.entry-card`, `.chat-layout`, `.bubble.sent`, `.bubble.received`, `.modal-card`, `.lock-overlay`, `.wordmark`.

**Chat bubble geometry:** sent `border-radius: 1.5rem 1.5rem 0.25rem 1.5rem` (24px, 4px tail bottom-right), received `1.5rem 1.5rem 1.5rem 0.25rem` (4px tail bottom-left). Sent uses emerald gradient, received uses frosted glass.

**Touch targets:** 56px minimum height on interactive elements (exceeds WCAG 44px). All motion respects `prefers-reduced-motion`. Mobile-first: 320px minimum width.

**SessionStorage keys** (cleared on panic/room-expiry/logout):
- Persistent session state (4 keys, survive lock/re-auth): `stelegano_phone`, `stelegano_room_hash`, `stelegano_sender_hash`, `stelegano_access_hash`
- Transient (read-once, in `STORAGE_KEYS` so cleared with the rest on expiry/panic): `stelegano_handoff_phone`, `stelegano_handoff_tier` — set before Paystack redirect, read & deleted on return from `/payment/callback`; `stelegano_extension_secret` — set before Paystack redirect, deleted immediately before join on return
- UX preference (persists across sessions *except panic*): `stelgano_selected_country` — last-picked country in the generator drawer.

**Panic clear (`/x`)** redirects to `/?p=1`. The inline bootstrap script detects `?p=1`, calls `sessionStorage.clear()`, and strips the flag from the URL via `history.replaceState` before the user sees the address bar.
