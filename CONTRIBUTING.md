# Contributing to sTELgano

Thank you for your interest in contributing. sTELgano is an open protocol and
application — external contributions make the security model more credible, not
less. The more eyes on the cryptographic implementation, the better.

## Before you start

- Read the [PRD](project/stelgano_PRD_v2_2.md) and [Epics](project/stelgano_Epics_v2_2.md)
  to understand the product's scope and threat model
- Read the [Security page](src/client/pages/security.html) for the cryptographic specification
- Check [open issues](https://github.com/sTELgano/sTELgano/issues) before opening a new one

## What we welcome

- **Security audits and vulnerability reports** — see [SECURITY.md](SECURITY.md)
- **Bug fixes** with tests
- **Protocol improvements** — open an issue for discussion first; changes to
  `src/client/crypto/anon.ts` affect the sTELgano-std-1 specification and require
  wider review
- **Self-hosting improvements** — Cloudflare Workers deployment configurations
- **Documentation** — README, inline comments, the security page

## What we do not accept

- Features that would store user identity, phone numbers, or PINs server-side
- Analytics, tracking pixels, or any client-side instrumentation beyond the
  existing fire-and-forget Analytics Engine events
- Dependencies that require native code or WASM for the cryptographic path
  (the Web Crypto API constraint is intentional — see §8.4 of the PRD)
- UI changes that would fail the Passcode Test (§5 of the PRD)
- PWA features of any kind (install banners, manifests, service workers,
  home-screen icons) — every surface is a passcode-test failure

## Development setup

```bash
# Prerequisites: Node.js 22+, a Cloudflare account (free tier works)

git clone https://github.com/sTELgano/sTELgano
cd stelgano
npm install                  # also runs wrangler types via postinstall
npm run build                # compile HTML, icons, client JS, CSS
npm run dev                  # wrangler dev → http://localhost:8787
```

Copy `.dev.vars.example` to `.dev.vars` and fill in the values for local
development (Paystack test keys, admin password, etc.).

## Running the quality suite

```bash
npm run precommit
# Runs in order:
#   npm run typecheck     tsc --noEmit
#   npm run check         Biome lint + format check
#   npm test              vitest run (both test suites)
```

Individual tools:

```bash
npm test                  # vitest run (pure-function + worker-runtime suites)
npm run typecheck         # TypeScript type checking
npm run lint              # Biome linter
npm run format            # Biome formatter (write)
npm run check             # Biome lint + format check (CI mode)
```

The test suite has two projects:
- **unit** (`vitest.config.ts`) — Node environment; covers crypto, client, and lib modules
- **workers** (`vitest.workers.config.ts`) — real workerd via `@cloudflare/vitest-pool-workers`; covers the Worker, RoomDO, and all HTTP/WebSocket routes

## Pull request checklist

- [ ] `npm run precommit` passes with no warnings
- [ ] New behaviour is covered by tests
- [ ] No new external npm dependencies without discussion
- [ ] No changes to `src/client/crypto/anon.ts` without opening a discussion issue first
  (crypto constant changes break all existing rooms)
- [ ] No changes to `src/protocol.ts` without updating both client and server code
- [ ] Commit messages are clear and reference an issue number where applicable
- [ ] PR description explains *why*, not just *what*

## Contributor Licence Agreement

By submitting a pull request, you certify that:

1. Your contribution is your original work or you have the right to submit it
2. You licence your contribution under the same AGPL-3.0 terms as the project
3. You understand that your contribution may be included in commercial releases
   of sTELgano under the dual-licence model described in [COMMERCIAL.md](COMMERCIAL.md)

We use a lightweight inbound=outbound CLA: no separate agreement to sign.

## Code of conduct

Be direct. Be constructive. Disagreements about security design are expected and
healthy — keep them technical and evidence-based. Personal attacks are not
tolerated.

## Questions

Open a [GitHub Discussion](https://github.com/sTELgano/sTELgano/discussions)
for questions about the protocol or implementation. Use issues only for
actionable bug reports or feature proposals.
