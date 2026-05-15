# Patterns recommandés pour le développement

## Routes Fastify — validation par schéma JSON

### Pourquoi

Les routes du projet ont historiquement utilisé du `if (!req.body.x) return 400` manuel.
Depuis 2026-05-14 (audit Phase 1, recommandation B), on adopte progressivement la validation
par schéma JSON Fastify :

- **Validation automatique avant le handler** — les champs invalides ou manquants sont rejetés
  avant d'atteindre le code métier (gain perf + DRY).
- **Format d'erreur uniforme** `{ error: '...' }` — cohérent avec le `setErrorHandler` global
  posé dans `api/plugins/error-handler.js`.
- **Surface de doc gratuite** pour `@fastify/swagger` ultérieur (roadmap OpenAPI).

### Pattern de base

```js
fastify.post('/foo', {
  preHandler: [fastify.authenticate, fastify.requireAdmin],
  schema: {
    body: {
      type: 'object',
      required: ['name'],
      properties: {
        name:        { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 1000 },
        count:       { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,   // refuse les champs inconnus
    },
  },
}, async (req, reply) => {
  // body validé : pas de if (!body.name) etc.
  const { name, description, count } = req.body
  // ...
})
```

### Schémas par type de paramètre

**Query string (GET avec filtres) :**

```js
schema: {
  querystring: {
    type: 'object',
    properties: {
      q:        { type: 'string', maxLength: 200 },
      category: { type: 'string', maxLength: 100 },
    },
    additionalProperties: false,
  },
}
```

**Params URL (`/:id`) :**

```js
schema: {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },   // UUID ou autre — ajouter pattern si besoin
    },
  },
}
```

**Enum dans le body :**

```js
properties: {
  type: { type: 'string', enum: ['in', 'out'] },
}
```

### Règle d'adoption progressive

- **Nouvelle route POST/PATCH/PUT/DELETE → schéma obligatoire.**
- **Route existante touchée significativement → migrer son schéma au passage.**
- Pas de migration en bloc — au fil de l'eau sur les ~25 routes restantes.

Les routes `stock.js` et `alert-snoozes.js` servent de référence.

### Pour les erreurs métier

Préférer `throw fastify.httpErrors.badRequest('Foo invalide')` (via `@fastify/sensible`,
enregistré dans `api/index.js`) plutôt que `reply.code(400).send({ error: 'Foo invalide' })` :

```js
// Avant
if (!item) return reply.code(404).send({ error: 'Article introuvable' })

// Après (équivalent, plus court)
if (!item) throw fastify.httpErrors.notFound('Article introuvable')
```

Le `setErrorHandler` global normalise les deux formes en `{ error: '...' }`.

Méthodes disponibles : `badRequest` (400), `unauthorized` (401), `forbidden` (403),
`notFound` (404), `conflict` (409), `unprocessableEntity` (422), `internalServerError` (500).

### `additionalProperties: false`

À ajouter sur les `body` POST/PATCH/PUT pour rejeter les champs inconnus. Cela :
- Évite les injections de champs non anticipés.
- Force le frontend à ne passer que ce qui est documenté.

À **omettre** sur les schémas `querystring` et `params` quand Fastify injecte
des paramètres internes (rare, mais possible avec certains plugins).

---

## Helper `logAudit` — traçabilité des actions write

Tout write (create / update / delete) qui touche à des données sensibles ou auditables
doit émettre un événement dans `audit_logs` via `api/lib/audit.js` :

```js
import { logAudit } from '../lib/audit.js'

logAudit(fastify.db, fastify.log, {
  action:  'stock_movement',           // snake_case, verbe ou ressource_action
  byUser:  displayName || entraId,     // qui a effectué l'action
  target:  itemId,                     // ressource affectée (ID ou hostname)
  details: { type, quantity, note },   // contexte libre (objet → JSONB)
})
```

Non-bloquant : les erreurs DB dans `logAudit` sont loggées en warn, jamais rethrown.

---

## Helper `createGrantStore` — nonces one-shot

Pour les upgrades WebSocket (SSH / console) sans passer le JWT en query string,
utiliser `api/lib/one-shot-grant.js` :

```js
import { createGrantStore } from '../lib/one-shot-grant.js'
const store = createGrantStore({ ttlMs: 30_000 })

// Émettre un nonce (route HTTP authentifiée)
const { nonce, expires_in } = store.create({ deviceId, identity, reason })

// Consommer le nonce (lors de l'upgrade WS — one-shot)
const { ok, grant, error } = store.consume(nonce)
```

Stockage en RAM, mono-instance. Pour scale-out futur : swap Redis SETEX
(la signature publique est stable).
