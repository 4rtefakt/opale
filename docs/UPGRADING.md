# Notes de mise à jour

Étapes manuelles à faire **une fois**, lors du passage d'une instance à une
version qui les introduit. Les versions sans étape manuelle n'apparaissent
pas ici : `git pull` puis rebuild suffit (cf. INSTALL.md §9).

---

## Fenêtre de maintenance invalide : déploiements bloqués (agent 2.15.1)

### Ce qui change

Le réglage `maintenance_window_default` (JSON, sans éditeur dans
l'interface) était évalué « fail-open » : une fenêtre invalide valait
« toujours ouverte », donc des installations à toute heure. Une fenêtre
**configurée mais invalide** bloque désormais les déploiements : aucun
n'est distribué, ils restent *en attente*, et l'API journalise
`fenêtre de maintenance invalide…` (au plus une fois par heure). Les
scripts ne changent pas. Réglage absent, `null` ou `{}` : toujours ouverte,
comme avant. Détail : CONFIGURATION.md §2.5.

Des valeurs qui distribuaient des déploiements n'en distribuent plus :
jours au format ISO `[1..7]` (7), `start` sans `end`, `"tz": "Local"`…

### Avant le déploiement : vérifier le réglage

```bash
DC="docker compose -f docker-compose.example.yml"   # adapter à votre compose
set -a; . ./.env; set +a     # POSTGRES_USER / POSTGRES_DB dans ce shell
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT value FROM settings WHERE key = 'maintenance_window_default'"
```

Aucune ligne : rien à faire. Sinon, la valeur doit respecter :

- un objet JSON avec uniquement les clés `weekdays`, `start`, `end`, `tz`
  (minuscules exactes : pas `Start`, `days`, `from` / `to`…) ;
- `weekdays` : entiers de 0 (dimanche) à 6 (samedi) — en numérotation ISO,
  remplacer 7 par 0 ;
- `start` et `end` : les deux ou aucun, au format `H:MM` ou `HH:MM`, de
  `00:00` à `23:59` ;
- `tz` : nom de fuseau IANA (`Europe/Paris`, `UTC`) — pas `Local`.

Corriger avant le redémarrage si besoin, par exemple :

```bash
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "UPDATE settings SET value = '{\"weekdays\":[1,2,3,4,5],\"start\":\"02:00\",\"end\":\"04:00\",\"tz\":\"Europe/Paris\"}' WHERE key = 'maintenance_window_default'"
```

### Après : vérification

```bash
$DC logs api | grep "fenêtre de maintenance invalide"
```

Attendu : aucune ligne après le premier checkin d'un agent. Sinon, le
message indique la valeur et le problème (clé inconnue, format d'heure,
fuseau…).

---

## Image Docker non-root (`USER node`) et Node 22

### Ce qui change

- L'API tourne dans le conteneur en utilisateur **`node` (uid/gid 1000)** et
  non plus en root. Le code de `/app` appartient à root et n'est plus
  modifiable par le process ; le seul chemin écrit est le stockage des
  pièces jointes (`/app/data/ticket-attachments`, `ATTACHMENTS_DIR`).
- Base **Node 22 LTS** (`node:22-alpine`, Node 20 est en fin de vie).
- Dépendances installées depuis le lockfile (`npm ci`) : l'image contient
  exactement les versions testées en CI.
- Les deux compose déclarent un volume nommé **`attachments_data`** monté sur
  `/app/data/ticket-attachments`.
- `docker-compose.example.yml` publie le port 3010 sur **`127.0.0.1`**
  uniquement (l'API doit rester derrière le reverse proxy TLS).
- `docker-compose.yml` épingle Ollama (`ollama/ollama:0.34.4`, au lieu de
  `:latest`).

Concerne toutes les installations Docker : image construite depuis le dépôt
(`docker-compose.yml`, `docker-compose.example.yml`) **et** image publiée sur
GHCR (`ghcr.io/<owner>/opale`), qui passe elle aussi en non-root à partir de
la première release qui inclut ce changement. Pour l'image GHCR, l'étape 1
ne s'applique pas (image construite en CI) ; les étapes 2 à 5 si.

Sans ces étapes, rien ne casse de façon visible au démarrage, mais les
fonctions ci-dessous échouent silencieusement. Faire les étapes **avant**
(1, 2) et **juste après** (4, 5) le redémarrage.

### 1. Avant le build : fichiers du checkout lisibles par tous

`COPY` conserve dans l'image les permissions du checkout (propriétaire
root). En root ça ne comptait pas ; l'uid 1000, lui, doit pouvoir lire. Un
checkout fait avec un umask restrictif (027 ou 077, fréquent sur un hôte
durci) donne des fichiers 640/600 et des dossiers 750 : le conteneur ne
peut pas lire `/app/index.js` et **redémarre en boucle**.

Depuis la racine du checkout, cette commande ne doit **rien** afficher :

```bash
find api front setup.sh agent-go/keys/*.pub -path api/node_modules -prune -o ! -perm -o=r -print
```

Sinon, rendre lisibles les fichiers listés (ce sont des fichiers du dépôt,
pas des secrets ; ne jamais l'appliquer à `agent-go/keys/*.key` ni à un
`.env`) :

```bash
chmod a+rX <chemin listé> …   # X = exécution uniquement pour les dossiers
```

### 2. Avant le redémarrage : clés privées lisibles par l'uid 1000

`openssl genpkey` / `genrsa` créent les clés privées en `600` (root). Le
conteneur ne peut plus les lire :

```bash
sudo chgrp 1000 agent-go/keys/signing.key agent-go/keys/laps.key
sudo chmod 640  agent-go/keys/signing.key agent-go/keys/laps.key
```

(Adapter les chemins aux montages de votre compose. Avec `userns-remap` ou
Docker rootless, utiliser le gid hôte correspondant au gid 1000 du
conteneur.)

Impact si cette étape est oubliée :

- **`signing.key` illisible** : `GET /api/agent/binary` et
  `GET /api/agent/binary/meta` répondent **503** (« signing key
  indisponible »). Conséquences :
  - plus aucun auto-update des agents (ils continuent de fonctionner, mais
    ne reçoivent plus de mise à jour) ;
  - **chaque nouvel enrôlement** via les installeurs Intune déjà distribués
    (bootstrap et bulk, qui téléchargent `/api/agent/binary{,/meta}`) échoue
    sur le poste, sans signal côté serveur.
- **`laps.key` illisible** : l'affichage d'un mot de passe LAPS échoue
  (« Décryption impossible côté serveur »). Aucune donnée perdue : les
  agents continuent de déposer les mots de passe chiffrés, ils redeviennent
  lisibles dès la clé corrigée.

Vérifier aussi que les autres montages sont lisibles (`front/`,
`agent-go/dist/`) : la commande suivante ne doit rien afficher.

```bash
find front agent-go/dist ! -perm -o=r
```

### 3. Pièces jointes : sauvegarder si elles ne sont pas sur un volume

Avant le redéploiement, regarder comment `/app/data/ticket-attachments` est
stocké dans le conteneur actuel :

```bash
docker inspect <conteneur-api> \
  --format '{{range .Mounts}}{{.Destination}} <- {{.Type}} {{.Name}}{{.Source}}{{println}}{{end}}'
```

- **Déjà un volume ou un bind mount** : rien à sauvegarder, passer à
  l'étape 4 — mais **garder exactement le même nom de volume (ou le même
  chemin hôte)** dans la compose. Si la compose mise à jour déclare
  `attachments_data` alors que l'ancien volume porte un autre nom, un volume
  neuf et vide est monté : les pièces jointes semblent perdues (elles sont
  toujours dans l'ancien volume, `docker volume ls`). Adapter le nom dans la
  compose plutôt que l'inverse.
- **Aucun montage** (les fichiers sont dans le conteneur, cas de l'ancien
  `docker-compose.yml`) : ils seront **perdus** à la recréation du
  conteneur. Les sauvegarder d'abord :

  ```bash
  docker compose cp api:/app/data/ticket-attachments ./attachments-backup
  ```

Puis reconstruire et redémarrer (Node 22). Avec l'image publiée sur GHCR
au lieu d'un build local, remplacer `build --pull api` par
`docker compose pull api` :

```bash
git pull
docker compose build --pull api
docker compose up -d api
# Si le service Ollama de docker-compose.yml est utilisé (tag épinglé) :
docker compose pull ollama ollama-init && docker compose up -d ollama
```

### 4. Juste après : propriétaire du volume des pièces jointes

Un volume **neuf** hérite du propriétaire `node` de l'image : rien à faire.
Un volume (ou un dossier hôte) créé **avant** ce changement appartient à
root : l'API ne peut plus y créer ni supprimer de fichiers (upload et
suppression en erreur, lecture OK). Une seule fois :

