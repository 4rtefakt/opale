// Worker de polling du dossier "Éléments envoyés" (issue #8, extension).
//
// Toutes les `intervalMs` (30 s par défaut) :
//   1. Pour chaque boîte de `mail.sent_mailboxes` :
//      a. lit les mails envoyés depuis le curseur `mail.sent_cursor.<address>`
//         (pages suivies, bornées)
//      b. pour chaque mail → processSentOne() : append au ticket SI threadé
//      c. avance le curseur au sentDateTime du dernier mail parcouru —
//         jamais au-delà d'un mail en échec, retenté au tick suivant puis
//         abandonné s'il échoue durablement seul (cf. poll-cursor.js)
//
// Curseur : bootstrap = now() (pas de backfill auto — le rattrapage du passé
// se fait via scripts/backfill-sent-mail.js). Avancement au dernier mail
// parcouru, pas à now(), pour ne pas sauter un mail envoyé pendant le
// traitement de la page. État complémentaire (ids déjà traités au même
// horodatage, retry) : `mail.sent_cursor_state.<address>`.
//
// Kill switch : `mail.sent_poll_enabled = 'false'` → tick no-op.

import { listSentMessagesSince } from './graph-mail.js'
import { processSentOne } from './process-sent-mail.js'
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
    VALUES ($1, $2, now(), 'email-sent-worker')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = 'email-sent-worker'
  `, [key, value])
}

function cursorKey(mailbox) { return `mail.sent_cursor.${mailbox.toLowerCase()}` }
function cursorStateKey(mailbox) { return `mail.sent_cursor_state.${mailbox.toLowerCase()}` }

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

// `injection` exposé pour les tests : remplace Graph (et l'horloge : `now`) sans monkey-patch.
export async function pollSentOnce(db, log, injection = {}) {
  const { listSentMessagesSince: list = listSentMessagesSince, now } = injection

  const enabled = await getSetting(db, 'mail.sent_poll_enabled')
  if (enabled !== 'true') return { skipped: 'disabled' }

  const mailboxes = parseMailboxes(await getSetting(db, 'mail.sent_mailboxes'))
  if (!mailboxes.length) return { skipped: 'no-mailbox-configured' }

  const stats = {
    mailboxes: mailboxes.length,
    actions: { message_appended: 0, skipped_no_match: 0, skipped_duplicate: 0, already_ingested: 0, skipped_error: 0 },
    errors: 0,
    abandoned: 0,   // mails « poison » abandonnés (cf. poll-cursor.js)
  }

  for (const mailbox of mailboxes) {
    const key = cursorKey(mailbox)
    let cursor = await getSetting(db, key)
    if (!cursor) {
      const { rows } = await db.query('SELECT now() AS now')
      cursor = rows[0].now.toISOString()
      await setSetting(db, key, cursor)
      log?.info({ mailbox, cursor }, 'sent-worker: curseur initialisé (pas de backfill auto)')
      continue
    }

    // Normaliser le curseur en ISO 8601 strict (cf. poll-worker : un curseur
    // édité à la main en format Postgres casse le $filter Graph avec 400).
    const parsed = new Date(cursor)
    if (Number.isNaN(parsed.getTime())) {
      stats.errors++
      log?.warn({ mailbox, cursor }, 'sent-worker: curseur illisible, skip mailbox')
      continue
    }
    const cursorIso = parsed.toISOString()
    if (cursorIso !== cursor) {
      await setSetting(db, key, cursorIso)
      cursor = cursorIso
    }

    const handle = async (m) => {
      try {
        const out = await processSentOne(db, log, { graphMessage: m, mailbox })
        if (out?.action && stats.actions[out.action] !== undefined) stats.actions[out.action]++
        if (out?.action === 'message_appended') {
          log?.info({
            mailbox, internetMessageId: m.internetMessageId,
            subject: m.subject, ticket_id: out.ticket_id,
          }, 'sent-worker: réponse Outlook ajoutée au ticket')
        }
        // Transaction annulée : rien d'écrit → retenté (curseur non avancé).
        if (out?.retryable) return { retry: true, error: out.error }
        // `wrote` : écriture commitée (pas skipped_no_match / duplicate /
        // already_ingested, qui n'écrivent rien) — verdict poll-cursor.
        return { wrote: out?.committed === true }
      } catch (err) {
        stats.errors++
        log?.warn({ err: err.message, mailbox, internetMessageId: m.internetMessageId },
          'sent-worker: processSentOne a planté')
        return { retry: true, error: err.message }
      }
    }

    const res = await pollMailboxCursor(db, log, {
      mailbox, cursor, cursorKey: key, stateKey: cursorStateKey(mailbox),
      dateField: 'sentDateTime', list, handle,
      updatedBy: 'email-sent-worker', tag: 'sent-worker', now,
    })
    stats.errors += res.errors
    stats.abandoned += res.abandoned
  }

  return stats
}

export function startMailSentPollWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return  // idempotent

  // Un seul tick à la fois (cf. poll-worker).
  _run = nonOverlapping(() => pollSentOnce(db, log), {
    onError: err => log?.warn({ err: err.message }, 'sent-worker: tick a planté'),
  })

  _kickoff = setTimeout(_run, 7_000)  // léger décalage vs le worker inbound (5s)
  _timer = setInterval(_run, intervalMs)
  log?.info({ intervalMs }, 'sent-worker: démarré')
}

// Arrête le worker et attend la fin du tick en cours.
export async function stopMailSentPollWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_kickoff) { clearTimeout(_kickoff); _kickoff = null }
  if (_run) { const run = _run; _run = null; await run.idle() }
}
