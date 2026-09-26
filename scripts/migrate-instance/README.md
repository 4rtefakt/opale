# `migrate-instance` — Migration data inter-instances

Outil de copie des données métier d'une instance Opale vers une autre.
Conçu pour la **bascule cutover** d'une instance source (ex. `old_rmm` sur l'ancien
serveur) vers une instance cible (ex. `opale` sur le nouveau serveur), une fois
les schémas appliqués des deux côtés via les migrations SQL standard.

## Pré-requis

- Node.js ≥ 20
- Accès réseau aux deux bases PostgreSQL (DSN avec credentials)
- Schéma cible déjà à jour (toutes les migrations `api/migrations/*.sql` appliquées) :
  démarrer une fois l'API cible suffit, elle applique les migrations au
  démarrage (runner, cf. `api/migrations/MIGRATIONS.md`) ; avec
  `DB_AUTO_MIGRATE=false`, les appliquer à la main
- Source et cible au **même niveau de migrations** : sur la source, démarrer
  l'API (même version) avant la migration, ou appliquer les fichiers manquants
- L'instance source en **lecture seule** ou en maintenance pendant la migration

## Installation

```bash
cd scripts/migrate-instance
npm install
```

## Usage

### Dry-run (recommandé en premier)

Liste les tables et compte les lignes côté source, sans rien écrire sur le target :

```bash
SOURCE_DSN=postgres://user:pass@old-host:5432/old_rmm \
  node scripts/migrate-instance/migrate.js --dry-run | tee migration-plan.jsonl
```

### Migration

```bash
SOURCE_DSN=postgres://user:pass@old-host:5432/old_rmm \
TARGET_DSN=postgres://user:pass@new-host:5432/opale \
  node scripts/migrate-instance/migrate.js | tee migration-$(date +%s).jsonl
```

### Verify post-migration

Compare les `count(*)` des deux côtés et signale tout écart :

```bash
SOURCE_DSN=… TARGET_DSN=… node scripts/migrate-instance/migrate.js --verify
# exit code 0 = ok, 1 = au moins une table target < source
```

### Reprise partielle / debug

```bash
SOURCE_DSN=… TARGET_DSN=… \
  node scripts/migrate-instance/migrate.js --tables tickets,ticket_messages,ticket_tags
```

### Options

