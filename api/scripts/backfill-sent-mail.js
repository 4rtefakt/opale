#!/usr/bin/env node
// Backfill ponctuel : rattrape les réponses envoyées depuis Outlook (hors
// Opale) sur les N derniers jours et les rattache aux tickets existants.
//
// Complète le worker temps-réel (sent-poll-worker.js) qui, lui, ne regarde
// que le futur à partir de son bootstrap. Ici on remonte dans le passé.
//
// Usage :
//   node api/scripts/backfill-sent-mail.js [--days=21] [--mailbox=a@b,c@d] [--check]
//
//   --days=N     fenêtre de rattrapage en jours (défaut 21 = 3 semaines)
//   --mailbox=…  CSV de boîtes à scanner ; défaut = setting mail.sent_mailboxes
//   --check      dry-run : compte les mails qui SERAIENT rattachés, n'écrit rien
//
// Idempotence : processSentOne dédoublonne sur internet_message_id, donc
// re-lancer le script ne crée pas de doublons. On n'avance PAS le curseur du
// worker temps-réel — les deux sont indépendants.

import pg from 'pg'
import { listSentMessagesSince } from '../modules/email-bridge/lib/graph-mail.js'
import { processSentOne } from '../modules/email-bridge/lib/process-sent-mail.js'

function parseArg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const dryRun = process.argv.includes('--check')
const days   = parseInt(parseArg('days', '21'), 10)
const mailboxArg = parseArg('mailbox', null)

function newPool() {
  if (process.env.DATABASE_URL || process.env.PGURL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.PGURL, max: 2 })
  }
  return new pg.Pool({
    host: process.env.POSTGRES_HOST || 'db',
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 2,
  })
}

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

async function backfillMailbox(db, mailbox, sinceIso, stats) {
  let cursor = sinceIso
  for (;;) {
    let page
    try {
      page = await listSentMessagesSince(mailbox, cursor, { top: 50 })
    } catch (err) {
      console.error(`  [${mailbox}] listSentMessages a échoué : ${err.message}`)
      stats.errors++
      return
    }
    const messages = page.value || []
    if (!messages.length) return

    let maxSent = null
    for (const m of messages) {
      if (m.sentDateTime && (!maxSent || m.sentDateTime > maxSent)) maxSent = m.sentDateTime
      try {
        const { action } = await processSentOne(db, null, { graphMessage: m, mailbox, dryRun })
        if (stats.actions[action] !== undefined) stats.actions[action]++
        if (action === 'message_appended') {
          console.log(`  [${mailbox}] ${dryRun ? 'À RATTACHER' : 'rattaché'} : "${m.subject}" (${m.sentDateTime})`)
        }
      } catch (err) {
        console.error(`  [${mailbox}] erreur sur ${m.internetMessageId} : ${err.message}`)
        stats.errors++
      }
    }

    // Avance le curseur de pagination. Si tous les mails de la page ont le
    // même timestamp que le curseur (pas d'avancement possible avec un
    // `gt`), on s'arrête pour éviter une boucle infinie.
    if (!maxSent || maxSent === cursor) {
      if (messages.length === 50) {
        console.warn(`  [${mailbox}] page pleine sans avancement du curseur (timestamps identiques) — arrêt préventif`)
      }
      return
    }
    cursor = maxSent
  }
}

async function run(db) {
  const mailboxes = mailboxArg
    ? parseMailboxes(mailboxArg)
    : parseMailboxes((await db.query(`SELECT value FROM settings WHERE key = 'mail.sent_mailboxes'`)).rows[0]?.value)

  if (!mailboxes.length) {
    console.error('Aucune boîte à scanner. Configure mail.sent_mailboxes ou passe --mailbox=a@b.')
    process.exit(1)
  }

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString()
  const stats = {
    actions: { message_appended: 0, skipped_no_match: 0, skipped_duplicate: 0, already_ingested: 0, skipped_error: 0 },
    errors: 0,
  }

  console.log(`Backfill mails envoyés ${dryRun ? '(DRY-RUN) ' : ''}: ${mailboxes.join(', ')}`)
  console.log(`Fenêtre : ${days} jours (depuis ${sinceIso})\n`)

  for (const mailbox of mailboxes) {
    await backfillMailbox(db, mailbox, sinceIso, stats)
  }

  console.log('\n── Résumé ──')
  console.log(`  rattachés       : ${stats.actions.message_appended}${dryRun ? ' (à rattacher)' : ''}`)
  console.log(`  sans ticket     : ${stats.actions.skipped_no_match}`)
  console.log(`  doublons Opale  : ${stats.actions.skipped_duplicate}`)
  console.log(`  déjà ingérés    : ${stats.actions.already_ingested}`)
  console.log(`  erreurs traitées: ${stats.actions.skipped_error}`)
  console.log(`  erreurs Graph   : ${stats.errors}`)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const db = newPool()
  run(db)
    .catch(err => { console.error('Échec backfill :', err); process.exit(1) })
    .finally(() => db.end())
}
