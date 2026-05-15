# Contributing to Opale

Thanks for your interest. Opale is an experimental, single-maintainer
project — issues and PRs are reviewed on a best-effort basis.

## Before you start

- Read the [README](README.md) and [INSTALL.md](INSTALL.md) to understand
  the scope: a self-hosted RMM for a single organisation, currently coupled
  to Microsoft Entra ID + Intune (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
  for the full surface).
- Open an issue **before** working on a feature so we can agree on scope.
  Bug fixes don't need a prior issue but a short repro helps.
- The maintainer reserves the right to decline contributions that expand
  the project beyond its stated scope (single-org, FR/EU compliance focus).

## Development setup

```bash
git clone https://github.com/4rtefakt/opale.git
cd opale
cp .env.example .env       # fill in mandatory values, see docs/CONFIGURATION.md
./setup.sh                  # vendors front-end deps (MSAL, Tabler Icons, …)
docker compose -f docker-compose.example.yml up -d
```

The frontend has no build step — edit files in `front/` and reload.
The API runs in a Docker container; rebuild with `docker compose build api`
after editing `api/`. PostgreSQL migrations beyond `001_init.sql` are applied
manually (see [INSTALL.md](INSTALL.md)).

For the Windows agent, see [agent-go/RECAP-pour-UI.md](agent-go/RECAP-pour-UI.md).

## Pull requests

- **Branch from `main`** unless the maintainer asks otherwise.
- **One PR = one concern.** Don't bundle unrelated changes.
- **Match the existing style.** No reformatting passes on adjacent code.
- **Surgical changes.** Every diff line should trace back to the PR's stated
  goal. Drive-by refactors get rejected — open a separate PR.
- **Don't add backwards-compat shims** unless the maintainer asks. Same for
  feature flags, config knobs, abstractions for "future flexibility".
- **Tests:** Go agent: `go test ./agent-go/...`. API: `node:test` suite under
  `api/tests/`, run with `npm test` from `api/`. Integration tests require
  `PG_TEST_URL`; they skip gracefully without it. CI (`.github/workflows/ci.yml`)
  runs `npm test` automatically with a Postgres 16 service — add or update tests
  for any API logic change. Frontend has no automated tests (vanilla JS, no
  bundler — by design); describe manual test steps in the PR body for front-only
  changes.

## Commit style

Conventional Commits-ish, in French or English:

```
type(scope): summary

[optional body]
```

Types used here: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.
Scopes match top-level dirs (`api`, `front`, `agent-go`, `docs`) or
features (`alerts`, `tickets`, `branding`, …).

The maintainer squashes most PRs on merge — your individual commits don't
need to be perfect.

## Security issues

Do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the disclosure process.

## Code of Conduct

This project adopts the Contributor Covenant 2.1
([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)). By participating, you agree
to abide by it.

## License

By contributing, you agree that your contributions will be licensed under
the project's [AGPL-3.0 license](LICENSE).
