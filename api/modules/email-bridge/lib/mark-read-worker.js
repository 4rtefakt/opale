// Worker de marquage Outlook "lu" (Phase 5a, issue #8).
//
// Scanne les `email_thread_mapping` qui doivent être marqués lus :
//   - leur proposal_id pointe vers une proposal status='accepted'
//   - email_read_marked_at IS NULL (pas encore marqué)
// et appelle Graph PATCH /messages/{id} avec {isRead: true}.
//
// Les mappings issus de `message_appended` (mail entrant matché à un
// ticket existant) sont marqués email_read_marked_at = NOW() DÈS
// l'ingestion par le pipeline inbound (process-mail.js) — ils n'ont pas
// besoin de passer par ce worker.
//
// Kill switch : setting `mail.mark_as_read_enabled = 'false'` (défaut).
// Tant que ce flag n'est pas true, le worker tourne mais no-op — utile
// pour pouvoir déployer le code AVANT que la perm Graph soit consentie.

import { markMessageAsRead } from './graph-mail.js'

const DEFAULT_INTERVAL_MS = 15_000
const MAX_BATCH = 20
let _timer = null

async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key])
  return rows[0]?.value ?? null
}

// Sélectionne les mappings à marquer lus côté Outlook. Deux cas :
//   1. Mail ajouté à un ticket existant (`action='message_appended'`) →
//      à marquer immédiatement, le mail est déjà visible dans Opale.
//   2. Mail issu d'une proposal acceptée (`tp.status='accepted'`) → à
//      marquer dès qu'on a confirmé que c'est un vrai ticket.
//
// Les `skipped_other` (newsletters) et `proposal_created` pending restent
// non-lus dans Outlook — le maintainer choisit.
async function pickPending(db, limit) {
  const { rows } = await db.query(`
    SELECT etm.id          AS mapping_id,
           etm.mailbox,
           etm.graph_message_id
    FROM email_thread_mapping etm
    LEFT JOIN ticket_proposals tp ON tp.id = etm.proposal_id
    WHERE etm.email_read_marked_at IS NULL
      AND etm.graph_message_id IS NOT NULL
      AND (
        etm.action = 'message_appended'
        OR tp.status = 'accepted'
      )
    ORDER BY etm.created_at ASC
    LIMIT $1
  `, [limit])
  return rows
}

async function markMapping(db, mappingId, at) {
  await db.query(
    `UPDATE email_thread_mapping SET email_read_marked_at = $1 WHERE id = $2`,
    [at, mappingId]
  )
}

export async function flushMarkRead(db, log, { markImpl = markMessageAsRead } = {}) {
  const enabled = await getSetting(db, 'mail.mark_as_read_enabled')
  if (enabled !== 'true') return { skipped: 'disabled' }

  const pending = await pickPending(db, MAX_BATCH)
  if (!pending.length) return { marked: 0, errors: 0 }

  const stats = { marked: 0, errors: 0 }
  for (const m of pending) {
    try {
      await markImpl(m.mailbox, m.graph_message_id)
      await markMapping(db, m.mapping_id, new Date())
      stats.marked++
      log?.info({ mailbox: m.mailbox, graphId: m.graph_message_id }, 'mark-read: mail marqué lu dans Outlook')
    } catch (err) {
      stats.errors++
      // En cas d'erreur permanente (403 perm manquante, 404 mail
      // supprimé), on RE-tentera au prochain tick. Pour éviter de spammer
      // les logs sur des cas connus, on garde simple : warn une fois,
      // puis on continuera à logger toutes les 15s. Le maintainer corrige
      // la cause root (perm Graph, setting désactivé, etc.).
      log?.warn({ err: err.message, mailbox: m.mailbox, graphId: m.graph_message_id }, 'mark-read: échec')
    }
  }
  return stats
}

export function startMailMarkReadWorker(db, log, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return
  const run = () =>
    flushMarkRead(db, log).catch(err =>
      log?.warn({ err: err.message }, 'mark-read: tick a planté')
    )
  setTimeout(run, 9_000)  // décalé de l'outbound (7s) et de l'inbound (5s)
  _timer = setInterval(run, intervalMs)
  log?.info({ intervalMs }, 'email-bridge: worker mark-read démarré')
}

export function stopMailMarkReadWorker() {
  if (_timer) { clearInterval(_timer); _timer = null }
}
