# Privacy & RGPD — Considérations génériques

> **Document générique** à destination des organisations françaises ou
> européennes qui déploient Opale. Il décrit la nature des données
> collectées, les obligations RGPD applicables, et les éléments à
> documenter au registre de traitement de votre organisation.
>
> **Ce document n'est pas un avis juridique.** Validez votre déploiement
> avec votre DPO ou un conseil compétent. Les sections marquées
> [À ADAPTER] contiennent des exemples de phrasing à personnaliser.

---

## 1. Finalité du traitement

Opale est un outil de gestion de parc informatique à usage strictement
interne à une organisation. Il collecte des données techniques sur les
postes Windows managés afin de :

- Surveiller l'état de santé du parc (disques, RAM, OS, réseau)
- Déployer des logiciels et scripts à distance
- Gérer les tickets de support IT
- Journaliser les accès et actions des administrateurs IT

**Base légale habituelle :** intérêt légitime de l'employeur (gestion et
sécurité du système d'information, art. 6.1.f RGPD). Cette base doit être
documentée dans votre registre des traitements et faire l'objet d'un test
de mise en balance (intérêt vs. droits des personnes concernées).

> [À ADAPTER] Si votre organisation supervise des bénévoles, des
> stagiaires, ou des postes BYOD, l'analyse change : intérêt légitime ne
> suffit plus, vous aurez besoin de consentement éclairé ou d'une autre
> base légale dédiée. Une **analyse d'impact (DPIA)** est probablement
> obligatoire dans ce cas (art. 35 RGPD).

---

## 2. Données collectées

### 2.1 Données personnelles directes

| Table | Champs | Sensibilité | Source |
|---|---|---|---|
| `users_cache` | email, display_name, job_title, department | Moyenne | Microsoft Entra ID |
| `onboardings` | person_name, email, role, contract_type, start_date, end_date | **Élevée** (RH) | Saisie manuelle |
| `ticket_messages` | content (libre) | Variable | Saisie manuelle |

### 2.2 Identifiants pseudonymes

| Table | Champs | Remarque |
|---|---|---|
| `devices` | hostname | Souvent contient le nom (ex: `prenom-laptop`) |
| `network_interfaces` | mac | Identifiant unique stable de l'équipement |
| `devices` | intune_user_id, intune_device_id, aad_device_id | IDs Microsoft — pseudonymes mais traçables |
| `ssh_keys` | public_key | Identifie un accès SSH nominatif |

### 2.3 Données de comportement réseau

| Table | Champs | Granularité | Sensibilité |
|---|---|---|---|
| `bandwidth_stats` | bytes_sent, bytes_recv par adaptateur | toutes les 15 min | Moyenne — patterns d'usage déductibles |
| `ping_stats` | latency_ms, packet_loss_pct | toutes les 15 min | Faible |
| `system_perf_stats` | cpu, ram, batterie, uptime | toutes les 15 min | Faible |

### 2.4 Journaux de surveillance — point sensible

| Table | Contenu | Risque légal |
|---|---|---|
| `remote_sessions` | Qui accède à quel poste, par quel transport (SSH ou console-via-agent), depuis quelle IP, durée | **Élevé** — voir §4.1 |
| `remote_session_logs` | Contenu intégral du terminal (stdin + stdout + stderr) capturé pendant la session, en frames timestampées | **Très élevé** — voir §4.7 |
| `audit_logs` | Toutes les actions admin (action, by_user, target) | Moyen |
| `script_executions` | Qui a lancé quel script, sur quel poste, output complet | **Élevé** — output peut contenir des données personnelles |
| `device_admin_credentials` | Mot de passe local recovery (chiffré RSA-OAEP) + journal des consultations | Élevé |

Les ouvertures et fermetures de console-via-agent (transport
`agent_console`) sont en plus tracées dans `audit_logs` sous les actions
`agent_console_open`, `agent_console_close`, `agent_console_takeover`,
ainsi que les événements de cycle de vie du tube WS persistant
(`agent_ws_connect`, `agent_ws_disconnect`).

### 2.5 Données système relevées par l'agent

`devices.health_signals` (BitLocker, Defender, firewall, TPM, reboot
pending, dernier Windows Update) et `devices.system_info` (CPU, GPU,
batterie, mainboard, monitors) contiennent en outre :

