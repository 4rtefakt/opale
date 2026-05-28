#!/usr/bin/env node
// Purge des pièces jointes des tickets fermés depuis plus de 6 mois.
//
// Politique de rétention : une fois un ticket fermé (status='closed') et
// resté inactif 6 mois, ses pièces jointes sont supprimées (fichier disque
// + row DB). Le ticket et son fil de messages restent, seules les PJ sont
// purgées.
//
// "Fermé depuis 6 mois" est approximé par updated_at < now() - 6 mois : un
// ticket archivé n'est plus touché, donc updated_at ≈ date de fermeture.
//
// À brancher en cron (ex: hebdomadaire) côté infra :
//   docker compose exec -T api node /app/scripts/purge-old-attachments.js
//
// Mode --check : dry-run, liste sans supprimer.

import pg from 'pg'
import { deleteAttachmentFile } from '../modules/tickets/lib/attachments.js'

const dryRun = process.argv.includes('--check')

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

// Exporté pour les tests (injection du pool + horizon paramétrable).
export async function runPurge(db, { dryRun = false, log = console, interval = '6 months' } = {}) {
  const { rows } = await db.query(`
    SELECT a.id, a.storage_path, a.filename, a.ticket_id
    FROM ticket_attachments a
    JOIN tickets t ON t.id = a.ticket_id
    WHERE t.status = 'closed'
      AND t.updated_at < now() - ($1)::interval
    ORDER BY a.created_at ASC
  `, [interval])
  log.log(`${rows.length} pièce(s) jointe(s) à purger (tickets fermés > ${interval}).${dryRun ? ' (dry-run)' : ''}`)

  let purged = 0
  let fileErrors = 0
  for (const a of rows) {
    log.log(`  - ${a.id} | ${(a.filename || '').slice(0, 60)} | ticket ${a.ticket_id}`)
    if (dryRun) { purged++; continue }
    // Fichier d'abord (best-effort), puis la row. Si le fichier échoue
    // (hors ENOENT déjà ignoré), on log mais on supprime quand même la row
    // pour ne pas rester bloqué sur une PJ fantôme.
    try {
      await deleteAttachmentFile(a.storage_path)
    } catch (err) {
      log.warn?.(`    ! fichier non supprimé (${err.message})`)
      fileErrors++
    }
    await db.query(`DELETE FROM ticket_attachments WHERE id = $1`, [a.id])
    purged++
  }

  log.log(`\nRésumé : ${purged} purgée(s), ${fileErrors} erreur(s) fichier.`)
  return { total: rows.length, purged, fileErrors }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const db = newPool()
  runPurge(db, { dryRun })
    .catch(err => { console.error('Échec purge :', err); process.exit(1) })
    .finally(() => db.end())
}
