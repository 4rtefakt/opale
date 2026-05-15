## What this PR does

<!-- One paragraph. What changes, why now. -->

## Linked issue

<!-- Closes #123 / Refs #456 — open an issue first for non-trivial changes. -->

## How to test

<!-- Step-by-step. Reviewers will follow these. -->

1.
2.
3.

## Checklist

- [ ] Branch is up to date with `main` (or the agreed base branch)
- [ ] One concern per PR — no drive-by refactors
- [ ] Existing style matched (no reformatting passes)
- [ ] Manual test steps above are accurate
- [ ] If touching the API: `docker compose build api` succeeds
- [ ] If touching the agent: `go test ./agent-go/...` passes
- [ ] If touching the schema: a new migration `0NN_*.sql` is added (no
      edits to past migrations)
- [ ] If touching anything user-facing: privacy implications considered
      (cf. [docs/PRIVACY.md](../docs/PRIVACY.md))
- [ ] If touching anything that could be a vulnerability: see
      [SECURITY.md](../SECURITY.md) — disclose privately first

## Notes for the reviewer

<!-- Anything tricky? Edge cases I'm uncertain about? -->