- `system_info.current_user` — **identifiant nominatif** du dernier
  utilisateur loggué localement (NULL si personne, ou si session RDP
  uniquement). À traiter comme une donnée personnelle (limiter
  l'affichage aux administrateurs).

---

## 3. Ce qui n'est **pas** collecté

Opale ne collecte ni ne transmet :

- ❌ Contenu des fichiers sur les postes
- ❌ Historique de navigation
- ❌ Frappes clavier ou captures d'écran
- ❌ Contenu des emails ou messages
- ❌ Localisation GPS
- ❌ Données biométriques (sauf déverrouillage local de la PWA, qui
  n'est pas transmis au serveur — voir §6.2)

Ne pas ajouter ces collectes sans analyse légale approfondie et DPIA.

---

## 4. Points d'attention juridiques

### 4.1 Surveillance des accès distants (SSH + console-via-agent) — droit français

`remote_sessions` journalise chaque ouverture de session d'accès distant
sur un poste, quel que soit le transport :

- `transport = 'ssh'` : tunnel SSH via Netbird vers un compte local
  (administrateur local mais **pas SYSTEM**).
- `transport = 'agent_console'` : ConPTY spawné par l'agent Go, qui
  tourne lui-même en **SYSTEM**. Le scope d'exécution est donc plus
  large que SSH : un admin peut écrire dans `HKLM`, modifier des
  services système, accéder à toute la base de registre, etc.

En droit français, toute surveillance des salariés sur leurs outils de
travail est soumise à **information préalable obligatoire** (art.
L.1222-4 du Code du travail).

**Obligations :**

- Les utilisateurs doivent être informés de la possibilité d'accès à
  distance à leur poste **avant** qu'il soit effectué — la console
  servie par l'agent rentre dans le même cadre que SSH.
- La finalité affichée doit être la **sécurité IT** et le **support**,
  jamais le contrôle de l'activité individuelle.
- Si votre organisation a un CSE, il doit être informé/consulté sur la
  mise en place de l'outil.

**Mitigations techniques en place :**

- **Capture du contenu du terminal** : depuis 2026-05, le contenu intégral
  des sessions (stdin + stdout) est capturé dans `remote_session_logs`
  pour faire foi en cas d'incident ou de contestation. Cette capture est
  un traitement à part — voir §4.7 pour le cadre détaillé.
- **Toast OS côté utilisateur** : lors d'une ouverture de console-via-
  agent, l'agent envoie un `msg.exe *` à la session interactive de
  l'utilisateur pour l'informer immédiatement (visible sur Windows Pro
  et Enterprise ; non disponible sur Home, qui n'est pas un OS cible
  fleet).
- **Audit complet** : `agent_console_open`, `agent_console_close`,
  `agent_console_takeover` dans `audit_logs`.
- **Une seule session active par poste** ; toute éviction est tracée
  via la colonne `remote_sessions.takeover_of`.

**À implémenter côté instance :**

- Bandeau d'information dans l'UI avant toute connexion (SSH ou
  console-via-agent).
- Mention dans la **charte informatique** signée par les utilisateurs,
  en distinguant explicitement la console SYSTEM du SSH classique si
  votre analyse de risque le justifie.

### 4.2 Durées de conservation

Le RGPD exige que les données ne soient conservées que le temps
nécessaire à la finalité (art. 5.1.e). Aucune table d'Opale n'a
aujourd'hui de purge automatique livrée. Vous devez en mettre une en
place.

**Durées recommandées (à valider par votre DPO) :**

| Table | Durée recommandée | Justification |
|---|---|---|
| `bandwidth_stats` | 30 jours | Données opérationnelles, pas d'historique long nécessaire |
| `ping_stats` | 30 jours | Idem |
| `system_perf_stats` | 7 jours | Déjà purgé automatiquement par l'agent (cf. agent-go) |
| `remote_sessions` | 6 mois | Recommandation CNIL pour logs de sécurité (couvre SSH + console-via-agent) |
| `remote_session_logs` | 30 jours | Contenu très sensible (mots de passe affichés, données users) — rétention courte par défaut, voir §4.7 |
| `audit_logs` | 12 mois | Délibération CNIL n°2017-012 (logs cybersécurité) |
| `script_executions` | 3 mois | Output peut contenir des données sensibles |
| `users_cache` | Purge si compte SSO désactivé + 30 jours | Droit à l'effacement |
| `onboardings` | 2 ans après date de fin | Données RH |

**Comment implémenter :** un job `pg_cron` ou un cron système qui exécute
des `DELETE` paramétrés. Exemple :

```sql
DELETE FROM bandwidth_stats WHERE created_at < now() - interval '30 days';
DELETE FROM ping_stats      WHERE created_at < now() - interval '30 days';
DELETE FROM remote_sessions WHERE started_at < now() - interval '6 months';
-- etc.
```

### 4.3 Output des scripts PowerShell

`script_executions.output` stocke le résultat brut des scripts exécutés.
Si un script liste des fichiers, des utilisateurs ou des configurations,
l'output peut contenir des données personnelles.

**Recommandations :**

- Limiter l'output stocké à 10 000 caractères max (déjà géré par la
  migration `018_script_executions_output_limit.sql`).
- Ne jamais distribuer aux opérateurs des scripts qui capturent
  intentionnellement des données personnelles (emails, fichiers
  personnels, etc.).
- Un avertissement est affiché dans l'UI lors de la création d'un script.

### 4.4 Adresses MAC

Les MAC sont des identifiants persistants liés à un équipement (et
indirectement à une personne). Stockées dans `network_interfaces` sans
purge dédiée. Elles sont supprimées en cascade lors de la suppression
du device (`ON DELETE CASCADE`) — assurez-vous que les devices retirés
du parc sont bien supprimés (procédure de sortie).

### 4.5 Hostname contenant un nom propre

Des hostnames comme `prenom-Laptop-...` identifient directement une
personne. Cette donnée est collectée automatiquement par Windows.

**À documenter** dans la charte IT comme donnée collectée. Pas de remède
technique automatique côté Opale.

### 4.6 Compte recovery local (LAPS-like)

`device_admin_credentials` stocke le mot de passe d'un compte local
recovery, chiffré côté agent en RSA-OAEP-SHA256. La clé privée
(`agent-go/keys/laps.key`) doit être protégée comme un secret de niveau
haut : son exposition permettrait de déchiffrer tous les mots de passe
recovery historiques et présents.

**Bonnes pratiques :**

- Backup chiffré séparé de la clé privée.
- Audit régulier des consultations (`audit_logs.action = 'laps_viewed'`).
- Le journal `last_viewed_by` permet de tracer qui a vu quel mot de
  passe et quand.

### 4.7 Logs des sessions remote (`remote_session_logs`)

Depuis 2026-05, le contenu intégral des sessions remote (SSH + console-
via-agent) est capturé pour répondre aux exigences de traçabilité en cas
d'incident, de contestation, ou d'audit interne. Chaque session produit
une row JSONB contenant les frames timestampées dans les deux directions
(`in` = ce que l'admin a tapé, `out` = ce que le poste a affiché).

**Nature des données capturées — sensibilité très élevée :**

- Tout ce qu'affiche le terminal : sortie de commandes, contenu de
  fichiers consultés (`cat`, `Get-Content`, `type`), listing
  d'utilisateurs (`net user`, `Get-LocalUser`), variables d'environnement
  pouvant contenir des secrets.
- En `agent_console`, le shell tourne en SYSTEM : la sortie peut
  refléter des données de TOUTES les sessions interactives sur le poste,
  pas seulement de l'admin.
- Mots de passe affichés à l'écran (sortie volontaire ou involontaire
  d'une commande) sont capturés.
- Frappes au clavier capturées en clair en `in`. Note : un mot de passe
  tapé dans un prompt qui désactive l'écho (sudo, ssh, Read-Host
  -AsSecureString) reste capturé en `in` même s'il n'apparaît pas en
  `out`. **C'est techniquement un keylogger côté admin** — pas côté
  user du poste, mais côté admin IT lorsqu'il opère le terminal.

**Cadre légal :**

- L'admin IT qui opère est lui-même un salarié soumis à la même
  obligation d'information préalable (art. L.1222-4) — la capture de
  ses sessions de travail doit figurer dans la charte IT et dans
  l'avenant SI au règlement intérieur des admins.
- Le poste cible est un poste user : la capture peut révéler des
  données personnelles d'un tiers (le user du poste) si l'admin
  consulte des fichiers ou des sessions actives. La base légale reste
  l'intérêt légitime sécurité IT, mais doit être proportionnée — éviter
  les sessions exploratoires non motivées par un incident.

**Mitigations techniques en place :**

- **Caps stricts** : 10 000 frames OU 5 MB d'octets bruts par session ;
  au-delà, `truncated=true` et la capture s'arrête (la session continue
  de fonctionner normalement, seul le buffer cesse de grossir).
