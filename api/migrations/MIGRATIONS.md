# Migrations SQL — Opale

## Fonctionnement

- **`001_init.sql`** : monté sur `/docker-entrypoint-initdb.d/` du container
  PostgreSQL via `docker-compose.yml`. Joué automatiquement la première
  fois que la DB est initialisée (DB vide).
- **`002+`** : appliquées **manuellement** par le maintainer après
  rebuild/déploiement, dans l'ordre alphabétique du nom de fichier.
- **CI** : le job `validate-sql-migrations` (cf.
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) joue tous
  les fichiers `api/migrations/0*.sql` dans l'ordre alphabétique sur une
  DB Postgres 16 fraîche, puis **les rejoue une seconde fois** pour
  valider l'idempotence. Toute migration doit donc être idempotente.

Il n'existe **pas** de table `_migrations` ni de runner intégré. Le
maintainer trace ce qu'il a appliqué via le `git log` et le déploiement.

## Convention de nommage

```
NNN_short_snake_case.sql
```

- `NNN` = numéro à 3 chiffres, monotone, qui détermine l'ordre alphabétique
- Suffixe descriptif court (≤ 5 mots), snake_case
- Pas d'espaces ni de majuscules dans le nom de fichier

## Idempotence — patterns à utiliser

| Construct | Idempotence |
|---|---|
| `CREATE TABLE IF NOT EXISTS` | ✓ natif |
| `CREATE INDEX IF NOT EXISTS` | ✓ natif (PG 9.5+) |
| `ALTER TABLE … ADD COLUMN IF NOT EXISTS` | ✓ natif |
| `ALTER TABLE … ALTER COLUMN … TYPE …` | ✓ no-op si type identique |
| `INSERT … ON CONFLICT DO NOTHING / UPDATE` | ✓ natif |
| `CREATE TYPE` enum / `DO $$ BEGIN … EXCEPTION WHEN duplicate_object …` | wrap nécessaire |

Pour les exceptions plus larges (table déjà créée par une ancienne
migration, etc.), utiliser un bloc `DO` :

```sql
DO $$ BEGIN
  CREATE TABLE foo (...);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;
```

## Historique des numéros

L'ordre alphabétique du nom de fichier détermine l'ordre d'exécution.

- `001` à `017` : ajouts incrémentaux pendant la phase v1 (post-MVP)
- `018_health_signals.sql`, `019_token_expiration.sql`, `020_laps.sql`,
  `021_system_metrics.sql` : vague agent Go (signaux santé, rotation
  tokens, LAPS, métriques)
- **Gap `022`–`028`** : numéros sautés volontairement à l'époque pour
  démarrer une nouvelle vague à `030` (refonte tickets). Pas un
  problème, juste une convention narrative.
- `029_script_executions_output_limit.sql` : renommage du doublon `018`
  initial — voir section ci-dessous.
- `030` à `038` : refontes tickets, alertes, branding runtime, LAPS
  paramétrable.
- `039_missing_unique_indexes.sql` : index UNIQUE manquants depuis le
  commit initial — utilisés par le code (`ON CONFLICT`) mais jamais
  créés via migration. Détecté en cours de route, formalisé ici.

## Note sur le doublon historique 048

Initialement, `048_cli_tokens.sql` (PR #104) et `048_compliance_results.sql`
(PR #91) co-existaient — la PR CLI ayant été développée en parallèle dans
un worktree qui ne savait pas que `048` était déjà pris. L'ordre
alphabétique sur le suffixe ordonnait `cli_tokens` avant `compliance_results`,
mais c'était fragile et viole la convention de monotonie stricte.

`048_cli_tokens.sql` a été renommé en `050_cli_tokens.sql` pour combler le
gap (047 puis 049 sont occupés). La migration est idempotente
(`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`) — la
re-jouer sous le nouveau nom est un no-op silencieux sur les instances
qui l'avaient déjà appliquée sous l'ancien nom.

**Déploiement** :
- Côté prod, supprimer l'ancien fichier `048_cli_tokens.sql` (déjà
  appliqué) et copier le nouveau `050_cli_tokens.sql` — pas d'impact DB.
- Les nouveaux déploiements ne voient que le nouveau nom.

## Note sur le doublon historique 018

Initialement, deux fichiers `018_*.sql` co-existaient :
`018_health_signals.sql` et `018_script_executions_output_limit.sql`.
L'ordre alphabétique sur le suffixe les ordonnait de façon déterministe
en CI, mais c'était fragile (un troisième `018_*` aurait introduit de
l'ambiguïté).

Le second a été renommé en `029_script_executions_output_limit.sql`
pour combler le gap historique. La migration est idempotente :
- `UPDATE … WHERE length(output) > 10000` : 0 rows touchées au 2e run
- `ALTER TABLE … ALTER COLUMN output TYPE VARCHAR(10000)` : no-op
  silencieux quand le type est déjà identique

Aucun impact prod : les instances existantes l'avaient déjà appliquée
sous l'ancien nom ; elles peuvent re-appliquer sous le nouveau nom sans
effet. Les nouveaux déploiements ne voient que le nouveau nom.
