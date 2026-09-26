// Parcours d'une boîte mail par curseur, pour le worker de polling inbound
// (poll-worker.js).
//
// Curseur : setting `<cursorKey>` = horodatage ISO 8601 du dernier mail
// traité (format inchangé : lu tel quel par /api/email/status et par une
// version antérieure de l'API en cas de retour arrière).
//
// État complémentaire : setting `<stateKey>` (JSON) { at, done, retry }
//   - at    : curseur auquel l'état se rapporte. Ignoré s'il ne correspond
//             plus (curseur réinitialisé à la main, état écrit par une autre
//             version…) : on repart alors d'un `done` vide, sans risque — les
//             mails déjà ingérés sont dédoublonnés par internet_message_id ;
//   - done  : ids Graph des mails déjà traités (ou volontairement ignorés) à
//             l'horodatage `at` ;
//   - retry : { id, attempts, error } du mail en échec qui bloque la boîte.
//
// Le listing est INCLUSIF (`ge at`) : un `gt` sautait pour toujours les
// mails de même horodatage que le dernier traité (coupure de page, mail
// visible un peu plus tard). Les mails de `done` sont écartés sans être
// retraités — ni requête DB, ni appel Graph.
//
// Pagination : on suit `@odata.nextLink`, au plus MAX_PAGES pages par tick,
// et on ne charge plus de page une fois PAGE_SIZE mails traités (la charge
// d'un tick reste celle d'avant la pagination). Le curseur avance aussi sur
// les mails exclus (dossiers système) : une page qui n'en contient que ne
// bloque plus la boîte.
//
// Échecs : le curseur n'avance que sur le préfixe contigu de mails traités
// (ou exclus). Au premier échec transitoire (transaction annulée, DB
// indisponible…), on arrête la boîte pour ce tick : le mail est retenté au
// tick suivant, avant les suivants (ordre du fil préservé). Après
// MAX_INGEST_ATTEMPTS échecs consécutifs du même mail, il est abandonné
// (log + audit `mail_ingest_abandoned`) pour qu'un mail « poison » ne
// bloque pas la boîte indéfiniment — même principe que le dead-letter de
// l'outbox. Il reste ré-ingérable en reculant le curseur (les autres mails
// sont alors dédoublonnés par internet_message_id).

import { logAudit } from '../../core/lib/audit.js'

export const PAGE_SIZE = 50
export const MAX_PAGES = 5
export const MAX_INGEST_ATTEMPTS = 5

// Clé d'un mail dans `done` : l'id Graph (unique dans la boîte ; deux copies
// d'un même internetMessageId — Envoyés + Réception — sont deux mails).
function messageKey(m) {
  return m?.id || m?.internetMessageId || null
}

function parseState(raw, cursorIso) {
  try {
    const s = JSON.parse(raw)
    if (s && s.at === cursorIso && Array.isArray(s.done)) {
      const retry = s.retry?.id && Number.isInteger(s.retry.attempts) ? s.retry : null
      return { done: new Set(s.done), retry }
    }
  } catch { /* état absent ou illisible → on repart de zéro */ }
  return { done: new Set(), retry: null }
}

