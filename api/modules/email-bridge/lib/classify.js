// Classifieur d'intent pour les mails entrants (Phase 2, issue #8).
//
// Backend : Ollama local via /api/chat avec format=json. Le modèle exact
// est fourni par le setting `mail.classifier.model` — on ne le hardcode pas
// pour laisser le maintainer arbitrer (mistral, llama, qwen…) sans modif code.
//
// Output contract :
//   { intent: 'new_ticket' | 'reply' | 'other', confidence: 0..1, reason: string }
//
// On valide STRICTEMENT le format de sortie : si Ollama produit un JSON
// non conforme (champ manquant, intent inconnu), on retourne null et le
// caller applique le fallback_intent. Pas de "best effort" silencieux.
//
// Kill switch via le setting `mail.classifier.enabled` : géré côté worker,
// pas ici. Cette lib ne lit pas la DB — elle prend tous ses paramètres en
// arguments. Conséquence : facile à tester en injectant un `fetchImpl` mock.

const VALID_INTENTS = new Set(['new_ticket', 'reply', 'other'])

// Prompt système + structure JSON imposée. On reste court :
//   - quelques règles pour éviter la sur-classification "ticket"
//     (un mail Yousign, une newsletter, une commande fournisseur = 'other')
//   - exemple par catégorie pour ancrer la sémantique
// Le contenu du mail est passé en user message ; le prompt est cacheable
// si Ollama supporte le caching (à voir version par version), de toute
// façon il est court donc le coût est négligeable.
const SYSTEM_PROMPT = `Tu classes des emails reçus sur une boîte helpdesk informatique d'entreprise.

Pour chaque email, retourne UNIQUEMENT un JSON :
{"intent": "<new_ticket|reply|other>", "confidence": <0..1>, "reason": "<courte phrase>"}

Règles :
- "new_ticket" : demande d'aide informatique nouvelle (problème poste, imprimante, mot de passe, accès, logiciel, matériel...).
- "reply" : réponse à un échange en cours côté helpdesk (le message fait référence à un échange précédent, contient "Re:", "TR:", cite un message, ou répond à une question posée).
- "other" : tout le reste (newsletter, notification automatique, commande/facture fournisseur, mail interne hors helpdesk, signature électronique, notifications de plateformes, alertes serveurs).

Tu dois être strict : en cas de doute entre "new_ticket" et "other", privilégie "other" — un faux négatif (mail non classé ticket) est moins coûteux qu'un faux positif (proposition de ticket à ignorer).

Tu ne dois RIEN écrire d'autre que le JSON.`

function buildUserPrompt({ from, subject, bodyPreview }) {
  return `Expéditeur: ${from || '(inconnu)'}
Sujet: ${subject || '(vide)'}
Aperçu: ${(bodyPreview || '').slice(0, 800)}`
}

// Valide la structure JSON renvoyée par le modèle. Retourne l'objet
// normalisé ou null si non conforme.
export function validateClassifierOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  const intent = raw.intent
  if (!VALID_INTENTS.has(intent)) return null

  let confidence = Number(raw.confidence)
  if (!Number.isFinite(confidence)) confidence = 0.5
  if (confidence < 0) confidence = 0
  if (confidence > 1) confidence = 1

  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : ''

  return { intent, confidence, reason }
}

// Appel HTTP Ollama. Le timeout est court (10 s) — le classifieur doit
// rester réactif, sinon on bloque le polling. En cas de timeout, le caller
// applique le fallback_intent.
export async function classifyWithOllama(message, { url, model, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!url)   throw new Error('classify: url manquante')
  if (!model) throw new Error('classify: model manquant')

  const userPrompt = buildUserPrompt(message)
  const body = {
    model,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 },  // déterminisme : c'est de la classif, pas du créatif
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`Ollama ${res.status}`)
  const data = await res.json()

  // Ollama /api/chat avec format=json renvoie { message: { content: "<json>" } }
  let parsed
  try {
    parsed = JSON.parse(data.message?.content ?? '{}')
  } catch {
    throw new Error('Ollama: réponse non-JSON')
  }
  const out = validateClassifierOutput(parsed)
  if (!out) throw new Error(`Ollama: format de sortie invalide (${JSON.stringify(parsed).slice(0, 200)})`)
  return out
}
