# Audit code mort — CSS classes + clés i18n (2026-05-14)

## TL;DR

- **CSS** : 418 classes définies. 62 sans aucune référence dans `front/**/*.{js,html}`.
  Après analyse manuelle des faux positifs : **50 LIKELY DEAD**, **12 NEEDS REVIEW**.
- **Locales** : 861 clés dans `fr.js`. 103 sans appel `t('key')` direct.
  Après détection des patterns dynamiques : **56 LIKELY DEAD**, **47 NEEDS REVIEW**.

## Méthodologie

### CSS classes

1. Extraction des noms de classes depuis `front/styles/main.css` et `front/styles/mobile.css` :
   ```
   grep -oE '^\s*\.[a-zA-Z_][a-zA-Z0-9_-]*' front/styles/*.css | awk -F'.' '{print $NF}'
   ```

2. Pour chaque classe, recherche dans tous les fichiers `front/**/*.{js,html}` (styles exclus) :
   - `class="... X ..."` (attribut HTML)
   - `classList.add/toggle/remove('X')`
   - `className = '... X ...'`
   - Template strings `` `class="X"` ``
   
   Grep utilisé : `grep -rF "${CLASS}" front/ --include='*.js' --include='*.html'`

3. Classes avec 0 résultat → candidate. Vérification manuelle du contexte CSS pour les
   state modifiers et les patterns dynamiques (`el.className = \`prefix-\${state}\``).

### Clés locale

1. Extraction des clés depuis `front/locales/fr.js` :
   ```
   grep -oE "^\s*'[^']+'" front/locales/fr.js | sed "s/[^']*'//" | sed "s/'.*//"
   ```

2. Pour chaque clé, deux passes :
   - Grep direct : `t('key')` et `t("key")` avec éventuels arguments supplémentaires
   - Grep large : toute occurrence littérale de la clé hors répertoire `locales/`
     (détecte les affectations du type `const k = 'key'; t(k)`)

3. Vérification manuelle des patterns dynamiques :
   - Concaténation : `t('prefix.' + variable)`
   - Ternaire/variable : `const key = cond ? 'key.a' : 'key.b'; t(key)`

**Conservatisme appliqué** : tout doute → `NEEDS REVIEW`. Les faux positifs (supprimer à tort)
sont bien plus graves que les faux négatifs (garder des clés inutilisées).

---

## CSS classes — candidates suppression

### LIKELY DEAD (suggested for deletion) — 50 classes

#### front/styles/main.css

| Classe | Fichier:ligne | Note |
|---|---|---|
| `check-ico` | `front/styles/main.css:404` | Ancienne implémentation checklist, remplacée par `ob-check-*` |
| `check-text` | `front/styles/main.css:413` | Idem |
| `checklist-row` | `front/styles/main.css:399` | Idem |
| `dot-w` | `front/styles/main.css:342` | Variante amber du dot de statut — `dot-on/off/crit` utilisés, pas `dot-w` |
| `notif-dot` | `front/styles/main.css:222` | Notif button sans dot dans le template dashboard actuel |
| `onboard-fill` | `front/styles/main.css:416` | Progress bar onboarding — remplacée par `ob-check-*` |
| `onboard-progress` | `front/styles/main.css:415` | Idem |
| `ssh-btn` | `front/styles/main.css:346` | Bouton SSH inline sur asset-row — supprimé du template |
| `stock-actions` | `front/styles/main.css:389` | Ancienne vue stock card-based, remplacée par table |
| `stock-info` | `front/styles/main.css:385` | Idem |
| `stock-name` | `front/styles/main.css:386` | Idem |
| `stock-qty` | `front/styles/main.css:388` | Idem |
| `stock-row` | `front/styles/main.css:380` | Idem |
| `th-sorted` | `front/styles/main.css:494` | Sélecteur `.th-sorted .sort-icon` — le code `reseau.js` applique `.sorted` (sans préfixe `th-`) |

#### front/styles/mobile.css

