// Helpers de gestion des relations M2M ticket ↔ users / devices (Phase 2).
//
// Pour limiter le diff côté front et garder les vues existantes en lecture,
// on conserve `tickets.user_id` et `tickets.device_id` synchronisés sur le
// requester / le device "primary" (le plus ancien) via dual-write applicatif.
// Toutes les routes qui touchent à ces colonnes passent par ces helpers.
//
// Drop de tickets.user_id/device_id : prévu en migration 061 séparée après
// validation prod.

// Ajoute / change le requester d'un ticket. Un seul requester par ticket
// (cf. UNIQUE INDEX ux_ticket_users_one_requester). On supprime l'ancien,
// on insère le nouveau, on sync tickets.user_id. newUserId NULL = retire
// le requester sans en mettre d'autre.
export async function syncRequester(client, ticketId, newUserId) {
  await client.query(
    `DELETE FROM ticket_users WHERE ticket_id = $1 AND role = 'requester'`,
    [ticketId]
  )
  if (newUserId) {
    // ON CONFLICT : le user était peut-être déjà en 'involved' sur ce ticket,
    // on le promote en 'requester'.
    await client.query(`
      INSERT INTO ticket_users (ticket_id, user_entra_id, role)
      VALUES ($1, $2, 'requester')
      ON CONFLICT (ticket_id, user_entra_id) DO UPDATE SET role = 'requester'
    `, [ticketId, newUserId])
  }
  await client.query(
    `UPDATE tickets SET user_id = $1 WHERE id = $2`,
    [newUserId || null, ticketId]
  )
}

// Ajoute un user "involved" (= sans role privilégié). Pas de promotion
// implicite : si on veut promouvoir en requester, c'est via syncRequester.
export async function addInvolvedUser(client, ticketId, userEntraId) {
  await client.query(`
    INSERT INTO ticket_users (ticket_id, user_entra_id, role)
    VALUES ($1, $2, 'involved')
    ON CONFLICT (ticket_id, user_entra_id) DO NOTHING
  `, [ticketId, userEntraId])
}

// Retire un user du ticket. Si c'était le requester, tickets.user_id devient
// NULL (pas de "successor" automatique : décision explicite de l'admin).
export async function removeUserFromTicket(client, ticketId, userEntraId) {
  const { rows } = await client.query(
    `DELETE FROM ticket_users WHERE ticket_id = $1 AND user_entra_id = $2
     RETURNING role`,
    [ticketId, userEntraId]
  )
  if (rows.length && rows[0].role === 'requester') {
    await client.query(`UPDATE tickets SET user_id = NULL WHERE id = $1`, [ticketId])
  }
  return rows.length > 0
}