- **Buffer mémoire, flush unique en fin de session** : si l'API crash
  pendant la session, le log est perdu (acceptable — on ne tient pas
  un journal "résistant" à dessein).
- **Rétention 30 jours** (vs. 6 mois pour `remote_sessions`) : la fenêtre
  est volontairement courte par rapport à la durée des métadonnées,
  pour limiter l'exposition au strict nécessaire à l'investigation
  post-incident immédiat.
- **Accès admin uniquement** : la consultation se fait via une route
  protégée par `requireAdmin` (ajoutée dans une PR ultérieure).
- **Cascade** : `ON DELETE CASCADE` depuis `remote_sessions` — supprimer
  une session supprime son log.

**À implémenter côté instance :**

- Information explicite des admins IT dans la charte (capture de leurs
  propres sessions opérationnelles).
- Procédure d'accès aux logs : qui peut les consulter, sous quelles
  conditions (typiquement post-incident uniquement, journalisé dans
  `audit_logs`).
- Si la rétention 30 jours ne convient pas (réglementaire sectoriel
  imposant plus long, ou DPO préférant moins), ajuster `RULES` dans
  `api/plugins/cleanup.js`.

---

## 5. Droits des personnes concernées

Les personnes dont les données sont traitées (utilisateurs des postes
managés) disposent des droits RGPD suivants. Aujourd'hui Opale ne
fournit **pas d'interface self-service** pour leur exercice — ils
s'exercent par demande à l'administrateur ou au DPO.