| Flag | Effet |
|---|---|
| `--dry-run`        | Compte les lignes source, n'écrit rien |
| `--verify`         | Compare row counts source vs target, exit 1 si écart |
| `--tables T1,T2`   | Restreint à un sous-ensemble (debug ou reprise) |
| `--batch-size N`   | Taille de batch INSERT (défaut : 500) |
| `--no-reset-seq`   | Skip le reset des séquences PG (no-op aujourd'hui : tout est UUID) |

## Sortie : JSON Lines

Chaque évènement est une ligne JSON avec `ts`, `level`, `msg` + métadonnées
spécifiques. Idéal pour `jq`, ELK ou archive d'audit cutover.

```jsonl
{"ts":"2026-05-10T17:22:29.166Z","level":"info","msg":"copying table","table":"tickets","conflictTarget":["id"],"mode":"skip"}
{"ts":"2026-05-10T17:22:29.218Z","level":"info","msg":"table done","table":"tickets","read":1,"inserted":1,"skipped_existing":0,"source_missing":false,"duration_ms":7}
```

## Comportement

### Idempotent

Toute table est traitée avec `INSERT … ON CONFLICT (clé naturelle) DO NOTHING`
(sauf `settings` et `automation_costs` — voir ci-dessous). Re-lancer la migration
ne duplique rien, et la reprise après crash est sûre.

### Tables avec mode `update` (UPSERT)

`settings` et `automation_costs` sont traitées en **`DO UPDATE SET … = EXCLUDED.…`**.
Raison : ces deux tables sont seedées par les migrations 005, 032, 034, 037, 038
côté target avec des valeurs par défaut neutres. Sans UPSERT, les valeurs custom
de l'instance source (org.name, disk thresholds, salaire, etc.) seraient ignorées.

### Transactions

Chaque table est traitée dans **sa propre transaction** côté target : un échec
partiel rollback la table en cours sans toucher aux tables précédemment migrées.

### Pagination cursor-based

Les lectures côté source utilisent `WHERE (pk) > $cursor ORDER BY pk ASC LIMIT N`
(pas d'`OFFSET`, qui re-scanne à chaque batch). Compatible avec les PK simples
(UUID) ou composites (`ticket_tags`, `push_subscriptions`, `alert_snoozes`).

### FK auto-référentielle

`agent_tokens.replaced_by`, `tickets.merged_into` (tickets fusionnés) et
`remote_sessions.takeover_of` (prise de main) pointent vers la même table. Pour
éviter les violations FK pendant l'INSERT initial (la ligne visée peut arriver
plus tard dans l'ordre de pagination), la colonne est insérée à `NULL` en
première passe, puis une seconde passe `UPDATE … SET <colonne> = …` rétablit le
lien depuis les valeurs source.

### Tolérance dérive de schéma

Si une colonne existe d'un côté mais pas de l'autre, elle est ignorée avec un
warning (`columns present on source but not target` ou inverse). Permet une
migration cross-version mineure sans bloquer.

### Couverture du schéma

Toute table du schéma est soit copiée (`TABLES` dans `tables.js`), soit exclue
explicitement (`EXCLUDED_TABLES`, avec la raison). Le test
`api/tests/scripts/migrate-instance-tables.test.js` applique les migrations dans
un schéma scratch et échoue si une table manque, si une entrée est obsolète, si
l'ordre viole une clé étrangère ou si un `conflictTarget` ne correspond à aucune
contrainte d'unicité : ajouter une table dans une migration impose de l'ajouter
ici.

### Tables exclues

- `schema_migrations` : chaque instance gère son propre historique (table
  du runner de migrations, remplie au démarrage de l'API cible)
- `device_software` : cache régénéré par les agents au prochain checkin
- `ssh_sessions_archive_pre046` : archive de rollback de la migration 046, dont
  les lignes ont déjà été copiées dans `remote_sessions`
- `monitors`, `ticket_history` : ces tables n'existent pas dans le schéma actuel

### Scripts intégrés (migration 040)

Les migrations créent sur CHAQUE instance les scripts intégrés (`is_builtin`),
avec des `id` aléatoires différents d'une instance à l'autre mais la même
`builtin_key` (unique). Copier ceux de la source sur une cible déjà migrée
échoue (`scripts_builtin_key_idx`) et interrompt toute la migration. Sur la
cible, **avant** la migration, supprimer ses scripts intégrés : ceux de la
source sont alors copiés avec leurs `id`, que référencent ses
`script_executions` (étape 4 de la checklist).

### Pièces jointes des tickets

`ticket_attachments` ne contient que les métadonnées. Les fichiers vivent sur
disque (`ATTACHMENTS_DIR`, volume `attachments_data`) : les copier à part, en
conservant l'arborescence `<ticket_id>/<uuid>`.

### Séquences PostgreSQL

Le schéma actuel utilise **uniquement des UUID** (`gen_random_uuid()`) pour
toutes les PK : aucune séquence à reset. Le code détecte automatiquement
toute séquence attachée et la repositionne via `setval(MAX(col))`, donc
l'ajout futur d'une colonne `BIGSERIAL` ne nécessitera pas de modif du script.

## Checklist cutover

```
1. [ ] Snapshot DB source (pg_dump ou snapshot infra)
       → ssh root@old-host "docker compose exec -T db pg_dump -U opale opale > /tmp/snapshot-$(date +%s).sql"

2. [ ] Mettre l'API source en lecture seule ou en maintenance
       → idéalement bloquer les checkins agent + UI write

3. [ ] DRY-RUN
       SOURCE_DSN=… node scripts/migrate-instance/migrate.js --dry-run | tee plan.jsonl
       → vérifier les row counts par table

4. [ ] MIGRATION
       → sur la CIBLE d'abord (scripts intégrés re-créés par ses migrations, cf. plus haut) :
         psql "$TARGET_DSN" -c "DELETE FROM scripts WHERE is_builtin"
       SOURCE_DSN=… TARGET_DSN=… node scripts/migrate-instance/migrate.js | tee migration.jsonl
       → vérifier "migration completed" en queue, exit code 0
       → copier les fichiers de pièces jointes (volume attachments_data)

5. [ ] VERIFY
       SOURCE_DSN=… TARGET_DSN=… node scripts/migrate-instance/migrate.js --verify
       → exit code 0, tous les "status":"ok"

6. [ ] DNS switch / reverse proxy
       → ancien hostname → nouveau backend
       → si SPKI pinning différent côté agent : prévoir re-pin (cf. agent-go/pinning/pins.txt)

7. [ ] Validation parallèle (1-2 semaines recommandé)
       → les deux instances tournent, on observe les checkins arriver sur la nouvelle

8. [ ] Désactivation de l'ancien serveur
       → docker compose down sur l'ancien, archive du snapshot final
```

## Test end-to-end local

Pour valider le script sans toucher à la prod :

```bash
# 1. Deux Postgres éphémères
docker run -d --rm --name mig-src -p 55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=src postgres:16-alpine
docker run -d --rm --name mig-dst -p 55433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=dst postgres:16-alpine

# 2. Appliquer les migrations des deux côtés (à la main ici ; une API Opale
#    pointée sur ces bases le ferait au démarrage)
for f in api/migrations/*.sql; do
  cat "$f" | docker exec -i mig-src psql -v ON_ERROR_STOP=1 -U postgres -d src -q
  cat "$f" | docker exec -i mig-dst psql -v ON_ERROR_STOP=1 -U postgres -d dst -q
done

# 3. Peupler la source (snapshot prod ou fixtures custom)
cat snapshot.sql | docker exec -i mig-src psql -U postgres -d src

# 4. Migrer + verify (après suppression des scripts intégrés de la cible)
docker exec -i mig-dst psql -U postgres -d dst -c "DELETE FROM scripts WHERE is_builtin"
SOURCE_DSN=postgres://postgres:test@localhost:55432/src \
TARGET_DSN=postgres://postgres:test@localhost:55433/dst \
  node scripts/migrate-instance/migrate.js
SOURCE_DSN=… TARGET_DSN=… node scripts/migrate-instance/migrate.js --verify

# 5. Cleanup
docker stop mig-src mig-dst
```

## Limites connues

- **Pas de migration des données mobiles type `system_metrics > 1M lignes`** : pour
  des historiques très lourds (> 10M rows), prévoir 30+ min. Ajuster `--batch-size`
  si la mémoire est juste (par défaut 500 lignes / batch = ~25 MB en pic).
- **Pas de filtrage temporel** : tout l'historique est migré. Si besoin de purger
  les anciennes lignes time-series, le faire **avant** sur la source.
- **Aucune transformation de données** : copie 1:1. Les renames éventuels
  (settings keys, etc.) doivent être faits par migration SQL séparée, ou en
  patchant `tables.js` pour ajouter une étape de mapping.
