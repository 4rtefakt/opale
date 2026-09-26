// Worker de polling de la boîte de réception (Phase 2/3, issue #8).
//
// Toutes les `intervalMs` (30 s par défaut) :
//   1. Pour chaque mailbox configurée :
//      a. lit les messages reçus depuis le curseur (pages suivies, bornées)
//      b. pour chaque message → processOne() : ingest + classify + action
//      c. avance le curseur au receivedDateTime du dernier mail parcouru —
//         jamais au-delà d'un mail en échec, retenté au tick suivant puis
//         abandonné après MAX_INGEST_ATTEMPTS échecs (cf. poll-cursor.js)
//
// Curseur : par mailbox, setting `mail.cursor.<address>` (+ état
// `mail.cursor_state.<address>`, cf. poll-cursor.js). Bootstrap = now()
// (pas de backfill historique). Avancement au dernier mail parcouru, pas à
// now() — évite de sauter un mail arrivé pendant qu'on traitait la page.
//
// Idempotence : INSERT mapping avec ON CONFLICT DO NOTHING en début de tx
// dans processOne. Une race entre deux ticks ne crée pas de doublon.
//
// Kill switches :
//   - `mail.poll_enabled = 'false'` : tick no-op
//   - `mail.classifier.enabled = 'false'` : on tourne sur le fallback_intent

import { listMessagesSince } from './graph-mail.js'
import { processOne } from './process-mail.js'
import { pollMailboxCursor } from './poll-cursor.js'
import { nonOverlapping } from '../../../lib/non-overlapping.js'

const DEFAULT_INTERVAL_MS = 30_000
let _timer = null
let _kickoff = null
let _run = null

async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key])
  return rows[0]?.value ?? null
}

async function setSetting(db, key, value) {
  await db.query(`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES ($1, $2, now(), 'email-bridge-worker')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = 'email-bridge-worker'
  `, [key, value])
}

function cursorKey(mailbox) { return `mail.cursor.${mailbox.toLowerCase()}` }
function cursorStateKey(mailbox) { return `mail.cursor_state.${mailbox.toLowerCase()}` }

function parseMailboxes(csv) {
  if (!csv) return []
  const seen = new Set()
  const out = []
  for (const raw of String(csv).split(',')) {
    const m = raw.trim().toLowerCase()
    if (m && !seen.has(m)) { seen.add(m); out.push(m) }
  }
  return out
}

// ── Un tick de poll ───────────────────────────────────────────────────────────

// `injection` exposé pour les tests : permet de remplacer Graph et le
// classifieur sans monkey-patcher d'imports globaux.
export async function pollOnce(db, log, injection = {}) {
  const { listMessagesSince: list = listMessagesSince, classifierFn } = injection

  const enabled = await getSetting(db, 'mail.poll_enabled')
  if (enabled !== 'true') return { skipped: 'disabled' }

  const mailboxes = parseMailboxes(await getSetting(db, 'mail.inboxes'))
  if (!mailboxes.length) return { skipped: 'no-mailbox-configured' }

  const stats = {
    mailboxes: mailboxes.length,
    actions: { message_appended: 0, proposal_created: 0, proposal_created_no_match: 0,
               skipped_other: 0, skipped_error: 0, already_ingested: 0 },
    errors: 0,
    abandoned: 0,   // mails abandonnés après MAX_INGEST_ATTEMPTS échecs
  }

  for (const mailbox of mailboxes) {
    const key = cursorKey(mailbox)
    let cursor = await getSetting(db, key)
    if (!cursor) {
      const { rows } = await db.query('SELECT now() AS now')
      cursor = rows[0].now.toISOString()
      await setSetting(db, key, cursor)
      log?.info({ mailbox, cursor }, 'email-bridge: curseur initialisé (pas de backfill)')
      continue
    }

    // Normaliser le format du curseur avant de l'envoyer à Graph. Si
    // quelqu'un a édité le setting à la main (ou via UPDATE SQL), il peut
    // être en format Postgres (`2026-05-09 10:59:47.040437+00`) ce que
    // Graph rejette avec 400 "Invalid filter clause". On reformate en ISO
    // 8601 strict, et on persiste la version normalisée pour ne pas
    // re-payer le parsing à chaque tick.
    const parsed = new Date(cursor)
    if (Number.isNaN(parsed.getTime())) {
      stats.errors++
      log?.warn({ mailbox, cursor }, 'email-bridge: curseur illisible, skip mailbox (ré-initialiser via /api/settings)')
      continue
    }
    const cursorIso = parsed.toISOString()
    if (cursorIso !== cursor) {
      await setSetting(db, key, cursorIso)
      cursor = cursorIso
    }

    const handle = async (m) => {
      try {
        const out = await processOne(db, log, { graphMessage: m, mailbox, classifierFn })
        if (out?.action && stats.actions[out.action] !== undefined) stats.actions[out.action]++
        if (out?.action === 'proposal_created' || out?.action === 'message_appended') {
          log?.info({
            mailbox, internetMessageId: m.internetMessageId,
            from: m.from?.emailAddress?.address, subject: m.subject,
            action: out.action, ticket_id: out.ticket_id, proposal_id: out.proposal_id,
            intent: out.intent,
          }, 'email-bridge: mail traité')
        }
        // Transaction annulée : rien d'écrit → retenté (curseur non avancé).
        // Les autres 'skipped_error' sont définitifs (mail inexploitable).
        if (out?.retryable) return { retry: true, error: out.error }
      } catch (err) {
        stats.errors++
        log?.warn({ err: err.message, mailbox, internetMessageId: m.internetMessageId },
          'email-bridge: processOne a planté')
        return { retry: true, error: err.message }
      }
    }

    const res = await pollMailboxCursor(db, log, {
      mailbox, cursor, cursorKey: key, stateKey: cursorStateKey(mailbox),
      dateField: 'receivedDateTime', list, handle,
      updatedBy: 'email-bridge-worker', tag: 'email-bridge',
    })
    stats.errors += res.errors
    stats.abandoned += res.abandoned
  }

  return stats
}

export function startMailPollWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return  // idempotent

  // Un seul tick à la fois : un tick lent (Graph, classifieur) n'est pas
  // doublé par le suivant (curseur qui recule, mails retraités).
  _run = nonOverlapping(() => pollOnce(db, log), {
    onError: err => log?.warn({ err: err.message }, 'email-bridge: tick a planté'),
  })

  _kickoff = setTimeout(_run, 5_000)
  _timer = setInterval(_run, intervalMs)
  log?.info({ intervalMs }, 'email-bridge: worker démarré')
}

// Arrête le worker et attend la fin du tick en cours.
export async function stopMailPollWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_kickoff) { clearTimeout(_kickoff); _kickoff = null }
  if (_run) { const run = _run; _run = null; await run.idle() }
}
