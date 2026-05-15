# Plan de retrait — `device_group_memberships` (système legacy Entra)

> **Statut : design / non engagé. Dernière revue : 2026-05-14.**
>
> Ce document ne déclenche aucune action. Il décrit un plan à consulter
> quand le moment sera venu de retirer le système de groupes legacy.
> Rien ne sera fait sans validation explicite de Clément.

---

## 1. État actuel

Deux systèmes de groupes coexistent en parallèle dans Opale.

**Système legacy (driven by Entra — migration 041)** : la table
`device_group_memberships` stocke un cache local des appartenances de
groupes Entra pour les devices managés. Ce cache est peuplé toutes les
60 minutes par le worker `api/lib/group-sync.js` via Microsoft Graph.
Les `deployment_jobs` avec `scope='group'` utilisent ce cache pour
le fan-out au checkin agent (requête dans `api/routes/agent.js`). La
création d'un tel job et le choix du groupe Entra source sont exposés
dans `front/views/packages.js` (onglet « Groupe Entra »).

**Système natif (migrations 051-053, PRs #125-131)** : les tables `groups`
et `group_members` constituent le nouveau système. Les groupes peuvent
être créés manuellement (`source='native'`) ou importés depuis Entra
(`source='entra'`, `entra_group_id` non-null) avec re-sync et
détachement optionnels. Les `deployment_jobs` avec `scope='native_group'`
ciblent un `native_group_id` UUID interne ; le fan-out au checkin agent
lit `group_members` directement, sans passer par `device_group_memberships`.

Le chantier groupes natifs est opérationnel mais la transition n'est pas
terminée : les deux scopes (`group` et `native_group`) continuent d'être
acceptés, et le worker `group-sync` tourne toujours.

---

## 2. Pourquoi retirer le legacy

- **Réduction de la dette** : deux tables, un worker périodique, deux
  branches de fan-out pour un seul cas d'usage (déployer sur un groupe
  de devices).
- **Simplification du code** : le worker `group-sync` est la seule
  dépendance active à Microsoft Graph en-dehors des routes à la demande
  (login, sync utilisateurs, recherche autocomplete). Le retirer ramène
  Graph à un rôle purement à la demande.
- **Indépendance Entra** : `device_group_memberships` est structurellement
  lié aux identifiants Entra (objectId TEXT). Le système natif accepte
  aussi l'import Entra mais peut en être détaché ; il n'en est pas
  structurellement dépendant.
- **Moins de confusion** : l'UI expose deux onglets de déploiement par
  groupe (Entra direct vs groupe natif). Supprimer le premier simplifie
  l'UX.

---

## 3. Pré-conditions avant retrait

Le retrait ne peut avoir lieu que si toutes les conditions suivantes sont
réunies :

- **Aucun `deployment_job` actif avec `scope='group'`** ne subsiste en
  production. Chaque job résiduel doit avoir été migré vers un job
  `scope='native_group'` équivalent (voir étape B).
- **Aucune création de nouveau job `scope='group'`** depuis au moins
  4 semaines (période de quiescence). Ce seuil peut être ajusté ; 4
  semaines couvre ~2 cycles d'alerte hebdomadaire et 1 cycle de
  reporting mensuel.
- **Audit `audit_logs`** filtré sur les événements de déploiement
  (champ `action` LIKE `'deployment%'`) : 0 occurrence de
  `scope='group'` créé sur la période de quiescence.
- **Tests** : la suite de tests existante passe toujours (aucun test
  ne doit cibler la branche legacy en production).

---

## 4. Étapes du retrait (futur)

### Étape A — Détection des jobs résiduels

Avant toute action, vérifier l'état en production :

```sql
-- Jobs deployment_jobs scope='group' encore actifs
SELECT id, package_id, source_group_id, created_at, deployed_by
FROM deployment_jobs
WHERE scope = 'group' AND status = 'active'
ORDER BY created_at;
```

Si 0 lignes → condition de pré-migration remplie, passer à l'étape C
directement (quiescence). Sinon, étape B.

### Étape B — Migration manuelle des jobs résiduels

Pour chaque job `scope='group'` actif :

1. Identifier le groupe Entra source via `source_group_id` (objectId).
2. Vérifier si un groupe natif lié à ce groupe Entra existe déjà :
   `SELECT id, name FROM groups WHERE entra_group_id = '<source_group_id>'`.
3. Si absent : importer le groupe via `POST /api/groups/import-from-entra`
   avec le même `entra_group_id`. Un re-sync (`POST /api/groups/:id/sync-from-entra`)
   peut être joué ensuite pour rafraîchir les membres.
4. Créer un nouveau `deployment_job` avec `scope='native_group'` et
   `native_group_id` = l'UUID du groupe natif créé/réutilisé.
5. Annuler l'ancien job (`PATCH /api/packages/:id/deploy` ou SQL direct :
   `UPDATE deployment_jobs SET status='cancelled' WHERE id='<ancien_id>'`).
