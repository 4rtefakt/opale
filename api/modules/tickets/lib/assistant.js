// Assistant IA des tickets : génère via Ollama une suggestion de réponse
// ou de prochaine étape de diagnostic à partir du contexte du ticket.
//
// Volontairement simple : pas de RAG, pas d'historique multi-tours. On
// passe le titre + la description + les derniers messages, et on demande
// une réponse COURTE et actionnable. Le résultat est un brouillon que
// l'admin relit (et n'envoie jamais tel quel automatiquement).

// Pre-prompt par défaut (fallback si le setting tickets.assistant.system_prompt
// est absent/vide). Le défaut configurable vit dans la migration 067.
export const DEFAULT_SYSTEM_PROMPT = `Tu es l'assistant d'un support informatique interne, intégré à Opale (outil de gestion de parc / RMM). L'environnement est principalement Windows, avec Microsoft 365 / Entra ID et Intune. L'organisation est la Tour du Valat, institut de recherche sur les zones humides.

Ton rôle : aider le technicien à AVANCER sur le ticket — propose soit une réponse concise au demandeur, soit la prochaine étape de diagnostic (commande, vérification, information à collecter).

Règles : réponds en français, 2 à 5 phrases, concret et actionnable ; pas d'en-tête ni de signature ; privilégie des pistes vérifiables sur un parc Windows/Intune/Entra ; si une info manque, indique précisément la question à poser ; ne fabrique aucune information.`

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

const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com'
const TEMPERATURE = 0.4  // un peu de souplesse, mais pas trop

// Génère une suggestion (texte libre). Deux backends possibles :
//   - 'ollama'    : instance locale via /api/chat (défaut historique)
//   - 'anthropic' : Claude via /v1/messages (clé en apiKey)
// Le classifieur mail, lui, reste TOUJOURS sur Ollama (hors de ce module).
// fetchImpl injectable pour les tests.
export async function generateSuggestion(
  { systemPrompt, provider = 'ollama', url, model, apiKey, fetchImpl = fetch, timeoutMs = 45_000, ...ctx } = {}
) {
  if (!model) throw new Error('assistant: model manquant')
  const system = (systemPrompt && systemPrompt.trim()) || DEFAULT_SYSTEM_PROMPT
  const userPrompt = buildAssistantPrompt(ctx)

  if (provider === 'anthropic') return callAnthropic({ system, userPrompt, url, model, apiKey, fetchImpl, timeoutMs })
  if (provider === 'ollama')    return callOllama({ system, userPrompt, url, model, fetchImpl, timeoutMs })
  throw new Error(`assistant: provider inconnu (${provider})`)
}

async function withTimeout(timeoutMs, fn) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try { return await fn(ctrl.signal) }
  finally { clearTimeout(timer) }
}

async function callOllama({ system, userPrompt, url, model, fetchImpl, timeoutMs }) {
  if (!url) throw new Error('assistant: url manquante')
  const res = await withTimeout(timeoutMs, (signal) => fetchImpl(`${url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, options: { temperature: TEMPERATURE },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: userPrompt },
      ],
    }),
    signal,
  }))
  if (!res.ok) throw new Error(`Ollama ${res.status}`)
  const data = await res.json()
  const text = (data.message?.content || '').trim()
  if (!text) throw new Error('assistant: réponse vide')
  return text
}

async function callAnthropic({ system, userPrompt, url, model, apiKey, fetchImpl, timeoutMs }) {
  if (!apiKey) throw new Error('assistant: clé API manquante')
  const base = (url || ANTHROPIC_DEFAULT_URL).replace(/\/$/, '')
  const res = await withTimeout(timeoutMs, (signal) => fetchImpl(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: TEMPERATURE,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal,
  }))
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  const data = await res.json()
  const text = (Array.isArray(data.content)
    ? data.content.filter(b => b?.type === 'text').map(b => b.text).join('')
    : '').trim()
  if (!text) throw new Error('assistant: réponse vide')
  return text
}
