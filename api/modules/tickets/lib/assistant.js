import { assertSafeLlmUrl } from '../../../lib/safe-url.js'

// Assistant IA des tickets : génère via Ollama une suggestion de réponse
// ou de prochaine étape de diagnostic à partir du contexte du ticket.
//
// Volontairement simple : pas de RAG, pas d'historique multi-tours. On
// passe le titre + la description + les derniers messages, et on demande
// une réponse COURTE et actionnable. Le résultat est un brouillon que
// l'admin relit (et n'envoie jamais tel quel automatiquement).

// Pre-prompt par défaut (fallback si le setting tickets.assistant.system_prompt
// est absent/vide). Le défaut configurable vit dans la migration 067.
// Le nom de l'organisation est injecté depuis le setting `org.name` par
// buildDefaultSystemPrompt() — jamais codé en dur : Opale est auto-hébergé
// par des tiers, chacun doit décrire SON organisation à son fournisseur LLM.
export const DEFAULT_SYSTEM_PROMPT = `Tu es l'assistant d'un support informatique interne, intégré à Opale (outil de gestion de parc / RMM). L'environnement est principalement Windows, avec Microsoft 365 / Entra ID et Intune.

Ton rôle : aider le technicien à AVANCER sur le ticket — propose soit une réponse concise au demandeur, soit la prochaine étape de diagnostic (commande, vérification, information à collecter).

Règles : réponds en français, 2 à 5 phrases, concret et actionnable ; pas d'en-tête ni de signature ; privilégie des pistes vérifiables sur un parc Windows/Intune/Entra ; si une info manque, indique précisément la question à poser ; ne fabrique aucune information.`

// Variante du pre-prompt par défaut enrichie du nom de l'organisation, quand
// le setting `org.name` est renseigné.
export function buildDefaultSystemPrompt(orgName) {
  const org = String(orgName || '').trim()
  if (!org) return DEFAULT_SYSTEM_PROMPT
  return DEFAULT_SYSTEM_PROMPT.replace(
    'et Intune.',
    `et Intune. L'organisation est ${org}.`
  )
}

// Construit le prompt utilisateur depuis le contexte du ticket. Inclut, si
// fournis, les métadonnées qui aident au diagnostic (priorité, statut, poste
// concerné, demandeur, tags) en plus du fil d'échanges.
// `messages` : [{ author, content }] déjà filtrés (pas de system/ai).
export function buildAssistantPrompt({
  title, description, messages = [],
  priority, status, tags = [], device, requester,
} = {}) {
  const lines = [`Titre : ${title || '(sans titre)'}`]
  if (status)        lines.push(`Statut : ${status}`)
  if (priority)      lines.push(`Priorité : ${priority}`)
  if (requester)     lines.push(`Demandeur : ${requester}`)
  if (device)        lines.push(`Poste concerné : ${device}`)
  if (tags.length)   lines.push(`Tags : ${tags.join(', ')}`)
  if (description)   lines.push(`Description : ${description}`)
  if (messages.length) {
    lines.push('', 'Derniers échanges :')
    for (const m of messages) {
      lines.push(`- ${m.author || '?'} : ${(m.content || '').slice(0, 1000)}`)
    }
  }
  lines.push('', 'Propose la meilleure réponse ou prochaine étape :')
  return lines.join('\n')
}

// Appelle Ollama /api/chat (texte libre, pas de format JSON). Retourne la
// suggestion en texte. fetchImpl injectable pour les tests.
//
// L'URL vient d'un setting : elle est validée contre l'allowlist d'hôtes
// (cf. lib/safe-url.js) avant tout appel réseau.
export async function generateSuggestion(
  { systemPrompt, orgName, url, model, fetchImpl = fetch, timeoutMs = 45_000, ...ctx } = {}
) {
  if (!url)   throw new Error('assistant: url manquante')
  if (!model) throw new Error('assistant: model manquant')
  const base = assertSafeLlmUrl(url, 'tickets.assistant.url')

  const body = {
    model,
    stream: false,
    options: { temperature: 0.4 },  // un peu de souplesse, mais pas trop
    messages: [
      { role: 'system', content: (systemPrompt && systemPrompt.trim()) || buildDefaultSystemPrompt(orgName) },
      { role: 'user',   content: buildAssistantPrompt(ctx) },
    ],
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${base}/api/chat`, {
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
  const text = (data.message?.content || '').trim()
  if (!text) throw new Error('assistant: réponse vide')
  return text
}
