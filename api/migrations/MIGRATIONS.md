# Migrations SQL — Opale

## Fonctionnement

- **Runner au démarrage** (`api/lib/migrations.js`, appelé par
  `api/plugins/db.js`) : à chaque démarrage, AVANT que l'API n'écoute, tout
  fichier `NNN_*.sql` absent de la table `schema_migrations` est exécuté,
  dans l'ordre alphabétique du nom, **chacun dans sa propre transaction**,
  puis enregistré (nom, sha256, date, durée) dans cette même transaction.
  - Au premier échec : `ROLLBACK` du fichier, arrêt, erreur explicite
    (fichier, ligne, code SQLSTATE) dans les logs → **l'API refuse de
    démarrer**. Les fichiers déjà passés restent acquis ; le restart Docker
    reprend au fichier en échec une fois corrigé.
  - Verrou consultatif (`pg_advisory_lock`) : deux API qui démarrent en même
    temps ne jouent pas les migrations en parallèle ; la seconde attend puis
    ne rejoue rien.
  - Attente de verrou de table plafonnée à 60 s (`lock_timeout`) : une
    session qui bloque une table (psql resté ouvert, `pg_dump`…) fait
    échouer le démarrage avec un message clair au lieu de le figer.
  - Un fichier déjà enregistré mais modifié depuis (sha256 différent) n'est
    **pas** rejoué : avertissement dans les logs. Corriger une migration
    passée = nouveau fichier.
- **Volume neuf** (l'entrypoint Postgres n'a joué que `001`, aucune donnée) :
  toutes les migrations sont appliquées, sans avertissement.