6. Vérifier via `audit_logs` que le nouveau job a bien fan-outé sur les
   devices attendus au premier checkin.

### Étape C — Période de quiescence

Attendre ≥ 4 semaines après le dernier job `scope='group'` annulé (étape B)
ou après confirmation de l'état zéro (étape A). Durant cette période :

- Surveiller les `audit_logs` pour détecter toute régression ou création
  de job legacy (ex. : script externe ou intégration tierce).
- Garder le worker `group-sync` actif (coût négligeable, filet de sécurité).

### Étape D — Désactivation du code legacy

À planifier dans une migration numérotée (ex. migration 0NN).

**Base de données :**

```sql
-- Renommer la table (archive, pas DROP — irréversible)
ALTER TABLE device_group_memberships
  RENAME TO device_group_memberships_archive_preNNN;

-- Mettre à jour la CHECK constraint scope pour retirer 'group'
ALTER TABLE deployment_jobs DROP CONSTRAINT deployment_jobs_scope_check;
ALTER TABLE deployment_jobs
  ADD CONSTRAINT deployment_jobs_scope_check
  CHECK (scope IN ('all', 'user', 'native_group'));

-- Optionnel : DROP la contrainte scope_target_check et la recréer sans la branche 'group'
-- (si elle existe encore sous cette forme — cf. migration 052)
```

**Backend :**

- `api/index.js` : retirer l'import et l'appel `startGroupSyncWorker(...)`.
- `api/lib/group-sync.js` : le fichier peut être supprimé (ou conservé
  archivé hors de l'arbre de modules si on veut garder la référence).
- `api/routes/agent.js` : retirer la branche `j.scope = 'group'` du
  fan-out (lignes ~882-884).
- `api/routes/packages.js` : retirer la branche `scope === 'group'`
  du handler `POST /:id/deploy` (résolution Graph + création job). Retirer
  `'group'` de la liste des scopes valides dans le message d'erreur de
  la branche `else`.

**Frontend :**

- `front/views/packages.js` : retirer l'entrée `['group','Groupe Entra',...]`
  du sélecteur de scope, le panneau `pkg-scope-group`, et la branche
  `_deployScope === 'group'` dans la construction du body de déploiement.

### Étape E — Drop final

Après ≥ 4 semaines supplémentaires sans régression :

```sql
-- Drop de la table archive
DROP TABLE device_group_memberships_archive_preNNN;

-- Drop de l'index associé si encore présent
DROP INDEX IF EXISTS idx_device_group_memberships_group;
```

Retirer également la colonne `source_group_id` de `deployment_jobs` si
elle n'est plus référencée (vérifier avant : elle est aussi présente dans
les jobs annulés à des fins d'audit historique — décision à prendre).

---

## 5. Risques connus

- **Fan-out silencieux** : si un job `scope='group'` reste actif en
  production après l'étape D, le fan-out ne se fera plus (la branche
  est supprimée du code). Le package ne sera pas déployé sur les nouveaux
  devices du groupe, sans erreur visible. Mitigation : l'étape A doit
  être exhaustive et jouée juste avant l'étape D. Les `audit_logs`
  permettent de reconstituer a posteriori ce qui aurait dû être fan-outé.

- **Autocomplete Entra non affectée** : le worker `group-sync` retiré à
  l'étape D ne touche pas à la recherche autocomplete Entra dans l'UI
  groupes natifs. Celle-ci passe par `searchAADGroups` dans
  `api/lib/graph.js`, qui est un appel à la demande indépendant du worker.
  À confirmer en test avant l'étape D.

- **Agents hors ligne au moment du retrait** : un device qui n'a pas
  checkin depuis longtemps lors du passage à l'étape D pourrait se voir
  refuser le fan-out au premier checkin suivant (la branche legacy est
  absente, mais si le job a été annulé en étape B il n'aurait de toute
  façon pas matché). Risque faible si l'étape B est complète.

- **Rollback** : la table archivée (`_archive_preNNN`) permet un rollback
  d'urgence à l'étape D sans perte de données. Le retour arrière implique
  de remettre en place le code (branche git taggée avant merge recommandée).

---

## 6. Cross-références

| Sujet | Référence |
|---|---|
| Roadmap groupes natifs | Memory `project_groups.md` |
| Migration legacy (table + jobs) | `api/migrations/041_deployment_scope.sql` |
| Migrations système natif | `api/migrations/051_native_groups.sql`, `052_deploy_native_group.sql`, `053_groups_entra_link.sql` |
| Worker legacy | `api/lib/group-sync.js` |
| Fan-out agent (les deux branches) | `api/routes/agent.js` (~lignes 866-893) |
| Déploiement UI + validation scope | `api/routes/packages.js`, `front/views/packages.js` |
| Import / sync / détachement Entra | `api/routes/native-groups.js` |
| Chantier groupes natifs | PRs #125, #126, #127, #128, #129, #130, #131 |
| Recherche autocomplete Entra | `api/lib/graph.js` — `searchAADGroups` |