// Écrit curseur + état dans une seule requête (atomique) : un arrêt entre
// les deux ne peut pas laisser un état qui ne correspond pas au curseur.
async function saveCursor(db, updatedBy, entries) {
  const values = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, now(), $${entries.length * 2 + 1})`)
  await db.query(`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES ${values.join(', ')}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
  `, [...entries.flat(), updatedBy])
}

async function abandon(db, log, { mailbox, message, key, dateField, attempts, error, tag }) {
  const details = {
    level: 'warn',
    worker: tag,
    internet_message_id: message.internetMessageId || null,
    graph_message_id: key,
    date: message[dateField] || null,
    attempts,
    error,
  }
  log?.error({ mailbox, ...details },
    `${tag}: mail abandonné après ${attempts} échecs (ré-ingérable en reculant le curseur)`)
  await logAudit(db, log, { action: 'mail_ingest_abandoned', byUser: 'system', target: mailbox, details })
}

// Parcourt la boîte depuis `cursor` (ISO normalisé) et sauvegarde la
// progression.
//   list(mailbox, cursor, { top, inclusive, nextLink }) → page Graph
//     (`value` = mails à traiter, `scanned` = tous les mails de la page) ;
//   handle(message) → traite un mail de `value` ; { retry: true, error }
//     si l'échec est transitoire (rien d'écrit, à retenter).
// Retourne { errors, abandoned } (échecs de listing / mails abandonnés,
// déjà loggés).
export async function pollMailboxCursor(db, log, {
  mailbox, cursor, cursorKey, stateKey, dateField, list, handle, updatedBy, tag,
}) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [stateKey])
  const rawState = rows[0]?.value ?? null
  const state = parseState(rawState, cursor)
  const { done } = state
  let { retry } = state

  let at = Date.parse(cursor)
  let errors = 0
  let abandoned = 0
  let pages = 0
  let processed = 0
  let progressed = false
  let blocked = false
  let nextLink = null

  do {
    let page
    try {
      page = await list(mailbox, cursor, { top: PAGE_SIZE, inclusive: true, nextLink })
    } catch (err) {
      errors++
      log?.warn({ err: err.message, mailbox }, `${tag}: listing Graph a échoué`)
      break
    }
    pages++

    const toProcess = new Set(page?.value || [])
    for (const m of page?.scanned || page?.value || []) {
      const key = messageKey(m)
      const ts = Date.parse(m?.[dateField])
      // Déjà traité à l'horodatage du curseur (listing inclusif) → rien à faire.
      if (!(ts > at) && key && done.has(key)) continue

      if (toProcess.has(m)) {
        processed++
        const r = await handle(m)
        if (r?.retry) {
          const error = String(r.error || 'erreur inconnue').slice(0, 500)
          const attempts = (retry?.id === key ? retry.attempts : 0) + 1
          if (attempts < MAX_INGEST_ATTEMPTS) {
            // Curseur laissé avant ce mail : retenté au tick suivant.
            retry = { id: key, attempts, error }
            blocked = true
            log?.warn({ mailbox, internetMessageId: m.internetMessageId, attempts, err: error },
              `${tag}: échec de traitement, mail retenté au prochain tick`)
            break
          }
          await abandon(db, log, { mailbox, message: m, key, dateField, attempts, error, tag })
          abandoned++
        }
      }
      // Traité, volontairement exclu ou abandonné : le curseur avance jusqu'à lui.
      if (ts > at) { at = ts; done.clear() }
      if (key) done.add(key)
      if (retry?.id === key) retry = null
      progressed = true
    }

    if (blocked) break
    nextLink = page?.['@odata.nextLink'] || null
  } while (nextLink && pages < MAX_PAGES && processed < PAGE_SIZE)

  // Plus de MAX_PAGES × PAGE_SIZE mails au même horodatage, tous déjà
  // traités : le listing inclusif ne passerait jamais ce paquet. Cas
  // dégénéré (rafale dans la même seconde) : on passe la seconde, en le
  // signalant, plutôt que de bloquer la boîte.
  if (!progressed && !blocked && nextLink && pages >= MAX_PAGES) {
    log?.warn({ mailbox, cursor }, `${tag}: plus de ${MAX_PAGES * PAGE_SIZE} mails au même horodatage, curseur avancé d'une seconde`)
    at += 1000
    done.clear()
  }

  const newCursor = new Date(at).toISOString()
  const newState = JSON.stringify({ at: newCursor, done: [...done], retry })
  if (newCursor !== cursor || newState !== rawState) {
    await saveCursor(db, updatedBy, [[cursorKey, newCursor], [stateKey, newState]])
  }
  return { errors, abandoned }
}