```bash
# Si une sauvegarde a été faite à l'étape 3, la restaurer d'abord :
docker compose cp ./attachments-backup/. api:/app/data/ticket-attachments/
# Puis, dans tous les cas :
docker compose exec -u root api chown -R node:node /app/data/ticket-attachments
```

(Bind mount hôte : `sudo chown -R 1000:1000 <dossier hôte>`.)

### 5. Vérifications

```bash
docker compose exec api sh -c '
  id -u; node -v
  for f in /app/agent-go/keys/signing.key /app/agent-go/keys/laps.key; do
    [ -r "$f" ] && echo "OK $f" || echo "KO $f"
  done
  [ -w /app/data/ticket-attachments ] && echo "OK attachments" || echo "KO attachments"'
```

Attendu : `1000`, `v22.…`, trois lignes `OK`. Puis, dans l'interface :
ajouter et supprimer une pièce jointe sur un ticket de test, afficher le
mot de passe LAPS d'un poste de test, et vérifier qu'un agent en fenêtre de
maintenance se voit proposer la mise à jour (ou que
`/api/agent/binary/meta` ne répond pas 503).

### Dépannage d'urgence

Si le conteneur redémarre en boucle après le déploiement et que l'étape 1
ne peut pas être corrigée tout de suite, ajouter temporairement
`user: root` au service `api` de la compose rétablit l'ancien comportement.
À retirer dès les permissions corrigées : c'est précisément ce que ce
changement supprime.
