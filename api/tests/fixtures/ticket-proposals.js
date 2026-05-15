// Seeds réutilisables pour la table ticket_proposals.

export async function seedProposal(db, {
  source = 'manual',
  suggestedTitle = 'Proposition test',
  suggestedDescription = null,
  suggestedPriority = 'normal',
  suggestedDeviceId = null,
  suggestedUserId = null,
  status = 'pending',
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO ticket_proposals
       (source, suggested_title, suggested_description, suggested_priority,
        suggested_device_id, suggested_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [source, suggestedTitle, suggestedDescription, suggestedPriority,
     suggestedDeviceId, suggestedUserId, status]
  )
  return rows[0]
}