| Classe | Fichier:ligne | Note |
|---|---|---|
| `m-back-btn` | `front/styles/mobile.css:66` | Bouton retour — les vues utilisent `m-icon-btn` + `history.back()` |
| `m-badge` | `front/styles/mobile.css:168` | Base badge — remplacée par `m-pill` dans les vues |
| `m-badge-amber` | `front/styles/mobile.css:170` | Idem |
| `m-badge-blue` | `front/styles/mobile.css:169` | Idem |
| `m-badge-gray` | `front/styles/mobile.css:172` | Idem |
| `m-badge-green` | `front/styles/mobile.css:171` | Idem |
| `m-badge-red` | `front/styles/mobile.css:173` | Idem |
| `m-chat-area` | `front/styles/mobile.css:261` | Vue chat jamais implémentée dans les vues mobiles |
| `m-chat-footer` | `front/styles/mobile.css:266` | Idem |
| `m-chat-input` | `front/styles/mobile.css:271` | Idem |
| `m-chat-send` | `front/styles/mobile.css:275` | Idem |
| `m-disk-letter` | `front/styles/mobile.css:219` | Ancienne table disques — `poste.js` utilise `m-disk-bar` directement sans `m-disk-row` |
| `m-disk-pct` | `front/styles/mobile.css:222` | Idem |
| `m-disk-row` | `front/styles/mobile.css:218` | Idem |
| `m-disk-size` | `front/styles/mobile.css:223` | Idem |
| `m-form-group` | `front/styles/mobile.css:323` | Aucune vue mobile n'utilise `m-form-*` — les formulaires utilisent `m-label`+`m-input` |
| `m-form-hint` | `front/styles/mobile.css:330` | Idem |
| `m-form-input` | `front/styles/mobile.css:325` | Idem |
| `m-form-label` | `front/styles/mobile.css:324` | Idem |
| `m-header-actions` | `front/styles/mobile.css:73` | Les vues utilisent `m-header` + boutons inline, pas `m-header-actions` |
| `m-header-sub` | `front/styles/mobile.css:64` | Idem |
| `m-hw-label` | `front/styles/mobile.css:215` | Panel hardware mobile non implémenté — `poste.js` utilise `m-panel` |
| `m-hw-panel` | `front/styles/mobile.css:212` | Idem |
| `m-hw-row` | `front/styles/mobile.css:214` | Idem |
| `m-hw-title` | `front/styles/mobile.css:213` | Idem |
| `m-hw-val` | `front/styles/mobile.css:216` | Idem |
| `m-menu-item` | `front/styles/mobile.css:283` | `menu.js` utilise `m-menu-tile` et `m-menu-row`, pas `m-menu-item` |
| `m-msg-in` | `front/styles/mobile.css:264` | Vue chat mobile jamais implémentée |
| `m-msg-out` | `front/styles/mobile.css:265` | Idem |
| `m-settings-group` | `front/styles/mobile.css:293` | `settings.js` utilise `m-panel`/`m-panel-header`, pas `m-settings-*` |
| `m-settings-row` | `front/styles/mobile.css:294` | Idem |
| `m-settings-row-val` | `front/styles/mobile.css:299` | Idem |
| `m-sheet-body` | `front/styles/mobile.css:319` | Bottom sheet utilise uniquement `m-sheet-handle` + `m-sheet-title` |
| `m-sheet-btn-ghost` | `front/styles/mobile.css:338` | Idem |
| `m-sheet-btn-primary` | `front/styles/mobile.css:337` | Idem — les boutons utilisent `m-btn-primary` |
| `m-sheet-footer` | `front/styles/mobile.css:320` | Idem |
| `m-ssh-conn` | `front/styles/mobile.css:232` | Ancienne version SSH — `ssh.js` utilise `m-ssh-status`, pas `m-ssh-conn` |
| `m-ssh-kbd-btn` | `front/styles/mobile.css:245` | Ancienne version SSH — `ssh.js` utilise `m-ssh-key-btn`, pas `m-ssh-kbd-btn` |
| `m-ssh-kbd-btns` | `front/styles/mobile.css:245` | Idem |
| `m-ssh-output` | `front/styles/mobile.css:235` | Ancienne version SSH — `ssh.js` utilise `m-ssh-out`, pas `m-ssh-output` |
| `m-ticket-card` | `front/styles/mobile.css:159` | `tickets.js` utilise `m-device-card`, pas `m-ticket-card` |
| `m-ticket-meta` | `front/styles/mobile.css:165` | Idem |
| `m-ticket-title` | `front/styles/mobile.css:164` | Idem |

