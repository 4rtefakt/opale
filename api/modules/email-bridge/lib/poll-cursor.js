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
//   - retry : { id, internet_message_id, attempts, error, first_at, memo,
//             alerted } du mail en échec qui bloque la boîte. Clé = id
//             Graph : il change si le mail est déplacé de dossier pendant
//             les reprises, le compteur repart alors de zéro (retarde
//             l'abandon, ne perd rien — acceptable). `alerted` : blocage
//             déjà signalé à l'audit ;
//   - scan  : { id, at, done, since } position où la recherche de verdict
//             pour ce mail s'est arrêtée (cf. plus bas) — le curseur, lui,
//             reste avant le mail en échec.
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
// tick suivant, avant les suivants (ordre du fil préservé).
//
// Abandon d'un mail « poison » (pour qu'il ne bloque pas la boîte
// indéfiniment — même principe que le dead-letter de l'outbox), à trois
// conditions :
//   - au moins MAX_INGEST_ATTEMPTS échecs ET MIN_POISON_AGE_MS depuis le
//     premier : un échec propre au mail mais passager (verrou sur son
//     ticket, statement_timeout…) a le temps de se résorber ;
//   - un mail SUIVANT de la boîte est traité avec une écriture commitée
//     (ceux qui n'écrivent rien — déjà ingérés, non rattachés, doublons —
//     ne prouvent rien et sont passés). Si le premier suivant qui tente
//     d'écrire échoue lui aussi, la panne n'est pas propre au mail (pool
//     saturé, trigger ou contrainte cassés, droits retirés…) : rien n'est
//     abandonné, erreur journalisée à chaque tick, tout repart au
//     rétablissement. Sans verdict dans le tick (pas de mail suivant qui
//     écrit), on attend : le suspect ne bloque alors rien qui écrive.
//     Limite assumée : deux mails poison consécutifs sont indiscernables
//     d'une panne systémique — boîte bloquée, erreur à chaque tick, jusqu'à
//     intervention (cause corrigée, ou curseur avancé à la main en SQL
//     au-delà du mail, cf. l'internetMessageId dans le log).
// L'abandon est journalisé (log error + audit `mail_ingest_abandoned`). Le
// mail reste ré-ingérable en reculant le curseur (les autres mails sont
// alors dédoublonnés par internet_message_id). Un blocage systémique est
// signalé une fois par l'audit `mail_ingest_blocked` (avec la reprise
// manuelle en SQL), puis en log error à chaque tick.

import { logAudit } from '../../core/lib/audit.js'
import { stripNul } from './sanitize.js'

export const PAGE_SIZE = 50
export const MAX_PAGES = 5          // pages Graph avec du travail, par tick
export const MAX_SKIP_PAGES = 40    // pages d'ids `done` seulement (ex aequo), par tick
const VALVE_COUNT_PAGES = 10        // lecture seule, pour chiffrer les pertes du garde-fou
export const MAX_INGEST_ATTEMPTS = 5
// 30 min : couvre les incidents passagers usuels (verrou long, failover ou
// redémarrage Postgres, déploiement) ; en contrepartie un vrai mail poison
// retarde les mails suivants de sa boîte de 30 min, une fois — rare, et
// sans perte.
export const MIN_POISON_AGE_MS = 30 * 60_000
// Candidat à l'abandon sans verdict depuis 2 h (aucun mail suivant qui
// écrive) : signalé une fois à l'audit (`mail_ingest_blocked`, reason
// 'waiting') — sinon ce blocage resterait invisible.
export const SUSPECT_ALERT_MS = 2 * 3600_000

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
      const scan = retry && s.scan?.id === retry.id && Number.isFinite(Date.parse(s.scan.at)) && Array.isArray(s.scan.done)
        ? s.scan : null
      return { done: new Set(s.done), retry, scan }
    }
  } catch { /* état absent ou illisible → on repart de zéro */ }
  return { done: new Set(), retry: null, scan: null }
}

