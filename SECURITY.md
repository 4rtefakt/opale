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

**Transport and endpoints**

- TLS is mandatory for production instances (the agent refuses
  `InsecureSkipVerify`); optional SPKI pinning on top of standard CA
  validation, never instead of it.
- SSH host keys are pinned per device (trust on first use). A different
  key aborts the handshake *before* authentication, so neither the pushed
  script nor terminal contents reach an impostor. Mismatches are audited.
- The Go agent verifies a SHA-256 and an ed25519 signature on every binary
  update, replaces the binary atomically, and rolls back after repeated
  failed checkins.

**Credentials**

- Agent and CLI tokens are stored as SHA-256 hashes; plaintext tokens
  never reach the database. Personal agent tokens expire and are rotated
  by the agent itself.
- A bootstrap token cannot claim a hostname that is already enrolled —
  it is embedded in clear in the Intune script, so any local user of any
  enrolled endpoint can read it.
- LAPS-recovery passwords are escrowed via RSA-OAEP-SHA256 ciphertext;
  the private key lives only on the API server, and every read is audited.
- The AI provider API key lives in the environment, never in `settings`,
  and outbound LLM URLs are checked against a host allowlist **at call
  time** — being able to redirect those calls is equivalent to being able
  to read the key, so the allowlist is not editable from the UI.

**Application**

- Migrations are applied transactionally at boot and their checksums are
  pinned; the API refuses to start on a half-applied or drifted schema.
- Security headers, including a `script-src 'self'` CSP, are applied to
  every response — API, errors and 404s included. Access tokens live in
  `sessionStorage`.
- Package deployment binds approval to a digest of the executable
  content: a package modified after review cannot be deployed without
  being re-approved.
- The container runs as a non-root user with `no-new-privileges` and all
  capabilities dropped, and publishes on the loopback only.

**Supply chain**

- API and frontend dependencies are installed from lockfiles with
  integrity verification; images are built with `npm ci`.
- CI runs `npm audit` (blocking on production dependencies),
  `govulncheck`, CodeQL, gitleaks over the full history, and Trivy on the
  published image and the Docker configuration.

**Authorization model**

Opale is an **administrators-only** tool: the SPA refuses any account
without `is_admin` and does not load. Every route that exposes fleet data
enforces that server-side too — the client-side check is a convenience,
never the boundary.

The exceptions are deliberate and narrower, not wider: ticket routes
carry their own ACL (admin **or** requester **or** assignee), and
`/api/me/prefs` and `/api/push/subscribe` are scoped to the caller's own
identity by the token, never by a parameter.

Push notifications go only to subscriptions belonging to administrators,
and a subscription endpoint must be an https URL on a public hostname —
the server issues a request to that URL on every alert.

**Known limitations** — stated plainly, since knowing them is what makes
the rest usable:

- Authorization has a single level (`is_admin`). There are no roles, so
  "can view the inventory" and "can run a script on every endpoint" are
  the same privilege.
- The API container holds the agent signing key, the LAPS key, the SSH
  key and the Entra secret at once. Code execution there compromises the
  whole fleet; separating signing is the next structural improvement.
- Grants, console sessions and the agent WebSocket registry are in
  process memory, so the API is single-instance today.
- The mobile biometric lock is a local convenience, not a second
  authentication factor (see `front/biometric.js`).

See [docs/PRIVACY.md](docs/PRIVACY.md) for data-handling considerations.

Thanks for helping keep deployments safe.