### NEEDS REVIEW (12 classes — ambigu ou state modifier dynamique)

| Classe | Fichier:ligne | Pourquoi ambigu |
|---|---|---|
| `toast-error` | `front/styles/main.css:613` | Appliqué dynamiquement : `el.className = \`toast toast-\${type}\`` dans `app.js`. Type `"error"` possible. |
| `toast-info` | `front/styles/main.css:614` | Idem — type `"info"`. |
| `toast-success` | `front/styles/main.css:612` | Idem — type `"success"`. |
| `ssh-status-connecting` | `front/styles/main.css:678` | Appliqué dynamiquement : `el.className = \`ssh-status \${'ssh-status-' + state}\`` dans `poste.js`. État `"connecting"` possible. |
| `ssh-status-error` | `front/styles/main.css:679` | Idem — état `"error"`. |
| `ssh-status-ok` | `front/styles/main.css:677` | Idem — état `"ok"`. |
| `m-msg-time` | `front/styles/mobile.css:262` | Défini deux fois (l.262 chat + l.470 messages) — l.470 est utilisé dans le thread ticket. La règle l.262 peut être vestige. |
| `m-msg` | `front/styles/mobile.css:263` | Idem contexte dual-definition — vérifier lequel des deux blocs est actif. |
| `m-msg-bubble` | `front/styles/mobile.css:462` | Messages thread ticket — `ticket.js` utilise `.m-msg-bubble` (vérifier). |
| `m-msg-bubble-me` | `front/styles/mobile.css:466` | Idem. |
| `m-msg-me` | `front/styles/mobile.css:461` | Idem. |
| `m-msg-content` | `front/styles/mobile.css:468` | Idem. |

> **Note sur les `m-msg-*`** : il y a deux blocs de styles pour les messages dans `mobile.css` —
> le premier bloc (l.261–275) pour une vue chat jamais implémentée, et le second (l.460–471) pour
> le thread ticket. Le second bloc est probablement actif. Ces 6 classes méritent une vérification
> dans `front/views/mobile/ticket.js`.

---

## Clés i18n — candidates suppression

### LIKELY DEAD (56 clés) — aucun appelant direct, pas de pattern dynamique détecté

#### Groupe nav — navigation hardcodée en HTML dans `index.html`

| Clé | Valeur FR | Note |
|---|---|---|
| `nav.alertes` | "Alertes" | `index.html` utilise du texte brut, pas `t()` |
| `nav.dashboard` | "Dashboard" | Idem |
| `nav.onboarding` | "Onboarding" | Idem |
| `nav.parametres` | "Paramètres" | Idem |
| `nav.rapports` | "Rapports" | Idem |
| `nav.reseau` | "Réseau" | Idem |
| `nav.scripts` | "Scripts" | Idem |
| `nav.stock` | "Stock consommable" | Idem |
| `nav.tickets` | "Tickets" | Idem |

#### Groupe postes — table headers + filtres hardcodés dans `postes.js`

| Clé | Valeur FR | Note |
|---|---|---|
| `postes.col.disk` | "Disque C:" | En-tête `<th>` hardcodé dans `postes.js` |
| `postes.col.last` | "Dernier push" | Idem |
| `postes.col.model` | "Modèle" | Idem — colonne Modèle absente de l'UI actuelle |
| `postes.col.name` | "Nom" | Idem |
| `postes.col.os` | "OS" | Idem — colonne OS absente de l'UI actuelle |
| `postes.col.ram` | "RAM" | Idem — colonne RAM absente de l'UI actuelle |
| `postes.col.status` | "Statut" | Idem |
| `postes.col.user` | "Utilisateur" | Idem |
| `postes.filter.all` | "Tous" | Filtre hardcodé dans `postes.js` |
| `postes.filter.critical` | "⚠ Disque critique" | Idem |
| `postes.filter.offline` | "Hors ligne" | Idem |
| `postes.filter.online` | "En ligne" | Idem |
| `postes.filter.unassigned` | "Non assignés" | Idem |
| `postes.sort.disk` | "Trier : Disque" | Tri hardcodé |
| `postes.sort.last` | "Trier : Dernière activité" | Idem |
| `postes.sort.name` | "Trier : Nom" | Idem |
| `postes.sort.user` | "Trier : Utilisateur" | Idem |
| `postes.title` | "Postes" | Titre hardcodé |
| `postes.unassigned` | "Non assigné" | Aucun appelant |

