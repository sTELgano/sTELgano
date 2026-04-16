# Contributing to sTELgano

Thank you for your interest in contributing. sTELgano is an open protocol and
application — external contributions make the security model more credible, not
less. The more eyes on the cryptographic implementation, the better.

## Before you start

- Read the [PRD](project/stelgano_PRD_v2_1.md) and [Epics](project/stelgano_Epics_v2_1.md)
  to understand the product's scope and threat model
- Read the [Security page](lib/stelgano_web/controllers/page_html/security.html.heex)
  for the cryptographic specification
- Check [open issues](https://github.com/stelgano/stelgano/issues) before opening a new one

## What we welcome

- **Security audits and vulnerability reports** — see [SECURITY.md](SECURITY.md)
- **Bug fixes** with tests
- **Protocol improvements** — open an issue for discussion first; changes to
  `assets/js/crypto/anon.js` affect the sTELgano-std-1 specification and require
  wider review
- **Self-hosting improvements** — Docker, Fly.io, Railway, Kubernetes, etc.
- **Translations** — gettext `.po` files in `priv/gettext/`
- **Documentation** — README, inline comments, the security page

## What we do not accept

- Features that would store user identity, phone numbers, or PINs server-side
- Analytics, tracking pixels, or any client-side instrumentation
- Dependencies that require native code or WASM for the cryptographic path
  (the Web Crypto API constraint is intentional — see §8.4 of the PRD)
- UI changes that would fail the Passcode Test (§5 of the PRD)

## Development setup

```bash
# Prerequisites: Elixir 1.15+, Erlang/OTP 26+, PostgreSQL 16+, Node.js 20+

git clone https://github.com/stelgano/stelgano
cd stelgano
mix setup          # deps.get + ecto.setup + assets.setup + assets.build
mix phx.server     # starts on http://localhost:4000
```

## Running the quality suite

```bash
mix precommit
# Runs in order:
#   mix compile --warnings-as-errors
#   mix deps.unlock --unused
#   mix format
#   mix test
```

Individual tools:

```bash
mix test                        # ExUnit tests
mix format --check-formatted    # Elixir formatter
mix credo --strict              # static analysis
mix dialyzer                    # type checking (first run is slow)
mix sobelow --config            # security analysis
```

## Pull request checklist

- [ ] `mix precommit` passes with no warnings
- [ ] New behaviour is covered by tests
- [ ] No new external npm dependencies
- [ ] No changes to `assets/js/crypto/anon.js` without opening a discussion issue first
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

Open a [GitHub Discussion](https://github.com/stelgano/stelgano/discussions)
for questions about the protocol or implementation. Use issues only for
actionable bug reports or feature proposals.
