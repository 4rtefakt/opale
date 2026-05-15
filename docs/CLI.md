# Opale CLI

Outil en ligne de commande pour administrer Opale depuis un terminal, sans ouvrir le navigateur.

## Installation

```bash
# Build depuis les sources (nécessite Go ≥ 1.22)
cd cli/
go build -o opale .
sudo mv opale /usr/local/bin/
```

## Authentification

```bash
opale auth login --server https://opale.example.com
```

Ouvre le navigateur pour une authentification Microsoft Entra (PKCE callback localhost). Un token CLI préfixé `opl_<hex64>`, valable 90 jours, est sauvegardé dans `~/.config/opale/credentials` (chmod 0600 sur Unix).

```bash
opale auth status    # serveur, début du token, date d'expiration
opale auth logout    # supprime les credentials locaux
```

Les credentials peuvent aussi être fournis via variables d'environnement ou flags globaux :

```bash
export OPALE_SERVER=https://opale.example.com
export OPALE_TOKEN=opl_<hex>
# ou
opale --server https://opale.example.com --token opl_<hex> devices ls
```

Pour un déploiement headless / CI, on peut générer un token via la fenêtre d'auth interactive sur une machine de dev puis le copier dans `OPALE_TOKEN` côté CI. Révocation possible depuis l'UI **Paramètres → Tokens CLI** à tout moment.

### Stockage local

| OS | Mécanisme |
|---|---|
| Linux / macOS | Fichier `~/.config/opale/credentials` (chmod 0600) |
| Windows | `%USERPROFILE%\.config\opale\credentials` — les ACLs NTFS héritent du parent (le fichier reste lisible par les processus du même utilisateur). Pour un binaire admin sur sa propre machine, considéré acceptable. |

### Refus `http://`

Les serveurs `http://` sont **refusés par défaut** pour éviter de fuiter le token / motif de session en clair. Pour le dev local uniquement :

```bash
opale --allow-insecure-server --server http://localhost:3010 auth login
```

---

## Setup Microsoft Entra (côté admin)

Cette section est destinée à l'administrateur Entra qui déploie Opale dans un nouveau tenant. À faire **une fois**, avant que les utilisateurs ne lancent `opale auth login` pour la première fois.

### 1. App Registration

Dans le portail Entra → **App registrations** → **New registration** :

- **Name** : `Opale CLI` (ou repris de l'app existante du frontend si elle est déjà créée)
- **Supported account types** : *Accounts in this organizational directory only* (single tenant)
- **Redirect URI** : laisser vide à cette étape, on ajoutera ensuite

### 2. Redirect URI pour le PKCE callback

Le CLI ouvre un serveur HTTP local sur un port **éphémère**. Il faut whitelist toute la plage `http://localhost:*` :

- Dans l'app registration → **Authentication** → **Add a platform** → **Mobile and desktop applications**
- Cocher la box `http://localhost` (Microsoft accepte cette wildcard pour les flows publics PKCE)
- Désactiver explicitement *Allow public client flows* → **Yes** (PKCE est un flow public, pas de client secret)

### 3. API exposée + scope `access_as_user`

Le CLI demande un access token avec un scope custom, vérifié par l'API. À configurer dans l'app registration :

- **Expose an API** → **Set** l'Application ID URI (par défaut `api://<client-id>`, accepter)
- **Add a scope** :
  - Scope name : `access_as_user`
  - Who can consent : *Admins and users*
  - Admin consent display name : `Access Opale as the signed-in user`
  - Admin consent description : `Allows the CLI to act on behalf of the user against Opale`
  - State : *Enabled*

### 4. Variables d'environnement côté serveur

Dans `docker-compose.yml` (ou `.env`) du serveur Opale :

```env
ENTRA_TENANT_ID=<your-tenant-id>
ENTRA_CLIENT_ID=<your-client-id>
```

Pas de `ENTRA_CLIENT_SECRET` requis (flow PKCE est public).

### 5. Vérifications

```bash
# côté CLI utilisateur
opale auth login --server https://opale.example.com
# → navigateur s'ouvre, Entra demande consentement, callback localhost,
#   "✅ Authentification réussie", token sauvegardé.

# côté API serveur
curl https://opale.example.com/api/auth/config
# → {"client_id":"...","tenant_id":"..."}  (publique, pas de secret)
```

Si le login échoue avec `AADSTS65001 (Consent required)` : l'admin Entra doit pré-consentir le scope `access_as_user` pour le tenant (case *Grant admin consent* dans l'app registration → API permissions).

---

## Flags globaux

