// Parcours d'une boîte mail par curseur, commun au worker de polling
// inbound (poll-worker.js, receivedDateTime) et à celui des Éléments
// envoyés (sent-poll-worker.js, sentDateTime).
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
// Pagination : au plus MAX_PAGES pages par tick, et plus de nouvelle page
// une fois PAGE_SIZE mails traités (la charge d'un tick reste celle d'avant
// la pagination). Après une page qui a fait avancer le curseur, la suivante
// est relue depuis lui (reprise par clé) plutôt que via `@odata.nextLink`,
// qui est un décalage `$skip` sensible aux mails retirés entre deux pages.
// Le curseur avance aussi sur les mails exclus (dossiers système) : une
// page qui n'en contient que ne bloque plus la boîte.
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
export const MAX_PAGES = 5          // pages Graph avec du travail, par tick
export const MAX_SKIP_PAGES = 40    // pages d'ids `done` seulement (ex aequo), par tick
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
//   list(mailbox, since, { top, inclusive, nextLink }) → page Graph
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
  let skipPages = 0
  let processed = 0
  let progressed = false
  let blocked = false
  let listFrom = cursor
  let nextLink = null
  let graphNext = null

  do {
    let page
    try {
      page = await list(mailbox, listFrom, { top: PAGE_SIZE, inclusive: true, nextLink })
    } catch (err) {
      errors++
      log?.warn({ err: err.message, mailbox }, `${tag}: listing Graph a échoué`)
      break
    }
    const atBefore = at
    let skipOnly = true

    const toProcess = new Set(page?.value || [])
    for (const m of page?.scanned || page?.value || []) {
      const key = messageKey(m)
      const ts = Date.parse(m?.[dateField])
      // Déjà traité à l'horodatage du curseur (listing inclusif) → rien à faire.
      if (!(ts > at) && key && done.has(key)) continue
      skipOnly = false

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

    // Une page d'ids déjà traités (ex aequo relus par le listing inclusif)
    // ne coûte ni DB ni traitement : décomptée à part (MAX_SKIP_PAGES), pour
    // qu'une rafale de plus de MAX_PAGES × PAGE_SIZE mails dans la même
    // seconde n'occupe pas toute la fenêtre du tick.
    if (skipOnly) skipPages++
    else pages++

    if (blocked) break
    // Page suivante. Le nextLink Graph est un décalage (`$skip`), pas un
    // instantané : si un mail de cette page quitte la plage entre-temps
    // (suppression, brouillon envoyé, envoyé rangé ailleurs), la page
    // suivante commence un mail trop loin, et ce mail, plus ancien que le
    // curseur avancé, serait perdu. Si le curseur a avancé, on relit donc
    // depuis lui (`ge at`, reprise par clé). Le nextLink ne sert que pour
    // une page d'ex aequo qui n'a pas fait avancer le curseur.
    graphNext = page?.['@odata.nextLink'] || null
    if (at > atBefore) {
      nextLink = null
      listFrom = new Date(at).toISOString()
    } else {
      nextLink = graphNext
    }
  } while (graphNext && pages < MAX_PAGES && skipPages < MAX_SKIP_PAGES && processed < PAGE_SIZE)

  // Dernier recours : MAX_SKIP_PAGES pages d'ex aequo déjà traités sans rien
  // de nouveau (plus de MAX_SKIP_PAGES × PAGE_SIZE mails dans la même
  // seconde) — le listing inclusif ne dépasserait jamais ce paquet et la
  // boîte serait bloquée. On passe à la seconde suivante (secondes pleines :
  // les millisecondes d'un curseur initialisé par now() feraient sauter les
  // mails de la seconde suivante) ; les mails de cette seconde pas encore
  // lus ne seront PAS ingérés — signalé en erreur, avec le décompte.
  if (!progressed && !blocked && graphNext && skipPages >= MAX_SKIP_PAGES) {
    log?.error({ mailbox, cursor, already_handled: done.size },
      `${tag}: plus de ${done.size} mails dans la même seconde, curseur passé à la seconde suivante — les mails restants de cette seconde ne sont PAS ingérés`)
    at = Math.floor(at / 1000) * 1000 + 1000
    done.clear()
  }

  const newCursor = new Date(at).toISOString()
  const newState = JSON.stringify({ at: newCursor, done: [...done], retry })
  if (newCursor !== cursor || newState !== rawState) {
    await saveCursor(db, updatedBy, [[cursorKey, newCursor], [stateKey, newState]])
  }
  return { errors, abandoned }
}