// Ajoute un device à un ticket. Si c'est le premier (tickets.device_id IS
// NULL), on le promote en "primary" pour la compat lecture.
export async function addDeviceToTicket(client, ticketId, deviceId) {
  await client.query(`
    INSERT INTO ticket_devices (ticket_id, device_id)
    VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [ticketId, deviceId])
  await client.query(`
    UPDATE tickets SET device_id = $1
    WHERE id = $2 AND device_id IS NULL
  `, [deviceId, ticketId])
}

// Retire un device. Si c'était tickets.device_id (le "primary"), on pick
// le plus ancien restant (par added_at) — fallback NULL s'il n'y en a plus.
export async function removeDeviceFromTicket(client, ticketId, deviceId) {
  const { rowCount } = await client.query(
    `DELETE FROM ticket_devices WHERE ticket_id = $1 AND device_id = $2`,
    [ticketId, deviceId]
  )
  if (!rowCount) return false

  // Si on vient de retirer le primary, prendre le plus ancien restant.
  const { rows } = await client.query(
    `SELECT device_id FROM tickets WHERE id = $1`, [ticketId]
  )
  if (rows[0]?.device_id === deviceId) {
    const { rows: next } = await client.query(
      `SELECT device_id FROM ticket_devices
       WHERE ticket_id = $1 ORDER BY added_at ASC LIMIT 1`,
      [ticketId]
    )
    await client.query(
      `UPDATE tickets SET device_id = $1 WHERE id = $2`,
      [next[0]?.device_id || null, ticketId]
    )
  }
  return true
}

// Charge les users liés à une liste de tickets, retourne Map(ticketId → [{...}]).
// Inclut le requester ET les involved, distinguables par `role`.
export async function loadRelatedUsersFor(db, ticketIds) {
  if (!ticketIds.length) return new Map()
  const { rows } = await db.query(`
    SELECT tu.ticket_id, tu.user_entra_id AS entra_id, tu.role, tu.added_at,
           u.display_name, u.email
    FROM ticket_users tu
    LEFT JOIN users_cache u ON u.entra_id = tu.user_entra_id
    WHERE tu.ticket_id = ANY($1)
    ORDER BY (tu.role = 'requester') DESC, tu.added_at ASC
  `, [ticketIds])
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.ticket_id)) map.set(r.ticket_id, [])
    map.get(r.ticket_id).push({
      entra_id:     r.entra_id,
      role:         r.role,
      display_name: r.display_name,
      email:        r.email,
    })
  }
  return map
}

export async function loadRelatedDevicesFor(db, ticketIds) {
  if (!ticketIds.length) return new Map()
  const { rows } = await db.query(`
    SELECT td.ticket_id, td.device_id AS id, td.added_at, d.hostname
    FROM ticket_devices td
    LEFT JOIN devices d ON d.id = td.device_id
    WHERE td.ticket_id = ANY($1)
    ORDER BY td.added_at ASC
  `, [ticketIds])
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.ticket_id)) map.set(r.ticket_id, [])
    map.get(r.ticket_id).push({ id: r.id, hostname: r.hostname })
  }
  return map
}

// Merge : transfère tout du ticket source vers target en une tx.
// - ticket_messages : repointés (avec note system "Fusionné depuis #X")
// - ticket_users    : promotion requester → involved si target a déjà un requester
// - ticket_devices  : ON CONFLICT DO NOTHING (un device peut être déjà sur target)
// - email_thread_mapping : repointés
// - source.status='merged', source.merged_into=target_id
//
// Garde-fous : self-merge interdit, source déjà merged interdit, cycles
// interdits (target ne doit pas pointer vers source via merged_into).
export async function mergeTicketInto(client, { sourceId, targetId, byName }) {
  if (sourceId === targetId) throw new Error('SELF_MERGE')

  const { rows: srcRows } = await client.query(
    `SELECT status, merged_into FROM tickets WHERE id = $1 FOR UPDATE`,
    [sourceId]
  )
  if (!srcRows.length) throw new Error('SOURCE_NOT_FOUND')
  if (srcRows[0].status === 'merged') throw new Error('SOURCE_ALREADY_MERGED')

  const { rows: tgtRows } = await client.query(
    `SELECT status, merged_into FROM tickets WHERE id = $1 FOR UPDATE`,
    [targetId]
  )
  if (!tgtRows.length) throw new Error('TARGET_NOT_FOUND')
  // Si la cible est elle-même merged ailleurs : refuser, l'admin doit
  // explicitement choisir le target final (sinon enfilade de merges).
  if (tgtRows[0].status === 'merged') throw new Error('TARGET_ALREADY_MERGED')

  // Note system côté target pour tracer
  await client.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content, email_sent_at)
    VALUES ($1, 'system', $2, $3, now())
  `, [targetId, byName || 'Système', `Fusion : messages et personnes du ticket ${sourceId} ajoutés ici`])

  // 1. Messages : repointer
  await client.query(
    `UPDATE ticket_messages SET ticket_id = $1 WHERE ticket_id = $2`,
    [targetId, sourceId]
  )

  // 2. ticket_users : INSERT ... ON CONFLICT DO NOTHING. Si la cible a déjà
  // un requester, les requesters de la source deviennent 'involved' (pas de
  // PROMOTE qui écraserait le requester existant).
  const { rows: targetHasRequester } = await client.query(
    `SELECT 1 FROM ticket_users WHERE ticket_id = $1 AND role = 'requester' LIMIT 1`,
    [targetId]
  )
  if (targetHasRequester.length) {
    await client.query(`
      INSERT INTO ticket_users (ticket_id, user_entra_id, role)
      SELECT $1, user_entra_id, 'involved' FROM ticket_users WHERE ticket_id = $2
      ON CONFLICT (ticket_id, user_entra_id) DO NOTHING
    `, [targetId, sourceId])
  } else {
    await client.query(`
      INSERT INTO ticket_users (ticket_id, user_entra_id, role)
      SELECT $1, user_entra_id, role FROM ticket_users WHERE ticket_id = $2
      ON CONFLICT (ticket_id, user_entra_id) DO NOTHING
    `, [targetId, sourceId])
    // Sync tickets.user_id si on vient d'hériter d'un requester
    const { rows: newReq } = await client.query(
      `SELECT user_entra_id FROM ticket_users WHERE ticket_id = $1 AND role = 'requester'`,
      [targetId]
    )
    if (newReq.length) {
      await client.query(
        `UPDATE tickets SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
        [newReq[0].user_entra_id, targetId]
      )
    }
  }
  // Cleanup ticket_users de source (avant suppression via ON DELETE CASCADE)
  await client.query(`DELETE FROM ticket_users WHERE ticket_id = $1`, [sourceId])

  // 3. ticket_devices : idem
  await client.query(`
    INSERT INTO ticket_devices (ticket_id, device_id)
    SELECT $1, device_id FROM ticket_devices WHERE ticket_id = $2
    ON CONFLICT (ticket_id, device_id) DO NOTHING
  `, [targetId, sourceId])
  // Sync tickets.device_id si target n'avait pas de primary
  await client.query(`
    UPDATE tickets SET device_id = (
      SELECT device_id FROM ticket_devices WHERE ticket_id = $1
      ORDER BY added_at ASC LIMIT 1
    )
    WHERE id = $1 AND device_id IS NULL
  `, [targetId])
  await client.query(`DELETE FROM ticket_devices WHERE ticket_id = $1`, [sourceId])

  // 4. email_thread_mapping : repointer (les futurs mails de réponse à
  // l'ancien thread arrivent maintenant sur target)
  await client.query(
    `UPDATE email_thread_mapping SET ticket_id = $1 WHERE ticket_id = $2`,
    [targetId, sourceId]
  )

  // 5. Marquer la source comme mergée
  await client.query(`
    UPDATE tickets
    SET status = 'merged', merged_into = $1, updated_at = now()
    WHERE id = $2
  `, [targetId, sourceId])

  // 6. Bump du target
  await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [targetId])
}
