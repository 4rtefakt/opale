// Ask Opale — construction du prompt qui fait produire un QuerySpec au LLM.
//
// Le modèle ne voit JAMAIS le SQL ni le schéma DB : il voit le catalogue des
// ressources/filtres (describeRegistry) et doit émettre un QuerySpec JSON. La
// validation stricte (queryspec.js) reste la frontière — le prompt n'est qu'un
// guide. On reste en français (questions des techniciens en français).

import { describeRegistry, RESOURCES } from './registry.js'

// Schéma JSON volontairement permissif pour le wire (tool Anthropic /
// response_format Mistral) : on laisse passer la forme générale, la sémantique
// est vérifiée par validateQuerySpec côté serveur. But = qu'aucun provider ne
// rejette en amont une structure qu'on sait re-valider.
export const QUERYSPEC_JSON_SCHEMA = {
  type: 'object',
  properties: {
    resource: { type: 'string', enum: RESOURCES },
    filters:  { type: 'object', additionalProperties: true },
    cross:    { type: 'object', additionalProperties: true },
    sort: {
      anyOf: [
        { type: 'string' },
        { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
      ],
    },
    limit: { type: 'number' },
  },
  required: ['resource'],
  additionalProperties: false,
}

// `orgContext` vient du setting `org.name` (cf. routes/ask.js). Il ne DOIT
// pas être codé en dur : Opale est distribué sous AGPL et auto-hébergé par des
// tiers — chaque déployeur enverrait sinon le nom d'une autre organisation à
// son fournisseur LLM.
export function buildSystemPrompt(orgContext) {
  const catalogue = JSON.stringify(describeRegistry(), null, 2)
  const org = String(orgContext || '').trim()
  const orgClause = org ? `, organisation ${org}` : ''
  return `Tu es le moteur de requêtes d'Opale (outil de gestion de parc / RMM${orgClause}). Ton unique rôle : traduire une question en français en un objet JSON "QuerySpec". Tu ne réponds JAMAIS en texte libre.

Un QuerySpec a la forme :
{
  "resource": "<une des ressources>",
  "filters": { "<nom_de_filtre>": <valeur>, ... },
  "cross":   { "<nom_de_cross_filter>": <valeur>, ... },
  "sort":    { "field": "<champ_triable>", "dir": "asc|desc" },
  "limit":   <nombre>
}

Règles STRICTES :
- N'utilise QUE des noms de filtres / cross-filters / champs de tri présents dans le catalogue ci-dessous, pour la ressource choisie. N'invente jamais de champ.
- Les valeurs d'un filtre "enum" doivent être exactement dans la liste donnée.
- Les filtres "resolve" prennent une chaîne en langage naturel (ex: nom de groupe, d'utilisateur, de département, de tag) — le serveur la résout, ne devine pas d'identifiant.
- "filters" = conditions directes sur la ressource ; "cross" = conditions relationnelles (liens vers d'autres ressources).
- Choisis la ressource la plus directe : pour "quels postes…" → devices ; "quels tickets…" → tickets ; "quels postes échouent à la règle X / état de conformité" → compliance (ou devices + cross.failing_rule).
- "filters", "cross", "sort", "limit" sont optionnels : ne mets que ce qui est utile. Si aucun filtre n'est pertinent, renvoie juste { "resource": "..." }.
- Ne renvoie QUE le JSON, rien d'autre.

Catalogue des ressources disponibles :
${catalogue}`
}

export function buildUserPrompt(question) {
  return `Question : ${String(question || '').slice(0, 1000)}`
}