#### Groupe dashboard — KPIs/sections restructurés

| Clé | Valeur FR | Note |
|---|---|---|
| `dashboard.alerts` | "Alertes récentes" | Section renommée — `dashboard.js` utilise `dashboard.unhealthy.title` |
| `dashboard.empty.alerts` | "Aucune alerte active" | Empty state alertes absent du dashboard actuel |
| `dashboard.empty.devices` | "Aucun poste enregistré" | Idem |
| `dashboard.kpi.alerts_sub` | "{n} disques critiques" | Remplacé par `dashboard.kpi.alerts_sub_action` |
| `dashboard.kpi.tickets` | "Tickets ouverts" | Aucun appelant direct (la clé `dashboard.kpi.proposals` est utilisée à la place) |
| `dashboard.kpi.tickets_sub` | "sur {n} postes" | Idem |

#### Groupe audit — actions et colonnes non utilisées dans `audit.js`

| Clé | Valeur FR | Note |
|---|---|---|
| `audit.action.admin_granted` | "admin_granted" | Valeur FR = slug technique — jamais appelée |
| `audit.action.admin_revoked` | "admin_revoked" | Idem |
| `audit.action.agent_checkin` | "agent_checkin" | Idem |
| `audit.action.intune_sync` | "intune_sync" | Idem |
| `audit.action.setup_script` | "setup_script" | Idem |
| `audit.action.token_created` | "token_created" | Idem |
| `audit.action.token_revoked` | "token_revoked" | Idem |
| `audit.filter.all_actions` | "Toutes les actions" | Filtre catégorie utilise `<option value="">` sans traduction |
| `settings.audit.col.action` | "Action" | Colonnes hardcodées dans le template audit |
| `settings.audit.col.by` | "Par" | Idem |
| `settings.audit.col.date` | "Date" | Idem |
| `settings.audit.col.target` | "Cible" | Idem |
| `settings.audit.empty` | "Aucune entrée" | `audit.js` utilise `audit.empty` à la place |

#### Groupe boutons génériques — non implémentés

| Clé | Valeur FR | Note |
|---|---|---|
| `btn.add` | "Ajouter" | Aucun appelant dans `front/**/*.js` |
| `btn.export_csv` | "Exporter CSV" | Idem — export CSV non implémenté côté front |
| `btn.ssh` | "SSH" | Idem |

#### Groupe alertes — section snoozée et sous-titre

| Clé | Valeur FR | Note |
|---|---|---|
| `alertes.snoozed_section` | "Alertes snoozées" | Aucun appelant — la section snoozée utilise du HTML inline |

#### Groupe onboarding mobile et desktop

| Clé | Valeur FR | Note |
|---|---|---|
| `mobile.onboarding.steps` | "Étapes" | Le code utilise `mobile.onboarding.steps_done` (avec suffixe), pas cette clé |

#### Groupe scripts

| Clé | Valeur FR | Note |
|---|---|---|
| `scripts.run.hint` | "Seuls les postes avec une IP Netbird sont listés." | Aucun appelant dans `scripts.js` ou ailleurs |

#### Groupe tickets — colonnes info

| Clé | Valeur FR | Note |
|---|---|---|
| `tickets.info.hostname` | "Nom" | `tickets.js` utilise `tickets.info.details/created/by/assignee/requester` mais pas `hostname` ni `user` |
| `tickets.info.user` | "Utilisateur" | Idem |

#### Groupe error

