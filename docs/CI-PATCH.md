# Patch CI à appliquer à la main

`docs/ci-security-hardening.patch` contient les modifications de
`.github/workflows/ci.yml` qui accompagnent cette branche.

## Pourquoi séparé

GitHub interdit à une application OAuth de pousser une modification de
workflow sans le scope `workflow`. La session qui a produit cette branche
n'en disposait pas : le fichier a donc été retiré des commits, et le
changement est livré ici sous forme de patch.

Le reste de la branche n'en dépend pas — la CI actuelle continue de passer.
Ce patch ajoute des vérifications, il n'en retire aucune.

## Application

```bash
git apply docs/ci-security-hardening.patch
git add .github/workflows/ci.yml
git commit -m "ci: lint réel, audit de dépendances, SAST, scan d'image et de secrets"
```

En cas de conflit (le fichier a bougé entre-temps) :

```bash
git apply --3way docs/ci-security-hardening.patch
```

## Ce que le patch change

**Le job « Lint » ne lintait rien.** Il exécutait `node --check`, qui
vérifie uniquement qu'un fichier *parse*. Sur ~240 fichiers JS sans types,
cela ne détectait ni variable non déclarée, ni `await` oublié, ni import
mort. Remplacé par ESLint sur tout le dépôt (`npm run lint`,
cf. `eslint.config.js` — déjà présent dans la branche, lui).

**Node 20 → 22.** Node 20 est en fin de vie depuis avril 2026 et ne reçoit
plus de correctifs de sécurité. Aligné sur les images Docker.

**Ordre des migrations aligné sur le runner.** Le glob `0*.sql` trié
alphabétiquement divergeait de `api/lib/migrate.js`, qui trie
numériquement : un futur `100_x.sql` serait passé avant `099_y.sql` et,
surtout, n'aurait pas été matché du tout — la CI aurait validé une chaîne
incomplète. Remplacé par `ls api/migrations/[0-9]*.sql | sort -V`.

**Quatre jobs de sécurité, là où il n'y en avait aucun.** Dependabot
ouvrait des PR mais ne bloquait aucun merge, et un dépôt qui manipule une
clé SSH d'accès au parc, une clé de signature de binaires et une clé LAPS
n'avait ni SAST, ni audit de dépendances, ni détection de secrets.

| Job | Rôle |
|---|---|
| `audit-dependencies` | `npm audit` bloquant sur les dépendances de **production** (API et vendors front), informatif sur l'outillage de dev ; `govulncheck` sur l'agent Go — le composant qui tourne en SYSTEM sur tous les postes |
| `codeql` | Analyse statique JavaScript et Go, requêtes `security-extended` |
| `secret-scan` | gitleaks sur l'**historique complet** : un secret committé puis retiré reste exploitable tant qu'il n'a pas été révoqué |
| `image-scan` | Trivy sur l'image publiée (CVE HIGH/CRITICAL corrigeables) et sur la configuration Docker (durcissement du Dockerfile) |

> À noter : c'est en ajoutant `audit-dependencies` que 5 vulnérabilités
> hautes ont été trouvées dans les dépendances de production, corrigées
> dans la branche — dont `@fastify/static`, vulnérable à un contournement
> d'autorisation et à une traversée de chemin sur le composant qui sert la
> SPA, et `ws`, divulgation de mémoire non initialisée sur le transport des
> WebSockets agent et des terminaux SSH.

## Après application

Le job `secret-scan` peut nécessiter un `GITLEAKS_LICENSE` pour les dépôts
d'organisation (gratuit pour les dépôts publics). `codeql` requiert
GitHub Advanced Security, activé par défaut sur les dépôts publics.

Si l'un de ces jobs n'est pas disponible sur votre plan, retirez-le du
fichier plutôt que de le laisser en échec permanent — un job rouge en
permanence finit par être ignoré, y compris quand il a raison.