// Écrit curseur + état ensemble (une transaction), et seulement si le
// curseur vaut encore `expected` (lu en début de tick) : un UPDATE de
// l'admin pendant le tick (SQL de reprise d'un blocage) n'est pas défait —
// la progression du tick est alors abandonnée, le tick suivant repart de
// la valeur de l'admin (mails déjà ingérés dédoublonnés). FOR UPDATE : un
// UPDATE concurrent attend la fin de cette transaction, puis l'emporte.
async function saveCursor(db, log, { updatedBy, cursorKey, expected, entries, mailbox, tag }) {
  const values = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, now(), $${entries.length * 2 + 1})`)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT value FROM settings WHERE key = $1 FOR UPDATE', [cursorKey])
    if ((rows[0]?.value ?? null) !== expected) {
      await client.query('ROLLBACK')
      log?.warn({ mailbox, expected, found: rows[0]?.value ?? null },
        `${tag}: curseur modifié pendant le tick (reprise manuelle ?) — progression du tick non enregistrée`)
      return false
    }
    await client.query(`
      INSERT INTO settings (key, value, updated_at, updated_by)
      VALUES ${values.join(', ')}
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
    `, [...entries.flat(), updatedBy])
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Garde-fou : compte les mails à traiter de la seconde abandonnée qui n'ont
// pas été lus (hors `done`, hors exclus), en suivant le listing au plus
// VALVE_COUNT_PAGES pages. `exact` = on a atteint la seconde suivante ou la
// fin ; sinon `count` est un minimum.
async function countRestOfSecond({ mailbox, list, listFrom, nextLink, dateField, done, nextSecond }) {
  let count = 0
  for (let link = nextLink, pages = 0; link && pages < VALVE_COUNT_PAGES; pages++) {
    let page
    try {
      page = await list(mailbox, listFrom, { top: PAGE_SIZE, inclusive: true, nextLink: link })
    } catch {
      return { count, exact: false }
    }
    const toProcess = new Set(page?.value || [])
    for (const m of page?.scanned || page?.value || []) {
      if (Date.parse(m?.[dateField]) >= nextSecond) return { count, exact: true }
      if (toProcess.has(m) && !done.has(messageKey(m))) count++
    }
    link = page?.['@odata.nextLink'] || null
    if (!link) return { count, exact: true }
  }
  return { count, exact: false }
}

// Boîte bloquée : une ligne d'audit (niveau error) avec de quoi agir.
//   reason 'systemic' : le mail suivant échoue aussi (panne probable) ;
//   reason 'waiting'  : aucun mail suivant n'écrit depuis SUSPECT_ALERT_MS,
//                       pas de verdict possible.
// `log` = texte affiché dans le panneau dépliable du journal d'audit ;
// `recovery_sql` = dernier recours si le mail est lui-même irrécupérable.
async function alertBlocked(db, log, { mailbox, cursorKey, message, dateField, record, nextError = null, reason, tag }) {
  const ts = Date.parse(message[dateField])
  const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`
  const recoverySql = Number.isFinite(ts)
    ? `UPDATE settings SET value = ${sqlStr(new Date(Math.floor(ts / 1000) * 1000 + 1000).toISOString())} WHERE key = ${sqlStr(cursorKey)};`
    : null
  const cause = reason === 'waiting'
    ? `aucun mail suivant n'a été écrit depuis pour confirmer qu'il est seul en cause — il n'est pas abandonné.`
    : `le mail suivant échoue aussi — panne probablement systémique, aucun mail abandonné.`
  const details = {
    level: 'error',
    worker: tag,
    reason,
    internet_message_id: record.internet_message_id,
    graph_message_id: record.id,
    date: message[dateField] || null,
    since: record.first_at,
    attempts: record.attempts,
    error: record.error,
    next_error: nextError,
    recovery_sql: recoverySql,
    log: [
      `Ingestion bloquée : le mail ${record.internet_message_id || record.id} échoue depuis ${record.first_at} ` +
        `(${record.attempts} tentatives) et ${cause}`,
      `Erreur : ${record.error}`,
      ...(nextError ? [`Mail suivant : ${nextError}`] : []),
      `1. Corriger la cause (base, droits, trigger, contrainte…) : l'ingestion reprend seule, rien n'est perdu.`,
      ...(recoverySql ? [
        `2. Seulement si ce mail est lui-même irrécupérable (deux mails poison consécutifs), passer au-delà en SQL`,
        `   (saute aussi les autres mails de la même seconde) :`,
        `   ${recoverySql}`,
      ] : []),
    ].join('\n'),
  }
  await logAudit(db, log, { action: 'mail_ingest_blocked', byUser: 'system', target: mailbox, details: stripNul(details) })
}

async function abandon(db, log, { mailbox, message, key, dateField, attempts, error, tag }) {
  const details = {
    level: 'error',   // mail non ingéré : filtre « error » du journal d'audit
    worker: tag,
    internet_message_id: message.internetMessageId || null,
    graph_message_id: key,
    date: message[dateField] || null,
    attempts,
    error,
  }
  log?.error({ mailbox, ...details },
    `${tag}: mail abandonné après ${attempts} échecs (ré-ingérable en reculant le curseur)`)
  await logAudit(db, log, { action: 'mail_ingest_abandoned', byUser: 'system', target: mailbox, details: stripNul(details) })
}

