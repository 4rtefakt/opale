# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue.** Please report vulnerabilities
privately to:

> **4rtefakt@kore.sh**

Use PGP if you have it (key on request). Include:

- A description of the issue and its impact (what a malicious actor could
  achieve)
- Steps to reproduce, or a proof of concept
- Affected versions / commits
- Your name or handle for credit (or a request for anonymity)

You should receive an acknowledgement within **5 business days**. Best-effort
response — Opale is a single-maintainer experimental project, please
calibrate your expectations accordingly.

## Disclosure policy

- Coordinated disclosure: a fix lands first, then a public advisory after
  a reasonable upgrade window (typically 30 days, sooner if the issue is
  already public).
- A GitHub Security Advisory and a CVE will be requested for any issue
  that meaningfully affects deployed instances.
- Reporters are credited in the advisory unless they request anonymity.

## Supported versions

This project does not yet have a stable release. The current branch
(`main`) is the only supported version. Once tagged releases exist, this
section will list the supported tag windows.

## Scope

In scope:

- The API server (`api/`)
- The frontend SPA (`front/`)
- The Go agent (`agent-go/`) — including signing/update logic
- The default Docker images and `docker-compose.example.yml`
- Database migrations (`api/migrations/`)

Out of scope:

- Vulnerabilities that require an attacker to already have admin access
  to the host running Opale
- Issues only reproducible against forks with significant local changes
- Denial-of-service via brute resource exhaustion (please report as a bug,
  not a security issue)
- Configuration choices made by an instance operator (e.g. exposing the
  API without TLS, weak Postgres password) — those are operational issues,
  not vulnerabilities

## Defensive posture

- TLS is mandatory for production instances (the agent refuses
  `InsecureSkipVerify`).
- The Go agent verifies an ed25519 signature on every binary update.
- Agent tokens are stored as SHA-256 hashes; plaintext tokens never reach
  the database.
- LAPS-recovery passwords are escrowed via RSA-OAEP-SHA256 ciphertext;
  the private key lives only on the API server.
- See [docs/PRIVACY.md](docs/PRIVACY.md) for data-handling considerations.

Thanks for helping keep deployments safe.
