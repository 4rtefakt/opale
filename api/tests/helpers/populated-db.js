// Jeu de données « production » pour les tests de rejeu des migrations.
//
// Le runner de migrations (lib/migrations.js) rejoue tout fichier absent de
// schema_migrations — donc, au premier démarrage sur une base migrée à la
// main, TOUS les fichiers repassent sur des données réelles. La CI ne
// vérifiait l'idempotence que sur une base vide. Ce seed reproduit les
// états de données qui piégeaient un rejeu :
//
//   - 010 : poste créé par l'agent (source='agent') puis rapproché par la
//           sync Intune (intune_device_id posé) ;
//   - 043 : job de déploiement scope='native_group' (valeur ajoutée en 052,
//           refusée par la contrainte CHECK de 043) ;
//   - 060 : ticket fusionné (relations transférées à la cible, mais
//           tickets.user_id/device_id conservés sur la source) et ticket dont
//           le requester a divergé de tickets.user_id.
//
// Fonctionne sur un schéma où toutes les migrations sont appliquées.

export async function seedReplayHazards(db) {
  await db.query(`
    INSERT INTO users_cache (entra_id, display_name) VALUES
      ('replay-u1', 'Replay U1'), ('replay-u2', 'Replay U2')
  `)

  // 010 : poste enrôlé par l'agent, puis rattaché par la sync Intune.
  const { rows: [agentDev] } = await db.query(`
    INSERT INTO devices (hostname, serial, source, intune_device_id)
    VALUES ('PC-REPLAY-AGENT', 'SN-REPLAY-1', 'agent', 'intune-replay-1')
    RETURNING id
  `)
  const { rows: [otherDev] } = await db.query(`
    INSERT INTO devices (hostname, serial, source) VALUES ('PC-REPLAY-2', 'SN-REPLAY-2', 'agent')
    RETURNING id
  `)

  // 043 : job ciblant un groupe natif.
  const { rows: [group] } = await db.query(`
    INSERT INTO groups (name) VALUES ('Replay groupe') RETURNING id
  `)
  const { rows: [pkg] } = await db.query(`
    INSERT INTO packages (name, type, winget_id, status) VALUES ('Replay pkg', 'winget', 'Replay.Pkg', 'approved')
    RETURNING id
  `)
  const { rows: [job] } = await db.query(`
    INSERT INTO deployment_jobs (package_id, scope, native_group_id)
    VALUES ($1, 'native_group', $2) RETURNING id
  `, [pkg.id, group.id])

  // 060 (a) : fusion — relations de la source déplacées sur la cible, la
  // source garde user_id/device_id (cf. tickets/lib/relations.js).
  const { rows: [src] } = await db.query(`
    INSERT INTO tickets (title, status, user_id, device_id)
    VALUES ('Replay source fusionnée', 'merged', 'replay-u1', $1) RETURNING id
  `, [agentDev.id])
  const { rows: [tgt] } = await db.query(`
    INSERT INTO tickets (title, user_id) VALUES ('Replay cible', 'replay-u2') RETURNING id
  `)
  await db.query(`UPDATE tickets SET merged_into = $1 WHERE id = $2`, [tgt.id, src.id])
  await db.query(`
    INSERT INTO ticket_users (ticket_id, user_entra_id, role) VALUES
      ($1, 'replay-u2', 'requester'), ($1, 'replay-u1', 'involved')
  `, [tgt.id])
  await db.query(`INSERT INTO ticket_devices (ticket_id, device_id) VALUES ($1, $2)`, [tgt.id, agentDev.id])

  // 060 (b) : requester dans ticket_users différent de tickets.user_id.
  const { rows: [drift] } = await db.query(`
    INSERT INTO tickets (title, user_id) VALUES ('Replay divergent', 'replay-u1') RETURNING id
  `)
  await db.query(`
    INSERT INTO ticket_users (ticket_id, user_entra_id, role) VALUES ($1, 'replay-u2', 'requester')
  `, [drift.id])

  return { agentDev, otherDev, group, pkg, job, src, tgt, drift }
}

// Vérifie qu'un rejeu n'a rien modifié des données piégeuses.
export async function assertReplayHazardsIntact(db, assert, seed) {
  const { rows: [dev] } = await db.query(`SELECT source FROM devices WHERE id = $1`, [seed.agentDev.id])
  assert.equal(dev.source, 'agent', '010 ne doit pas rebasculer un poste agent en intune')

  const { rows: jobs } = await db.query(`SELECT scope FROM deployment_jobs WHERE id = $1`, [seed.job.id])
  assert.equal(jobs[0]?.scope, 'native_group', 'le job native_group doit survivre')

  const { rows: srcUsers } = await db.query(`SELECT 1 FROM ticket_users WHERE ticket_id = $1`, [seed.src.id])
  assert.equal(srcUsers.length, 0, '060 ne doit pas recréer les relations d’un ticket fusionné')
  const { rows: srcDevs } = await db.query(`SELECT 1 FROM ticket_devices WHERE ticket_id = $1`, [seed.src.id])
  assert.equal(srcDevs.length, 0, '060 ne doit pas recréer les postes d’un ticket fusionné')

  const { rows: driftUsers } = await db.query(
    `SELECT user_entra_id, role FROM ticket_users WHERE ticket_id = $1 ORDER BY user_entra_id`, [seed.drift.id]
  )
  assert.deepEqual(driftUsers, [{ user_entra_id: 'replay-u2', role: 'requester' }])
}