// Parcourt la boîte depuis `cursor` (ISO normalisé) et sauvegarde la
// progression.
//   list(mailbox, since, { top, inclusive, nextLink }) → page Graph
//     (`value` = mails à traiter, `scanned` = tous les mails de la page) ;
//   handle(message, { memo }) → traite un mail de `value` ; { retry: true,
//     error, memo? } si l'échec est transitoire (rien d'écrit, à retenter) —
//     `memo` est rendu au handle à la reprise suivante du même mail — sinon
//     { wrote } (true si une écriture a été commitée) ;
//   now() → horloge (injectable pour les tests).
// Retourne { errors, abandoned } (échecs de listing / mails abandonnés,
// déjà loggés).
export async function pollMailboxCursor(db, log, {
  mailbox, cursor, cursorKey, stateKey, dateField, list, handle, updatedBy, tag, now = Date.now,
}) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [stateKey])
  const rawState = rows[0]?.value ?? null
  let { done, retry, scan } = parseState(rawState, cursor)
  // Mail candidat à l'abandon, dépassé provisoirement en attendant le
  // verdict du mail suivant ; `rollback` = position juste avant lui.
  let suspect = null
  // Position où la recherche de verdict s'est arrêtée au tick précédent
  // (`scan`, gardé dans l'état), et celle à garder en fin de tick.
  let jumpTo = null
  let keepScan = null

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
        const r = await handle(m, { memo: retry?.id === key ? retry.memo : undefined })
        // Pendant l'attente d'un verdict, un mail qui n'écrit rien ne
        // consomme pas le budget du tick (seules les MAX_PAGES bornent) :
        // sinon une suite de mails non rattachés (Éléments envoyés) après
        // le suspect empêcherait pour toujours d'atteindre le verdict.
        if (!(suspect && !r?.retry && !r?.wrote)) processed++
        if (r?.retry) {
          const error = String(r.error || 'erreur inconnue').slice(0, 500)
          if (suspect) {
            // Le mail suivant échoue aussi : panne systémique probable. Rien
            // n'est abandonné ; retour juste avant le suspect (les mails
            // dépassés depuis — exclus ou déjà traités — n'ont rien écrit).
            // La position juste avant ce mail est gardée : au tick suivant,
            // si le suspect échoue encore, on y retourne sans tout relire.
            keepScan = { id: suspect.key, at: new Date(at).toISOString(), done: [...done], since: suspect.since }
            ;({ at, done, retry } = suspect.rollback)
            log?.error({
              mailbox, internetMessageId: retry.internet_message_id,
              attempts: retry.attempts, since: retry.first_at, err: retry.error, next_err: error,
            }, `${tag}: le mail suivant échoue aussi — panne probablement systémique, aucun abandon (boîte bloquée jusqu'au rétablissement)`)
            // Une seule ligne d'audit par blocage (`alerted` gardé dans
            // l'état, effacé avec `retry` quand la boîte repart).
            if (!retry.alerted) {
              await alertBlocked(db, log, { mailbox, cursorKey, message: suspect.message, dateField, record: retry, nextError: error, reason: 'systemic', tag })
              retry.alerted = true
            }
            suspect = null
            blocked = true
            break
          }
          const same = retry?.id === key
          const attempts = (same ? retry.attempts : 0) + 1
          const firstAt = (same && retry.first_at) || new Date(now()).toISOString()
          const record = {
            id: key, internet_message_id: m.internetMessageId || null, attempts, error, first_at: firstAt,
            memo: r.memo ?? (same ? retry.memo : undefined),
            alerted: (same && retry.alerted) || undefined,
          }
          if (attempts < MAX_INGEST_ATTEMPTS || now() - Date.parse(firstAt) < MIN_POISON_AGE_MS) {
            // Curseur laissé avant ce mail : retenté au tick suivant.
            retry = record
            blocked = true
            log?.warn({ mailbox, internetMessageId: m.internetMessageId, attempts, since: firstAt, err: error },
              `${tag}: échec de traitement, mail retenté au prochain tick`)
            break
          }
          // Candidat à l'abandon : dépassé provisoirement ; abandonné
          // seulement si le mail suivant est traité sans erreur.
          const resumed = scan?.id === key ? scan : null
          suspect = {
            message: m, key, since: resumed?.since || new Date(now()).toISOString(),
            rollback: { at, done: new Set(done), retry: record },
          }
          scan = null
          if (resumed) {
            // Il échoue encore : la recherche de verdict reprend là où elle
            // s'était arrêtée (mails suivants déjà vus : rien d'écrit).
            jumpTo = resumed
            break
          }
        } else if (suspect && r?.wrote) {
          // Un mail suivant a ÉCRIT (commit) : la chaîne d'écriture marche,
          // l'échec était propre au suspect. Un mail qui n'écrit rien
          // (déjà ingéré, non rattaché, doublon) ne prouve rien : le suspect
          // reste en attente et on continue.
          const { attempts, error } = suspect.rollback.retry
          await abandon(db, log, { mailbox, message: suspect.message, key: suspect.key, dateField, attempts, error, tag })
          abandoned++
          suspect = null
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
    if (jumpTo) {
      at = Date.parse(jumpTo.at)
      done = new Set(jumpTo.done)
      listFrom = new Date(at).toISOString()
      nextLink = null
      graphNext = listFrom   // on relit depuis la position reprise
      jumpTo = null
      continue
    }
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

  // Pas de mail suivant qui écrive dans ce tick (fin de boîte, bornes du
  // tick, listing en échec) : pas de verdict, le suspect n'est pas
  // abandonné. La position atteinte est gardée (`scan`) : au tick suivant,
  // si le suspect échoue encore, la recherche reprend là — sans relire ni
  // retraiter les mails déjà vus (un getMessage Graph par doublon côté
  // Éléments envoyés). Au-delà de SUSPECT_ALERT_MS sans verdict, le
  // blocage est signalé une fois à l'audit.
  if (suspect) {
    keepScan = { id: suspect.key, at: new Date(at).toISOString(), done: [...done], since: suspect.since }
    ;({ at, done, retry } = suspect.rollback)
    blocked = true
    log?.warn({ mailbox, internetMessageId: retry.internet_message_id, attempts: retry.attempts, since: retry.first_at, err: retry.error },
      `${tag}: mail en échec prolongé, abandon en attente d'un mail suivant qui écrive`)
    if (!retry.alerted && now() - Date.parse(suspect.since) >= SUSPECT_ALERT_MS) {
      await alertBlocked(db, log, { mailbox, cursorKey, message: suspect.message, dateField, record: retry, reason: 'waiting', tag })
      retry.alerted = true
    }
    suspect = null
  }

  // Tick non bloqué après au moins une page listée : le mail en échec
  // (toujours en tête) a été dépassé ou n'est plus dans la plage (déplacé :
  // nouvel id Graph, supprimé…). Son compteur ne décrit plus rien — sinon
  // la boîte resterait affichée « bloquée » à tort.
  if (retry && !blocked && pages + skipPages > 0) retry = null

  // Dernier recours : MAX_SKIP_PAGES pages d'ex aequo déjà traités sans rien
  // de nouveau (plus de MAX_SKIP_PAGES × PAGE_SIZE mails dans la même
  // seconde) — le listing inclusif ne dépasserait jamais ce paquet et la
  // boîte serait bloquée. On passe à la seconde suivante (secondes pleines :
  // les millisecondes d'un curseur initialisé par now() feraient sauter les
  // mails de la seconde suivante) ; les mails de cette seconde pas encore
  // lus ne seront PAS ingérés — décomptés (au plus VALVE_COUNT_PAGES pages
  // de plus, lecture seule) et signalés en log error + audit.
  if (!progressed && !blocked && graphNext && skipPages >= MAX_SKIP_PAGES) {
    const nextSecond = Math.floor(at / 1000) * 1000 + 1000
    const lost = await countRestOfSecond({ mailbox, list, listFrom, nextLink: graphNext, dateField, done, nextSecond })
    const details = {
      level: 'error', worker: tag, cursor, next_cursor: new Date(nextSecond).toISOString(),
      already_handled: done.size, not_ingested: lost.count, not_ingested_exact: lost.exact,
    }
    log?.error({ mailbox, ...details },
      `${tag}: plus de ${done.size} mails dans la même seconde, curseur passé à la seconde suivante — ` +
      `${lost.exact ? '' : 'au moins '}${lost.count} mails de cette seconde ne sont PAS ingérés`)
    await logAudit(db, log, { action: 'mail_ingest_second_skipped', byUser: 'system', target: mailbox, details })
    at = nextSecond
    done.clear()
  }

  const newCursor = new Date(at).toISOString()
  const newState = JSON.stringify({ at: newCursor, done: [...done], retry, scan: retry && keepScan?.id === retry.id ? keepScan : undefined })
  if (newCursor !== cursor || newState !== rawState) {
    await saveCursor(db, log, {
      updatedBy, cursorKey, expected: cursor, entries: [[cursorKey, newCursor], [stateKey, newState]], mailbox, tag,
    })
  }
  return { errors, abandoned }
}