| Droit | Comment l'exercer |
|---|---|
| Accès | Demande au responsable IT — extraction manuelle |
| Rectification | Via l'admin IT, sur les champs saisis manuellement |
| Effacement | Suppression du device (cascade) + purge dans `users_cache` |
| Opposition | Limité — le monitoring est lié à l'usage du SI de l'organisation |
| Portabilité | Sans objet (données techniques, pas de format échangeable standard) |

> [À ADAPTER] Documentez clairement le **point de contact** (DPO,
> responsable IT) dans votre charte informatique et dans l'éventuel
> avenant SI au règlement intérieur.

---

## 6. Mesures de sécurité (annexe au registre)

### 6.1 Mesures techniques en place

- Authentification SSO via IdP (Microsoft Entra par défaut, abstraction
  prévue pour OIDC/SAML)
- Tokens d'agent stockés en SHA-256 (jamais en clair en base)
- TLS strict (l'agent refuse `InsecureSkipVerify`)
- Mises à jour de l'agent vérifiées par signature ed25519
- Mots de passe recovery chiffrés RSA-OAEP côté endpoint avant transit
- Journalisation des actions admin dans `audit_logs`

### 6.2 Verrou biométrique de la PWA

L'interface mobile peut être verrouillée par WebAuthn (Touch ID, Face
ID, etc.). La biométrie est **traitée localement** par le système
d'exploitation du terminal — Opale ne reçoit qu'une **assertion
cryptographique** (signature challenge/response). Aucune donnée
biométrique n'atteint le serveur.

### 6.3 Mesures organisationnelles à mettre en place côté instance

- [À ADAPTER] Désigner un référent RGPD pour l'outil (souvent le DPO
  ou le RSI).
- [À ADAPTER] Inscrire Opale au **registre des activités de
  traitement** de votre organisation (responsable, finalités, base
  légale, catégories de données, durées, destinataires, mesures de
  sécurité).
- [À ADAPTER] Mettre à jour la **charte informatique** : monitoring du
  parc, accès SSH distants, scripts à distance, journalisation.
- [À ADAPTER] Si applicable : information/consultation du **CSE**.
- [À ADAPTER] Si périmètre étendu (bénévoles, BYOD, données de santé) :
  réaliser une **DPIA**.

---

## 7. Sous-traitants et flux transfrontaliers

Le déploiement d'Opale s'appuie par défaut sur Microsoft Entra ID
et Microsoft Intune (cf. [docs/CONFIGURATION.md](CONFIGURATION.md)).

Microsoft est un sous-traitant au sens RGPD. À documenter :

- **DPA** (Data Processing Agreement) avec Microsoft — disponible via
  le Microsoft Trust Center.
- **Localisation des données Entra/Intune** — vérifier la région
  configurée pour votre tenant (Europe, États-Unis, etc.).
- **Décisions d'adéquation et clauses contractuelles types** pour les
  flux hors UE (cf. décision *Data Privacy Framework* CE 2023-1795).

> [À ADAPTER] Si votre PostgreSQL est hébergé chez un cloud provider
> (AWS, Azure, GCP, OVH, Scaleway, …), même obligation : DPA + analyse
> de localisation. Si hébergement on-prem ou chez un hébergeur français,
> la situation se simplifie.

---

## 8. Checklist de conformité (résumé opérationnel)

À cocher avant mise en production élargie :

- [ ] Inscription au registre des traitements
- [ ] Charte informatique mise à jour et signée
- [ ] Information CSE le cas échéant
- [ ] Job de purge automatique configuré (§4.2)
- [ ] Bandeau d'information accès distants (SSH + console-via-agent) dans l'UI (§4.1)
- [ ] DPA Microsoft signé et archivé
- [ ] Backup chiffré de `agent-go/keys/laps.key` (§4.6)
- [ ] DPO identifié, point de contact documenté

---

## 9. Mises à jour de ce document

Ce document évolue avec le code. À chaque changement de schéma DB
significatif (nouvelles tables, nouvelles colonnes contenant des données
personnelles), une PR doit mettre à jour les sections §2 et §4.
