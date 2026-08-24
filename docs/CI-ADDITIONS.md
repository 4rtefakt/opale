# Ajouts CI proposés (à appliquer par le maintainer)

> Le token utilisé pour pousser cette branche n'a pas le scope `workflow`,
> donc `.github/workflows/ci.yml` ne peut pas être modifié depuis ici.
> Les blocs ci-dessous sont prêts à coller dans `ci.yml`.

## 1. Builder la CLI en CI + shellcheck

La CLI n'est pas buildée en CI (le breakage Windows corrigé en #65 était
passé inaperçu). À insérer entre les jobs `test-agent-go` et
`validate-sql-migrations` :

```yaml
  # ─────────────────────────────────────────────────────────────────────────
  # 2b) CLI Go : même matrice que l'agent. Ajouté après le breakage Windows
  #     (#65) passé inaperçu — la CLI n'était pas buildée en CI.
  # ─────────────────────────────────────────────────────────────────────────
  test-cli-go:
    name: Test CLI Go (${{ matrix.goos }}/${{ matrix.goarch }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        goos: [windows, linux, darwin]
        goarch: [amd64, arm64]
    defaults:
      run:
        working-directory: cli
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v6
        with:
          go-version-file: cli/go.mod
          cache-dependency-path: cli/go.sum

      - name: go vet
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        run: go vet ./...

      - name: go build
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          CGO_ENABLED: '0'
        run: go build ./...

      - name: go test (host only — linux/amd64)
        if: matrix.goos == 'linux' && matrix.goarch == 'amd64'
        run: go test ./...

  # ─────────────────────────────────────────────────────────────────────────
  # 2c) Shellcheck sur les scripts d'install/build — un installeur cassé
  #     est la pire première impression possible.
  # ─────────────────────────────────────────────────────────────────────────
  shellcheck:
    name: Shellcheck install & build scripts
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: shellcheck
        run: |
          sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends shellcheck
          # SC1091 (source .env introuvable) et SC2312 : faux positifs ici.
          shellcheck -e SC1091 setup.sh landing/install.sh scripts/*.sh
```

## 2. Syntax check du front

À ajouter comme étape du job `front-i18n-parity` (après le check de
parité) :

```yaml
      - name: Syntax check (node --check) on all front/*.js
        run: |
          set -euo pipefail
          fail=0
          while IFS= read -r -d '' f; do
            if ! node --check "$f"; then
              echo "::error file=$f::node --check failed"
              fail=1
            fi
          done < <(find front -type f -name '*.js' \
                     -not -name '*.min.js' \
                     -not -name 'xterm.js' \
                     -not -name 'chart.umd.min.js' -print0)
          exit "$fail"
```

Une fois appliqués, ce fichier peut être supprimé.
