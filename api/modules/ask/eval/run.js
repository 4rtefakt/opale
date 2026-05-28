// Ask Opale — harness d'eval (script one-shot, PAS un test CI).
//
// But : mesurer la justesse d'un provider/modèle sur la traduction
// question FR → QuerySpec, AVANT de figer un défaut. C'est l'artefact qui
// tranche « Mistral vs Claude, small vs large » sur des chiffres plutôt qu'au
// feeling. Ne fait que provider → validation → scoring : pas de DB, pas de
// résolution (les valeurs resolve sont comparées en langage naturel).
//
// Usage :
//   OPALE_ASK_PROVIDER=mistral \
//   OPALE_ASK_MODEL=mistral-small-latest \
//   OPALE_ASK_API_KEY=sk-... \
//   node modules/ask/eval/run.js
//
// Options env : OPALE_ASK_URL (override endpoint base).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { askProvider }       from '../lib/provider.js'
import { validateQuerySpec } from '../lib/queryspec.js'
import { scoreCase }         from './score.js'

const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))

const cfg = {
  provider: process.env.OPALE_ASK_PROVIDER || 'mistral',
  model:    process.env.OPALE_ASK_MODEL,
  url:      process.env.OPALE_ASK_URL || '',
  key:      process.env.OPALE_ASK_API_KEY,
  // Pacing entre requêtes (ms) pour respecter les rate limits des tiers bas.
  // Défaut 14 s ≈ ≤5 req/min. Surcharge via OPALE_ASK_DELAY_MS=0 sur un tier élevé.
  delayMs:  parseInt(process.env.OPALE_ASK_DELAY_MS ?? '14000', 10),
}

if (!cfg.model || !cfg.key) {
  console.error('Manque OPALE_ASK_MODEL et/ou OPALE_ASK_API_KEY.')
  process.exit(2)
}

const ICON = { exact: '✓', partial: '~', fail: '✗' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Appel provider avec retry sur 429 (rate limit). Backoff fixe ~20 s : la
// fenêtre de limite est par minute, inutile de marteler.
async function askWithRetry(question, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await askProvider({
        provider: cfg.provider, url: cfg.url, key: cfg.key, model: cfg.model, question,
      })
    } catch (err) {
      if (/\b429\b/.test(err.message) && attempt < tries) {
        await sleep(20_000)
        continue
      }
      throw err
    }
  }
}

async function main() {
  console.log(`Eval Ask Opale — provider=${cfg.provider} model=${cfg.model} — ${cases.length} cas\n`)
  const tally = { exact: 0, partial: 0, fail: 0, error: 0 }

  for (const [idx, c] of cases.entries()) {
    if (idx > 0 && cfg.delayMs > 0) await sleep(cfg.delayMs)
    let line
    try {
      const raw = await askWithRetry(c.q)
      const v = validateQuerySpec(raw)
      if (!v.ok) {
        tally.fail++
        line = `${ICON.fail} [invalide] ${c.q}\n    → ${v.errors.join(' ; ')}`
      } else {
        const r = scoreCase(c, v.spec)
        tally[r.status]++
        const detail = r.status === 'exact' ? '' :
          `\n    attendu≠obtenu — manquant:[${r.missing.join(', ')}] superflu:[${r.extra.join(', ')}]` +
          `\n    spec: ${JSON.stringify(v.spec)}`
        line = `${ICON[r.status]} ${c.q}${detail}`
      }
    } catch (err) {
      tally.error++
      line = `✗ [erreur] ${c.q}\n    → ${err.message}`
    }
    console.log(line)
  }

  const n = cases.length
  const acc = ((tally.exact + 0.5 * tally.partial) / n * 100).toFixed(1)
  console.log(`\n── Résumé ──`)
  console.log(`exact:   ${tally.exact}/${n}`)
  console.log(`partial: ${tally.partial}/${n}`)
  console.log(`fail:    ${tally.fail}/${n}`)
  console.log(`erreur:  ${tally.error}/${n}`)
  console.log(`score pondéré (exact=1, partial=0.5) : ${acc}%`)
}

main().catch(err => { console.error(err); process.exit(1) })
