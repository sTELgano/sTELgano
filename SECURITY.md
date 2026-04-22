# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` branch | ✅ Active |
| Tagged releases | ✅ For 90 days after next release |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@stelgano.com** with:

- A description of the vulnerability
- Steps to reproduce
- The potential impact as you understand it
- Whether you want to be credited (and how)

We will acknowledge your report within **48 hours** and provide an assessment
within **7 days**. We aim to ship a fix within **30 days** of confirmation for
critical issues.

## Scope

We consider the following in scope:

- **Cryptographic implementation** (`assets/js/crypto/anon.js`) — incorrect
  derivation, weak randomness, IV reuse, decryption oracle, etc.
- **N=1 invariant violations** — any server-side path that allows more than one
  live message per room, or allows message history to persist
- **Access control bypass** — joining a room without a valid access_hash, or
  bypassing the failed-attempt lockout
- **Server-side data exposure** — any path that allows the server to learn the
  phone number, PIN, or message plaintext
- **Cross-site scripting (XSS)** in the application shell
- **CSRF vulnerabilities**
- **Authentication/session issues** in the admin dashboard

## Out of scope

- **Forensic hygiene bypass** — failure to implement History Masking, Vault Isolation, or international number normalization before hashing. While sTELgano implements best-effort local forensic defenses, we do not guarantee protection against sophisticated forensic analysis of a seized or compromised device.
- Social engineering
- Theoretical attacks without a proof of concept
- Issues in dependencies we do not control (report those upstream)
- Rate limiting on public endpoints (we implement rate limiting on access attempts;
  general DoS is an infrastructure concern)

## Disclosure policy

We follow **coordinated disclosure**:

1. You report privately
2. We confirm and assess
3. We develop and test a fix
4. We release the fix and publish a CVE/advisory simultaneously
5. You may publish your research after the fix is released

We will never pursue legal action against good-faith security researchers.

## Hall of fame

Security researchers who responsibly disclose valid vulnerabilities will be
credited in this file (with their permission) and in the release notes.

| Researcher | Vulnerability | Year |
|------------|---------------|------|
| — | — | — |

## PGP key

A PGP key for `security@stelgano.com` is available at:
`https://stelgano.com/.well-known/security-pgp.asc`

The `security.txt` file is at:
`https://stelgano.com/.well-known/security.txt`