- **Base existante sans historique** (migrée à la main avant le runner) : il
  n'y a volontairement **pas de « baseline »** qui marquerait des fichiers
  comme appliqués sans les exécuter — on ne sait pas ce qui a réellement été
  joué (et `075` par exemple DOIT s'exécuter pour purger les mots de passe).
  Au premier démarrage, **tous** les fichiers sont (re)joués puis
  enregistrés. C'est sûr parce que toutes les migrations sont idempotentes,
  y compris sur une base peuplée (règle ci-dessous, testée par
  `api/tests/lib/migrations-replay.test.js` et
  `api/tests/lib/migrations.test.js`).
- **Premier démarrage sur la prod** : le répéter d'abord sur une copie
  restaurée de la base (`api/scripts/run-migrations.js --database <base>`,
  sans démarrer l'API ; il affiche sa cible et refuse si `--database` ne
  correspond pas à la base résolue — `DATABASE_URL` / `PGURL` sont
  prioritaires sur `POSTGRES_*`), et comparer `settings`, `automation_costs` et les scripts
  intégrés : les seeds `INSERT … ON CONFLICT DO NOTHING` recréent une ligne
  supprimée à la main (ou jamais appliquée) — `tickets.assistant.enabled` et
  `ask.enabled` valent `'true'` par défaut. Procédure complète, pré-vol et
  échappatoire en cas de boucle de redémarrage : `INSTALL.md` §9.
- **Désactiver** : `DB_AUTO_MIGRATE=false` dans `.env`. Les migrations
  s'appliquent alors à la main (`node scripts/run-migrations.js --database
  <base>`, même runner, ou `psql` comme avant — cf. `INSTALL.md`) ; au démarrage, la
  table `schema_migrations` n'est ni créée ni lue.
- **`001_init.sql`** est aussi monté sur `/docker-entrypoint-initdb.d/` du
  container PostgreSQL (`docker-compose*.yml`) : joué par Postgres à la
  création d'un volume vide. Sans conséquence : le runner le rejoue
  (idempotent) et l'enregistre.
- **Tests** : `api/tests/helpers/db.js` applique les migrations de chaque
  schéma de test via le runner — toutes les suites exercent le chemin prod.
- **CI** : le job `validate-sql-migrations` (cf.
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) joue tous
  les fichiers `api/migrations/0*.sql` dans l'ordre alphabétique sur une
  DB Postgres 16 fraîche, puis **les rejoue une seconde fois** pour
  valider l'idempotence (sur base vide ; le rejeu sur base peuplée est
  couvert par la suite de tests).

## Règles d'écriture

- **Idempotente, y compris sur une base en service.** Le runner rejoue tout
  fichier non enregistré : un fichier doit pouvoir repasser sur la prod
  sans erreur NI modification de données. En particulier :
  - backfill / `UPDATE` de données : limiter au premier passage (ex. ne
    remplir que des colonnes encore `NULL`, ou seulement si la table cible
    est vide — cf. `010`, `060`) ;
  - contrainte `CHECK` redéfinie (`DROP` + `ADD`) : une migration ultérieure
    qui élargit la même contrainte rend le rejeu de l'ancienne dangereux
    (données devenues valides entre-temps refusées) — la garder derrière un
    test d'état (cf. `043`, ignorée une fois `052` passée) ;
  - pas de nom de schéma en dur (`'public'`) : utiliser `current_schema()`
    ou `to_regclass()` (cf. `046`).
- **Pas de `BEGIN` / `COMMIT`** (ni `START TRANSACTION`, `END`,
  `ROLLBACK`) au niveau du fichier : le runner encadre déjà chaque fichier,
  et **refuse** (avant d'appliquer quoi que ce soit) un fichier en attente
  qui en contient. Les `BEGIN … END` des blocs PL/pgSQL (`DO $$ … $$`) ne
  sont pas concernés.
- **Ordre hors transaction** (`CREATE INDEX CONCURRENTLY`, …) : mettre la
  ligne `-- opale:no-transaction`, **seule sur sa ligne, dans l'en-tête**
  du fichier (commentaires avant le premier ordre SQL ; une mention dans de
  la prose ou après du SQL est ignorée), et **un seul ordre** par fichier
  (le fichier est alors envoyé tel quel, sans transaction ; il est
  enregistré après succès, donc rejoué s'il est interrompu entre les deux).
  Aucun fichier du repo n'en a besoin aujourd'hui.

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
- **Gap `059`** : numéro jamais utilisé.
- `071_deployment_snapshots.sql`, `075_strip_onboarding_temp_passwords.sql` :
  correctifs de sécurité (snapshot du contenu des paquets déployés, purge
  des mots de passe temporaires de l'onboarding).
- **Gap `072`–`074`** : numéros laissés libres par la vague de correctifs de
  sécurité, parce que des branches non fusionnées les utilisent déjà
  (`security-fixes` / `fix/agent-freeze-hardening` : `073_ssh_host_key`,
  `074_tamper_dedup` ; `claude/tool-security-architecture-review-…` :
  `072_packages_approved_digest`, `073_tickets_status_priority_check`,
  `074_devices_ssh_host_key`). Si l'une d'elles est fusionnée, ses fichiers
  s'intercalent avant `075` : non enregistrés, ils seront joués au démarrage
  suivant — ils doivent donc respecter les règles d'écriture ci-dessus (et
  les doublons de numéro être renommés, cf. notes 018 / 048).
- `076_devices_ssh_host_key.sql` : empreinte de clé d'hôte SSH apprise par
  poste (TOFU). Reprend le contenu de `074_devices_ssh_host_key` de la
  branche `claude/tool-security-architecture-review-…` (mêmes colonnes,
  `ADD COLUMN IF NOT EXISTS`) : si cette branche est fusionnée, supprimer
  son `074` plutôt que de le renuméroter. Le `073_ssh_host_key` de
  `security-fixes` / `fix/agent-freeze-hardening` réutilise la même colonne
  `ssh_host_key_fp` (SHA-256 base64, mais AVEC padding « = » ; ce code écrit
  sans padding et normalise à la comparaison, préfixe `SHA256:` compris,
  donc les deux formats restent compatibles) avec `ssh_host_key_seen` au
  lieu de `ssh_host_key_learned_at` : à réconcilier avec ce code plutôt que
  de fusionner tel quel.
- `077_clear_stale_ip_netbird.sql` : met à NULL les `devices.ip_netbird`
  hors de 100.64.0.0/10 écrites avant le contrôle du check-in (une entrée
  `ip_netbird_cleared` par poste dans `audit_logs`).

## Note sur les retouches de 010, 043, 046 et 060

Ces fichiers ont été retouchés quand le runner de démarrage a été introduit,
pour qu'un rejeu sur une base peuplée ne modifie ni ne casse rien (effet
d'un premier passage inchangé) :

- `010` : l'`UPDATE source='intune'` ne touche plus que les `source` NULL
  (sinon un poste enrôlé par l'agent puis rapproché par la sync Intune
  repassait en `intune` et sortait des alertes offline) ;
- `043` : ignorée si `052` est passée (sinon rejeu en échec dès qu'un job
  `native_group` existe) ;
- `046` : `current_schema()` au lieu de `'public'` ;
- `060` : backfill `ticket_users` / `ticket_devices` seulement si la table
  est vide (sinon relations des tickets fusionnés recréées, et échec sur
  `ux_ticket_users_one_requester` si le requester a divergé).

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
