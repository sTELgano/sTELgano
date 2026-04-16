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
- Steg number generator: cryptographically random E.164 numbers via `crypto.getRandomValues`
- Phoenix Channel real-time: send, read receipts, edit before read, delete before read, typing indicator
- Lock screen with inactivity timeout (30s / 1min / 5min / 15min / 30min / never)
- Multi-device access: deterministic key derivation across devices
- Room TTL support (1h / 24h / 7d / 30d / custom / none)
- Room expiry with atomic message deletion
- Light / dark / system theme with `localStorage` persistence
- Public pages: homepage, `/security` (full crypto spec), `/privacy`, `/terms`, `/about`
- `/steg-number` generator page with clipboard copy and availability check
- AGPL-3.0 licence
- Docker multi-stage build
- CONTRIBUTING.md, SECURITY.md, COMMERCIAL.md

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
