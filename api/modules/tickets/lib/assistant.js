// Assistant IA des tickets : génère via Ollama une suggestion de réponse
// ou de prochaine étape de diagnostic à partir du contexte du ticket.
//
// Volontairement simple : pas de RAG, pas d'historique multi-tours. On
// passe le titre + la description + les derniers messages, et on demande
// une réponse COURTE et actionnable. Le résultat est un brouillon que
// l'admin relit (et n'envoie jamais tel quel automatiquement).

const SYSTEM_PROMPT = `Tu es l'assistant d'un support informatique interne (helpdesk).
À partir du contexte d'un ticket, propose EN FRANÇAIS soit une réponse concise
à envoyer au demandeur, soit la prochaine étape de diagnostic la plus pertinente.
Sois bref (2 à 5 phrases), concret et professionnel. Pas de formule d'en-tête
ni de signature. Si une information manque pour avancer, propose la question
précise à poser.`

// Construit le prompt utilisateur depuis le contexte du ticket.
// `messages` : [{ author, content }] déjà filtrés (pas de system/ai).
export function buildAssistantPrompt({ title, description, messages = [] }) {
  const lines = [`Titre du ticket : ${title || '(sans titre)'}`]
  if (description) lines.push(`Description : ${description}`)
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
export async function generateSuggestion(
  { title, description, messages, url, model, fetchImpl = fetch, timeoutMs = 45_000 } = {}
) {
  if (!url)   throw new Error('assistant: url manquante')
  if (!model) throw new Error('assistant: model manquant')

  const body = {
    model,
    stream: false,
    options: { temperature: 0.4 },  // un peu de souplesse, mais pas trop
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildAssistantPrompt({ title, description, messages }) },
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
  const text = (data.message?.content || '').trim()
  if (!text) throw new Error('assistant: réponse vide')
  return text
}