| Clé | Valeur FR | Note |
|---|---|---|
| `error.network` | "Erreur réseau" | `error.generic` et `error.forbidden` utilisés — `error.network` jamais appelé |

### NEEDS REVIEW (47 clés — construites dynamiquement, à garder sauf invalidation)

#### `dashboard.activity.action.*` — 20 clés (dynamique confirmé)

Pattern : `t('dashboard.activity.action.' + r.action)` dans `front/views/dashboard.js:L?`.
Les 20 clés de ce groupe sont toutes potentiellement actives selon les valeurs de `r.action`
retournées par l'API.

| Préfixe | Nombre de clés |
|---|---|
| `dashboard.activity.action.*` | 20 |

Liste : `admin_granted`, `admin_revoked`, `agent_bootstrap_exchange`, `agent_console_close`,
`agent_console_open`, `agent_console_takeover`, `compliance_changed`, `device_deleted`,
`intune_force_sync`, `intune_sync`, `laps_rotated`, `package_deployed`, `rmm_force_checkin`,
`script_executed_remote`, `ssh_close`, `ssh_open`, `tamper_detected`, `token_created`,
`token_revoked`, `token_rotated`.

> Certaines de ces valeurs d'action (ex. `agent_bootstrap_exchange`) peuvent ne plus être
> générées par l'API. À vérifier côté DB : `SELECT DISTINCT action FROM audit_log`.

#### `alertes.section.*` — 4 clés (dynamique confirmé)

Pattern : `t('alertes.section.' + s.key)` dans `front/views/alertes.js`.
Valeurs connues de `s.key` : `disk_critical`, `disk_warn`, `non_compliant`, `offline`.

#### `alertes.snooze.preset.*` — 5 clés (dynamique confirmé)

Pattern : `t('alertes.snooze.preset.' + d + 'd')` dans `front/views/alertes.js`.
Valeurs de `d` : `[1, 3, 7, 14, 30]` → clés `1d`, `3d`, `7d`, `14d`, `30d`.

#### `rapports.compliance.row.*` — 6 clés (dynamique confirmé)

Pattern : `t('rapports.compliance.row.' + c.key)` dans `front/views/rapports.js` et
`front/views/mobile/rapports.js`.
Valeurs possibles de `c.key` selon API : `bitlocker`, `defender`, `firewall`, `reboot`, `tpm`, `update`.

#### `tickets.filter.*` — 4 clés (dynamique confirmé)

Pattern : `t('tickets.filter.' + s)` dans `front/views/tickets.js`.
Valeurs de `s` : `all`, `open`, `in_progress`, `resolved`.

#### `onboarding.filter.*` — 4 clés (dynamique confirmé)

Pattern : `t('onboarding.filter.' + f)` dans `front/views/onboarding.js`.
Valeurs de `f` : `all`, `onboard`, `offboard`, `done`.

#### `mobile.postes.bulk.toast.checkin_ok`, `mobile.postes.bulk.toast.sync_ok` — 2 clés (dynamique confirmé)

Pattern : `t('mobile.postes.bulk.toast.' + kind + '_ok')` dans `front/views/mobile/postes.js`.
Valeurs de `kind` : `checkin`, `sync`.

#### `status.critical`, `status.warn` — 2 clés (dynamique confirmé)

Pattern indirect : `t('status.' + deviceStatus(d))` dans `front/views/user.js`.
`deviceStatus()` retourne `'online' | 'offline' | 'critical' | 'warn'`.
`status.online` et `status.offline` ont des appelants directs ailleurs, pas `critical`/`warn`.

---

## Suite proposée

1. **Clément revoit ce rapport** et coche/décoche les items à supprimer (édition manuelle du fichier
   ou commentaires sur la PR).

2. Pour les `dashboard.activity.action.*` (NEEDS REVIEW) : un `SELECT DISTINCT action FROM audit_log`
   sur la prod peut confirmer lesquelles sont réellement générées. Les clés sans valeur DB peuvent
   passer en LIKELY DEAD.

