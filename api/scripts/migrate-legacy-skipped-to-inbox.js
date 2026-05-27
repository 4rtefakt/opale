#!/usr/bin/env node
// Migration de data ponctuelle (post-Phase-3).
//
// AVANT : les mails entrants classifiés 'other' par l'IA étaient marqués
//         action='skipped_other' et oubliés en DB (= invisibles côté UI).
// APRÈS Phase 3 : tous les mails entrants arrivent en 'pending_review'
//         pour arbitrage humain via la vue "Mails à trier". Plus de
//         décision automatique.
//
// Ce script remet les mails legacy mis de côté (action='skipped_other',
// ticket_id IS NULL) dans la file à trier (action='pending_review') pour
// que l'admin vérifie qu'il n'y a pas de faux positifs IA passés
// silencieusement.
//
// En bonus, si le classifier Ollama est configuré, on relance une
// classification advisory (le nouveau pipeline ne s'en sert plus pour
// décider, mais la suggestion visuelle reste utile).
//
// Mode --check : dry-run, liste les mappings concernés sans modifier.
//
// Idempotent : un mapping déjà passé en pending_review par le script ne
// sera pas re-traité au run suivant (le filtre WHERE action='skipped_other'
// suffit).

import pg from 'pg'
import { htmlToText } from '../modules/email-bridge/lib/body-text.js'
import { classifyWithOllama } from '../modules/email-bridge/lib/classify.js'

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

// Lit la conf classifier (cf. process-mail.js classifySafe). Si désactivé
// ou mal configuré, on retourne null → le script skip juste la re-classify
// et garde le classifier_result existant.
async function getClassifierConfig(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN (
       'mail.classifier.url', 'mail.classifier.model', 'mail.classifier.enabled'
     )`
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  if (map['mail.classifier.enabled'] !== 'true') return null
  if (!map['mail.classifier.url'] || !map['mail.classifier.model']) return null
  return { url: map['mail.classifier.url'], model: map['mail.classifier.model'] }
}

// Exporté pour les tests. Le caller fournit le pool db + une option
// classifierFn pour stubber l'appel Ollama dans les tests.
export async function runMigration(db, { dryRun = false, log = console, classifierFn } = {}) {
  const { rows } = await db.query(`
    SELECT id, mailbox, from_address, subject, raw, classifier_result
    FROM email_thread_mapping
    WHERE direction = 'inbound'
      AND action = 'skipped_other'
      AND ticket_id IS NULL
    ORDER BY received_at ASC NULLS LAST
  `)
  log.log(`${rows.length} mappings legacy 'skipped_other' à re-traiter.${dryRun ? ' (dry-run)' : ''}`)

  const cfg = await getClassifierConfig(db)
  if (!cfg && !classifierFn) {
    log.log('Classifier non configuré → on re-injecte en pending_review sans re-classifier.')
  }

  let migrated = 0
  let reclassified = 0
  let failed = 0

  for (const m of rows) {
    const graphMessage = m.raw || {}
    const bodyPreview = htmlToText(graphMessage.bodyPreview || '')

    let newClassifier = m.classifier_result
    if (cfg || classifierFn) {
      try {
        const fn = classifierFn || classifyWithOllama
        const result = await fn({
          from: m.from_address, subject: m.subject, bodyPreview,
        }, cfg || {})
        newClassifier = { ...result, reclassified_at: new Date().toISOString() }
        reclassified++
      } catch (err) {
        log.warn?.(`  ! ${m.id} : classifier échec (${err.message}), classifier_result inchangé`)
        failed++
      }
    }

    log.log(`  - ${m.id} | ${(m.subject || '').slice(0, 60)} | from=${m.from_address}`)
    if (dryRun) { migrated++; continue }

    await db.query(`
      UPDATE email_thread_mapping
      SET action = 'pending_review',
          classifier_result = $1,
          processed_at = now()
      WHERE id = $2 AND action = 'skipped_other'
    `, [JSON.stringify(newClassifier), m.id])
    migrated++
  }

  log.log(`\nRésumé : ${migrated} re-injectés, ${reclassified} re-classifiés, ${failed} classify échoués.`)
  return { total: rows.length, migrated, reclassified, failed }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const db = newPool()
  runMigration(db, { dryRun })
    .catch(err => { console.error('Échec migration :', err); process.exit(1) })
    .finally(() => db.end())
}
