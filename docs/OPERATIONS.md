# Operations — backup, restore, upgrade

> Guide opérateur pour une instance Opale auto-hébergée (compose de
> référence : `docker-compose.example.yml`). À lire AVANT d'avoir besoin
> de restaurer.

## Ce qu'il faut sauvegarder

| Élément | Où | Criticité |
|---|---|---|
| Base PostgreSQL | volume `pgdata` (dump logique recommandé) | **Critique** — tout l'état applicatif |
| `.env` | racine du déploiement | **Critique** — secrets (DB, Entra, VAPID, clé SSH) |
| `agent-go/keys/laps.key` | racine du déploiement | **Critique** — perdre cette clé rend **définitivement illisibles** tous les mots de passe LAPS escrowés |
| `agent-go/keys/signing.key` | racine du déploiement | **Haute** — sans elle, impossible de signer de nouveaux binaires agent ; les agents refuseront un binaire signé par une nouvelle clé (réinstallation de flotte nécessaire) |
| Pièces jointes tickets | volume `attachments_data` (`/app/data/ticket-attachments`) | Moyenne — fichiers joints aux tickets |
| `agent-go/dist/` | racine du déploiement | Faible — binaires reconstructibles (`node agent-go/build.js`) |

## Sauvegarde

### Base de données (dump logique quotidien)

```bash
set -a; source .env; set +a
docker compose -f docker-compose.example.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "opale-$(date +%F).dump"
```

Exemple de cron quotidien avec rotation 14 jours :

```cron
0 3 * * * cd /opt/opale && set -a && . ./.env && set +a && \
  docker compose -f docker-compose.example.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > /var/backups/opale/opale-$(date +\%F).dump && \
  find /var/backups/opale -name 'opale-*.dump' -mtime +14 -delete
```

### Fichiers

```bash
tar czf opale-files-$(date +%F).tgz \
  .env agent-go/keys/ \
  -C /var/lib/docker/volumes/$(docker compose -f docker-compose.example.yml \
     ps -q >/dev/null 2>&1; echo "opale_attachments_data")/_data .
```

Plus simple : sauvegardez `.env` + `agent-go/keys/` avec votre outil de
backup habituel, et le volume `attachments_data` via
`docker run --rm -v opale_attachments_data:/data -v "$PWD":/out alpine tar czf /out/attachments.tgz -C /data .`

**Stockez les clés chiffrées** (le dump DB contient les ciphertexts LAPS ;
`laps.key` les déchiffre — les deux ensemble = tous les mots de passe
admin locaux du parc).

## Restauration

1. Déployer une instance vierge (INSTALL.md §1–4) en réutilisant le `.env`
   et `agent-go/keys/` sauvegardés.
2. Démarrer uniquement la DB : `docker compose -f docker-compose.example.yml up -d db`
3. Restaurer le dump :

```bash
set -a; source .env; set +a
docker compose -f docker-compose.example.yml exec -T db \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  < opale-YYYY-MM-DD.dump
```

4. Restaurer le volume de pièces jointes si utilisé :
   `docker run --rm -v opale_attachments_data:/data -v "$PWD":/in alpine tar xzf /in/attachments.tgz -C /data`
5. `docker compose -f docker-compose.example.yml up -d` — l'API applique
   au boot les migrations éventuellement plus récentes que le dump.
6. Vérifier : `curl -s localhost:3010/api/health` → `{"status":"ok"}`,
   login UI, un agent qui checkin.

## Mise à jour de l'instance

```bash
cd /opt/opale
git pull                                              # ou checkout d'un tag
bash setup.sh                                         # vendors front à jour
docker compose -f docker-compose.example.yml build api
docker compose -f docker-compose.example.yml up -d    # migrations au boot
docker compose -f docker-compose.example.yml logs api | grep migration
```

- Les migrations SQL sont appliquées automatiquement au démarrage de l'API
  (table `schema_migrations`, advisory lock — cf.
  [`api/migrations/MIGRATIONS.md`](../api/migrations/MIGRATIONS.md)).
  Opt-out : `MIGRATE_ON_BOOT=false` dans `.env`.
- **Faites un dump DB avant chaque upgrade** (section ci-dessus) : les
  migrations sont idempotentes mais pas réversibles.
- Scripts de migration de données one-off : cf. INSTALL.md §9
  (`api/scripts/*.js`, à lancer une fois après certains upgrades).
- Front : `front/` est monté en volume — un `git pull` suffit, plus un
  restart de l'API pour vider le cache statique.
- Agent : rebuild + dépôt dans `agent-go/dist/` (INSTALL.md §10) ; les
  agents s'auto-mettent à jour au prochain checkin (signature ed25519).

## Sondes & supervision

- **Santé API** : `GET /api/health` → 200 `{"status":"ok"}` quand l'API et
  la DB répondent, 503 sinon. Utilisé par le healthcheck compose ; pointez
  votre supervision dessus.
- **Arrêt propre** : l'API ferme connexions et pool sur SIGTERM —
  `docker compose stop` est sûr.
- **Workers mail** : état visible via `GET /api/email/status` (admin) et
  la vue Paramètres.

## Incidents courants

| Symptôme | Réflexe |
|---|---|
| API en crash-loop au boot avec `migration NNN échouée` | La migration fautive est loggée ; corriger/rejouer manuellement puis redémarrer. Le runner s'arrête à la première erreur, rien après n'est appliqué. |
| `signing.key`/`laps.key` sont des RÉPERTOIRES | Docker les a créés avant la génération des clés. `rmdir` les deux, `bash setup.sh`, redémarrer. |
| Mots de passe LAPS indéchiffrables après restauration | Mauvaise `laps.key` (pas celle de l'instance d'origine). Sans la bonne clé : re-rotation forcée depuis l'UI (le poste doit être en ligne). |
| Postgres refuse les connexions après restore | Vérifier `POSTGRES_PASSWORD` du `.env` restauré vs celui du volume `pgdata` réinitialisé. |