3. **PR follow-up** `chore(front): supprimer N classes CSS + M clés locales mortes` fait les
   suppressions dans `front/styles/*.css` et `front/locales/fr.js` + `front/locales/en.js` (synchrone).

4. Ce rapport reste dans `docs/history/` comme trace d'audit (utile pour expliquer rétrospectivement
   pourquoi une classe/clé a été supprimée).

---

*Audit réalisé le 2026-05-14. Méthode : grep multi-pattern sur `front/**/*.{js,html}` (Python/JS/HTML).
Référence : audit Phase 1, item #12 "à valider manuellement".*

---

## Suite — 2026-05-14

PR `chore(front): supprimer classes CSS + clés i18n mortes` (PR #154).

### Ce qui a été supprimé

**CSS — 50 classes supprimées** dans `front/styles/main.css` et `front/styles/mobile.css` :

- `main.css` : `notif-dot`, `dot-w`, `ssh-btn` (+ `.ssh-btn i`, `.asset-row:hover .ssh-btn`),
  `stock-row`, `stock-row:last-child`, `stock-info`, `stock-name`, `stock-qty`, `stock-actions`,
  section `/* ─── ONBOARDING ─── */` complète (8 sélecteurs : `checklist-row`, `check-ico`,
  `check-ico:hover`, `check-ico.done`, `check-ico i`, `check-text`, `check-text.done-text`,
  `onboard-progress`, `onboard-fill`), `.th-sorted .sort-icon`.
- `mobile.css` : `m-header-sub`, `m-back-btn`, `m-header-actions`, section `/* ── Ticket card ── */`
  complète (`m-ticket-card`, `m-ticket-title`, `m-ticket-meta`), section `/* ── Badges ── */`
  complète (`m-badge` à `m-badge-red`, 8 variantes), `m-hw-panel`, `m-hw-title`, `m-hw-row`,
  `m-hw-label`, `m-hw-val`, `m-disk-row`, `m-disk-letter`, `m-disk-pct`, `m-disk-size`,
  `m-ssh-conn` (+ `.connecting`, `.error`), `m-ssh-output`, `m-ssh-kbd-btns`, `m-ssh-kbd-btn`,
  section `/* ── Chat (ticket) ── */` complète, `m-menu-item` (+ `:active`, `i`),
  section `/* ── Settings list ── */` complète, `m-sheet-body`, `m-sheet-footer`,
  section `/* ── Forms ── */` complète, `m-sheet-btn-primary`, `m-sheet-btn-ghost`.

**Locales — 55 clés supprimées** dans `front/locales/fr.js` et `front/locales/en.js` (parity maintenue) :

- `nav.*` : dashboard, alertes, tickets, stock, scripts, onboarding, rapports, parametres (8 clés)
- `dashboard.kpi.*` : tickets, tickets_sub, alerts_sub
- `dashboard.alerts`, `dashboard.empty.alerts`, `dashboard.empty.devices`
- `postes.*` : title, filter.\* (6), sort.\* (4), col.\* (8), unassigned (19 clés au total)
- `btn.*` : export_csv, add, ssh
- `settings.audit.*` : empty, col.date, col.action, col.by, col.target (title conservé)
- `alertes.snoozed_section`
- `tickets.info.hostname`, `tickets.info.user`
- `error.network`
- `audit.filter.all_actions`, `audit.action.*` : agent_checkin, setup_script, intune_sync,
  token_created, token_revoked, admin_granted, admin_revoked (8 clés)
- `mobile.onboarding.steps`

### Faux positif identifié

- **`scripts.run.hint`** — listé LIKELY DEAD dans l'audit initial, mais trouvé actif à
  `front/views/scripts.js:190`. Non supprimé. À retirer de la liste LIKELY DEAD.

### Ce qui reste en attente (NEEDS REVIEW)

Les 12 classes CSS et 47 clés i18n catégorisées NEEDS REVIEW n'ont pas été touchées.
En particulier :
- `dashboard.activity.action.*` — nécessite `SELECT DISTINCT action FROM audit_log` en prod
  pour confirmer lesquelles sont réellement générées.
- Classes CSS avec usages dynamiques complexes — nécessitent review humaine.
