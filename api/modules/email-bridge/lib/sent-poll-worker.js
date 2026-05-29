// Worker de polling du dossier "Éléments envoyés" (issue #8, extension).
//
// Toutes les `intervalMs` (30 s par défaut) :
//   1. Pour chaque boîte de `mail.sent_mailboxes` :
//      a. lit les mails envoyés depuis le curseur `mail.sent_cursor.<address>`
//      b. pour chaque mail → processSentOne() : append au ticket SI threadé
//      c. avance le curseur au max(sentDateTime) de la page
//
// Curseur : bootstrap = now() (pas de backfill auto — le rattrapage du passé
// se fait via scripts/backfill-sent-mail.js). Avancement à max(sentDateTime)
// de la page, pas à now(), pour ne pas sauter un mail envoyé pendant le
// traitement de la page.
//
// Kill switch : `mail.sent_poll_enabled = 'false'` → tick no-op.

import { listSentMessagesSince } from './graph-mail.js'
import { processSentOne } from './process-sent-mail.js'

const DEFAULT_INTERVAL_MS = 30_000
let _timer = null

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

// `injection` exposé pour les tests : remplace Graph sans monkey-patch.
export async function pollSentOnce(db, log, injection = {}) {
  const { listSentMessagesSince: list = listSentMessagesSince } = injection

  const enabled = await getSetting(db, 'mail.sent_poll_enabled')
  if (enabled !== 'true') return { skipped: 'disabled' }

  const mailboxes = parseMailboxes(await getSetting(db, 'mail.sent_mailboxes'))
  if (!mailboxes.length) return { skipped: 'no-mailbox-configured' }

  const stats = {
    mailboxes: mailboxes.length,
    actions: { message_appended: 0, skipped_no_match: 0, skipped_duplicate: 0, already_ingested: 0, skipped_error: 0 },
    errors: 0,
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

    let page
    try {
      page = await list(mailbox, cursor, { top: 50 })
    } catch (err) {
      stats.errors++
      log?.warn({ err: err.message, mailbox }, 'sent-worker: listSentMessages a échoué')
      continue
    }

    const messages = page.value || []
    let lastSentAt = null

    for (const m of messages) {
      if (m.sentDateTime && (!lastSentAt || m.sentDateTime > lastSentAt)) {
        lastSentAt = m.sentDateTime
      }
      try {
        const out = await processSentOne(db, log, { graphMessage: m, mailbox })
        if (out?.action && stats.actions[out.action] !== undefined) stats.actions[out.action]++
        if (out?.action === 'message_appended') {
          log?.info({
            mailbox, internetMessageId: m.internetMessageId,
            subject: m.subject, ticket_id: out.ticket_id,
          }, 'sent-worker: réponse Outlook ajoutée au ticket')
        }
      } catch (err) {
        stats.errors++
        log?.warn({ err: err.message, mailbox, internetMessageId: m.internetMessageId },
          'sent-worker: processSentOne a planté')
      }
    }

    if (lastSentAt) await setSetting(db, key, lastSentAt)
  }

  return stats
}

export function startMailSentPollWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return  // idempotent

  const run = () =>
    pollSentOnce(db, log).catch(err =>
      log?.warn({ err: err.message }, 'sent-worker: tick a planté')
    )

  setTimeout(run, 7_000)  // léger décalage vs le worker inbound (5s)
  _timer = setInterval(run, intervalMs)
  log?.info({ intervalMs }, 'sent-worker: démarré')
}

export function stopMailSentPollWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
}