| Flag | Description |
|------|-------------|
| `--server` | URL du serveur (ou `OPALE_SERVER`) |
| `--token` | Token CLI (ou `OPALE_TOKEN`) |
| `--json` | Sortie JSON brute (compatible avec `jq`) |
| `--no-color` | Désactive les couleurs ANSI (auto-détecté si stdout n'est pas un TTY) |
| `--allow-insecure-server` | Autorise un serveur `http://` — dev local uniquement, **JAMAIS** en prod |

---

## Postes

```bash
opale devices ls                     # tous les postes
opale devices ls --status online     # filtre : online | offline | critical | unassigned
opale devices show <hostname>        # détail complet (matériel, sécu, Intune, Defender…)
```

`devices show` affiche des sections :
- **Identité** — hostname, statut, utilisateur assigné, session active
- **Matériel** — modèle, CPU, RAM, GPU, disque, batterie
- **Réseau** — IP Netbird
- **Sécurité** — compliance, BitLocker, Defender, Firewall, TPM, reboot en attente
- **Intune** — dernière sync, date d'inscription
- **Système** — OS, version agent, dernière vue

---

## Tickets

```bash
opale tickets ls                              # tickets ouverts et en cours
opale tickets ls --status resolved            # tickets résolus
opale tickets show <id>                       # détail + fil de messages
opale tickets create "Problème réseau" \
  --device BGD --priority high               # ouvrir un ticket
opale tickets comment <id> "Message"          # ajouter un message
opale tickets update <id> --status in_progress --priority high
opale tickets close <id>                      # passer en résolu
```

**Statuts valides :** `open` | `in_progress` | `resolved`  
**Priorités valides :** `low` | `normal` | `high`

---

## Sessions distantes

### Console SYSTEM (via agent Go)

Ouvre un terminal SYSTEM directement sur le poste — sans SSH, via le canal WebSocket de l'agent.

```bash
opale console <hostname>
opale console BGD --category troubleshoot --note "Diagnostic réseau"
opale console BGD --takeover    # reprend une session déjà ouverte
```

**Catégories :** `maintenance` | `troubleshoot` | `audit` | `incident` | `other`

### SSH (via Netbird)

Connexion SSH standard. Nécessite que Netbird soit actif et OpenSSH Server installé sur le poste.

```bash
opale ssh <hostname>
opale ssh BGD --category audit --note "Vérification logs"
```

---

## Scripts PowerShell

```bash
opale scripts ls                              # liste les scripts disponibles
opale scripts run <hostname> <script>         # lance via l'agent (poll, attend le résultat)
opale scripts exec <hostname> <script>        # exécution SSH synchrone (sortie en direct)
opale scripts history <hostname>              # historique des exécutions sur un poste
```

`scripts run` envoie le script à l'agent et attend le résultat (timeout 3 min).  
`scripts exec` exécute via SSH directement — sortie affichée en temps réel (nécessite Netbird + OpenSSH).

```bash
opale scripts run BGD "Espace disque libre"
opale scripts exec BGD "Configuration réseau complète"
```

---

## Alertes

```bash
opale alerts ls                              # alertes actives (disque, offline, conformité)
opale alerts snooze <hostname> \
  --type disk_critical \
  --days 7 \
  --reason "Nettoyage en cours"
```

**Types de snooze :** `disk_critical` | `disk_high` | `noncompliant` | `offline`  
Le snooze est un upsert — relancer la commande prolonge la durée.

---

## Conformité

```bash
opale compliance ls                          # taux de conformité parc par règle
opale compliance show <hostname>             # résultats des 12 règles pour un poste
```

---

## Applications & déploiements

```bash
opale apps ls                                # packages disponibles avec stats de déploiement
opale apps search "Visual Studio Code"       # recherche dans le catalogue winget
opale apps deploy <package> <hostname>...   # déploie sur un ou plusieurs postes
opale apps deployments                       # déploiements récents
opale apps deployments --status failed       # filtre par statut
opale apps deployments --device BGD         # filtre par poste
opale apps cancel <deployment-id>            # annule un déploiement pending
opale apps retry <deployment-id>             # relance un déploiement failed/cancelled
```

**Statuts de déploiement :** `pending` | `running` | `success` | `failed` | `cancelled`

```bash
# Déployer sur plusieurs postes à la fois
opale apps deploy "Agent CheckMK" BGD MRE ABT
```

---

## Journal d'audit

```bash
opale audit ls                               # 50 derniers événements
opale audit ls --json | jq '.[] | select(.action == "console_open")'
```

---

## Tokens CLI

```bash
opale tokens ls                              # liste les tokens CLI actifs
opale tokens revoke <id>                     # révoque un token
```

Les tokens sont aussi gérables depuis l'interface web : **Paramètres → Tokens CLI**.

---

## Autocompletion

### Installation automatique

```bash
opale completion install
```

Détecte le shell courant (zsh / bash / fish), installe le script au bon endroit et met à jour le fichier rc. Puis :

```bash
source ~/.zshrc   # ou ~/.bashrc
```

### Installation manuelle

```bash
# zsh
opale completion zsh > ~/.zsh/completions/_opale

# bash
opale completion bash > ~/.bash_completion.d/opale

# fish
opale completion fish > ~/.config/fish/completions/opale.fish
```

### Ce qui est complété avec Tab

- Hostnames des postes (`console`, `ssh`, `devices show`, `compliance show`, `scripts run/exec`, `alerts snooze`, `apps deploy --device`)
- Noms de scripts (`scripts run`, `scripts exec`)
- Noms de packages (`apps deploy`)
- IDs de tickets (`tickets show`, `comment`, `update`, `close`)
- IDs de tokens (`tokens revoke`)
- Valeurs de flags (`--status`, `--priority`, `--type`, etc.)

---

## Exemples combinés

```bash
# Diagnostiquer un poste critique
opale devices show BGD
opale compliance show BGD
opale scripts run BGD "Statut Windows Defender"

# Traiter un ticket depuis le terminal
opale tickets ls
opale tickets show fb4884fb
opale tickets comment fb4884fb "Connexion console pour vérification"
opale console BGD --category troubleshoot --note "Ticket fb4884fb"
opale tickets close fb4884fb

# Déployer et suivre
opale apps deploy RStudio DESKTOP-03RUSF2 LLZ MJT-2
opale apps deployments --status pending
# ... attendre ...
opale apps deployments --status failed
opale apps retry <deployment-id>

# Snooze des alertes disque le temps d'un nettoyage
opale alerts ls
opale alerts snooze BGD --type disk_critical --days 14 --reason "Migration données en cours"

# Utiliser avec jq pour du scripting
opale devices ls --json | jq '[.[] | select(.status == "critical") | .hostname]'
opale compliance ls --json | jq '[.[] | select(.fail > 10)]'
```
