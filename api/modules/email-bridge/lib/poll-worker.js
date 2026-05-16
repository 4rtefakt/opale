// Worker de polling de la boîte de réception (Phase 2/3, issue #8).
//
// Toutes les `intervalMs` (30 s par défaut) :
//   1. Pour chaque mailbox configurée :
//      a. lit les messages reçus depuis le curseur
//      b. pour chaque message → processOne() : ingest + classify + action
//      c. avance le curseur au max(receivedDateTime) de la page
//
// Curseur : par mailbox, setting `mail.cursor.<address>`. Bootstrap = now()
// (pas de backfill historique). Avancement à max(receivedDateTime) de la
// page traitée, pas à now() — évite de sauter un mail arrivé pendant qu'on
// traitait la page.
//
// Idempotence : INSERT mapping avec ON CONFLICT DO NOTHING en début de tx
// dans processOne. Une race entre deux ticks ne crée pas de doublon.
//
// Kill switches :
//   - `mail.poll_enabled = 'false'` : tick no-op
//   - `mail.classifier.enabled = 'false'` : on tourne sur le fallback_intent

import { listMessagesSince } from './graph-mail.js'
import { processOne } from './process-mail.js'

const DEFAULT_INTERVAL_MS = 30_000
let _timer = null

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

    let page
    try {
      page = await list(mailbox, cursor, { top: 50 })
    } catch (err) {
      stats.errors++
      log?.warn({ err: err.message, mailbox }, 'email-bridge: listMessages a échoué')
      continue
    }

    const messages = page.value || []
    let lastReceivedAt = null

    for (const m of messages) {
      if (m.receivedDateTime && (!lastReceivedAt || m.receivedDateTime > lastReceivedAt)) {
        lastReceivedAt = m.receivedDateTime
      }
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
      } catch (err) {
        stats.errors++
        log?.warn({ err: err.message, mailbox, internetMessageId: m.internetMessageId },
          'email-bridge: processOne a planté')
      }
    }

    if (lastReceivedAt) await setSetting(db, key, lastReceivedAt)
  }

  return stats
}

export function startMailPollWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return  // idempotent

  const run = () =>
    pollOnce(db, log).catch(err =>
      log?.warn({ err: err.message }, 'email-bridge: tick a planté')
    )

  setTimeout(run, 5_000)
  _timer = setInterval(run, intervalMs)
  log?.info({ intervalMs }, 'email-bridge: worker démarré')
}

export function stopMailPollWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
}
