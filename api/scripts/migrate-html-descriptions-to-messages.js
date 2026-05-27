#!/usr/bin/env node
// Migration de data ponctuelle (Phase 1a, refonte "le ticket est une
// conversation").
//
// AVANT  : les tickets créés depuis un mail Outlook ont leur HTML brut stocké
//          dans tickets.description ("De: X / Sujet: Y / <body HTML>").
// APRÈS  : tickets.description = ligne courte ("Mail de X reçu le Y"), et
//          le body est dans un ticket_message type='comment' chronologiquement
//          au début du fil.
//
// Le script :
//   1. Sélectionne les tickets dont description contient des balises HTML
//      typiques d'Outlook (heuristique alignée avec le helper cleanLegacyHtml
//      qu'on retirera côté front).
//   2. Pour chaque ticket, trouve l'auteur : email_thread_mapping inbound
//      le plus ancien (from_address, raw.from.name) ; fallback users_cache
//      via tickets.user_id.
//   3. Convertit HTML→texte via htmlToText (helper canonique du pont mail).
//   4. INSERT un ticket_message au début du fil (created_at = received_at
//      du mail original si dispo, sinon ticket.created_at), email_sent_at
//      = now() pour ne pas déclencher l'outbox.
//   5. UPDATE tickets.description en ligne courte.
//
// Mode --check : dry-run, affiche les tickets candidats et l'auteur détecté
//                sans rien modifier.
//
// Idempotence : on ne touche pas un ticket qui a déjà un message du même
// auteur avec une partie du contenu — re-run safe sur le même set.

import pg from 'pg'
import { htmlToText } from '../modules/email-bridge/lib/body-text.js'

const dryRun = process.argv.includes('--check')

const HTML_RE = /<(html|body|head|div|p|br|meta|style)[\s>]/i

const DATE_FMT_FR = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})
function formatDateFr(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return DATE_FMT_FR.format(d).replace(':', 'h')
}

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

// Détermine l'auteur et la date pour le premier ticket_message à créer.
// Stratégie : email_thread_mapping inbound le plus ancien sur ce ticket
// (= le mail d'origine). À défaut, users_cache via tickets.user_id.
async function resolveAuthor(db, ticket) {
  const { rows: mapRows } = await db.query(`
    SELECT from_address, received_at, raw
    FROM email_thread_mapping
    WHERE ticket_id = $1 AND direction = 'inbound'
    ORDER BY received_at ASC NULLS LAST, id ASC
    LIMIT 1
  `, [ticket.id])
  if (mapRows.length) {
    const r = mapRows[0]
    const fromName = r.raw?.from?.emailAddress?.name || r.from_address || null
    return {
      name: fromName || r.from_address || 'expéditeur inconnu',
      receivedAt: r.received_at,
      via: 'email_thread_mapping',
    }
  }
  if (ticket.user_id) {
    const { rows: uRows } = await db.query(
      `SELECT display_name, email FROM users_cache WHERE entra_id = $1`, [ticket.user_id]
    )
    if (uRows.length) {
      return {
        name: uRows[0].display_name || uRows[0].email || ticket.user_id,
        receivedAt: ticket.created_at,
        via: 'users_cache(user_id)',
      }
    }
  }
  return { name: 'utilisateur inconnu', receivedAt: ticket.created_at, via: 'fallback' }
}

// Exporté pour permettre aux tests d'injecter leur propre pool (schema random
// rejoué par acquireSchema()). En CLI, main() crée son propre pool.
export async function runMigration(db, { dryRun = false, log = console } = {}) {
  const { rows: tickets } = await db.query(`
    SELECT id, title, description, user_id, created_at
    FROM tickets
    WHERE description IS NOT NULL
      AND description ~* '<(html|body|head|div|p|br|meta|style)[[:space:]>]'
    ORDER BY created_at ASC
  `)
  log.log(`${tickets.length} ticket(s) avec description HTML détecté(s).${dryRun ? ' (dry-run)' : ''}`)

  let migrated = 0
  let skipped = 0
  for (const tk of tickets) {
    if (!HTML_RE.test(tk.description || '')) { skipped++; continue }
    const author = await resolveAuthor(db, tk)
    const bodyText = htmlToText(tk.description)
    if (!bodyText) { skipped++; continue }

    // Idempotence : si un message du même auteur existe déjà sur ce ticket,
    // on suppose que le script est déjà passé sur ce ticket — skip.
    const { rows: existing } = await db.query(
      `SELECT id FROM ticket_messages WHERE ticket_id = $1 AND author = $2 LIMIT 1`,
      [tk.id, author.name]
    )
    if (existing.length) {
      log.log(`  - skip ${tk.id} : message ${author.name} déjà présent`)
      skipped++
      continue
    }

    const dateFr = formatDateFr(author.receivedAt)
    const newDescription = dateFr ? `Mail de ${author.name} reçu le ${dateFr}` : `Mail de ${author.name}`

    log.log(`  - ${tk.id} | "${(tk.title || '').slice(0, 60)}" | auteur=${author.name} (${author.via}) | body=${bodyText.length}c`)
    if (dryRun) { migrated++; continue }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at, created_at)
        VALUES ($1, 'comment', $2, $3, now(), COALESCE($4::timestamptz, now()))
      `, [tk.id, author.name, bodyText, author.receivedAt || null])
      await client.query(
        `UPDATE tickets SET description = $1 WHERE id = $2`,
        [newDescription, tk.id]
      )
      await client.query('COMMIT')
      migrated++
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      log.error?.(`  ! erreur sur ${tk.id} : ${err.message}`)
    } finally {
      client.release()
    }
  }

  log.log(`\nRésumé : ${migrated} migré(s), ${skipped} ignoré(s).`)
  return { migrated, skipped, total: tickets.length }
}

// Entrée CLI. Ne s'exécute que si on lance directement ce fichier (pas en import).
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const db = newPool()
  runMigration(db, { dryRun })
    .catch(err => { console.error('Échec migration :', err); process.exit(1) })
    .finally(() => db.end())
}
