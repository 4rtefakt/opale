# Migrations SQL — Opale

## Fonctionnement

Les migrations sont appliquées **automatiquement par l'API au démarrage**
(`api/lib/migrate.js`), une fois et une seule, dans l'ordre numérique du
préfixe. Rien n'est à jouer à la main.

- **Journal** : table `schema_migrations` (`version`, `name`, `checksum`,
  `applied_at`, `duration_ms`).
- **Atomicité** : chaque migration et son inscription au journal sont dans la
  MÊME transaction. Un échec en cours de route ne laisse ni schéma ni journal
  à moitié appliqués, et l'API refuse de démarrer plutôt que de servir du
  trafic sur un schéma incomplet.
- **Concurrence** : `pg_advisory_lock` sérialise les instances. Deux
  conteneurs qui démarrent ensemble ne se marchent pas dessus — le second
  attend, puis constate qu'il n'y a rien à faire.
- **Immuabilité** : le SHA-256 de chaque fichier appliqué est stocké. Éditer
  une migration déjà appliquée bloque le démarrage avec un message explicite.
  Pour corriger, on crée un fichier `NNN+1`, on ne réécrit jamais l'ancien.
- **Ordre** : le tri est NUMÉRIQUE, pas alphabétique — `100_x.sql` passe bien
  après `099_y.sql`. Un numéro en double est une erreur au démarrage, plus une
  ambiguïté silencieuse.

### Outillage

```bash
node scripts/migrate.js            # applique ce qui manque
node scripts/migrate.js --status   # liste appliquées / en attente (exit 1 si en attente)
curl -s localhost:3010/health      # version de schéma actuellement servie
```

### Variables

| Variable | Effet |
|---|---|
| `OPALE_MIGRATE_ON_BOOT=false` | Ne migre pas au démarrage — à piloter depuis l'orchestrateur |
| `OPALE_MIGRATIONS_BASELINE=NNN` | Marque tout ce qui est ≤ NNN comme appliqué **sans l'exécuter** |

### Adoption sur une instance existante

Une instance dont les migrations ont été appliquées à la main avant
l'existence du runner n'a **rien à faire** : les migrations sont idempotentes
(invariant vérifié en CI, cf. ci-dessous), le runner les rejoue en no-op et
remplit `schema_migrations` correctement.

`OPALE_MIGRATIONS_BASELINE` n'est utile que si la base est assez volumineuse
pour que même un no-op coûte. À manier avec précaution : il affirme au runner
qu'un état est déjà en place sans le vérifier.

### CI

Le job `validate-sql-migrations` joue tous les fichiers sur une base Postgres
16 fraîche, puis **les rejoue une seconde fois**. C'est cette double passe qui
garantit l'idempotence — et donc la fiabilité de l'adoption ci-dessus. Toute
migration doit rester idempotente.

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
