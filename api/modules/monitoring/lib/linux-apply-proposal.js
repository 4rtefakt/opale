// Proposition de ticket pour un poste Linux dont l'application de la
// configuration vient de passer en échec (docs/linux-fleet-design.md §4).
// Même précédent que createComplianceProposal (compliance.js) : idempotente
// tant qu'une proposition `pending` existe pour le poste (clé :
// source_payload.device_id) ; une fois acceptée ou rejetée par l'admin, la
// prochaine transition en échec en recrée une (chaque transition est un
// événement distinct).

export async function createLinuxApplyProposal(db, { deviceId, hostname, revision, errorSummary, reportId }) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM ticket_proposals
    WHERE source = 'linux_apply' AND status = 'pending' AND source_payload->>'device_id' = $1
    LIMIT 1
  `, [deviceId])
  if (rowCount) return null

  const title = `Linux : application en échec — ${hostname || 'poste inconnu'}`
  const description =
    `L’application de la configuration (ansible-pull) a échoué sur le poste ${hostname || deviceId}.\n` +
    `Révision : ${revision ?? 'inconnue (étape git en échec)'}.\n` +
    (errorSummary ? `Erreur : ${errorSummary}` : '')
  const { rows: [row] } = await db.query(`
    INSERT INTO ticket_proposals
      (source, source_ref_type, source_ref_id, source_payload,
       suggested_title, suggested_description, suggested_priority, suggested_device_id)
    VALUES ('linux_apply', 'linux_apply_report', $1, $2::jsonb, $3, $4, 'high', $5)
    RETURNING id
  `, [
    reportId,
    JSON.stringify({ device_id: deviceId, report_id: reportId, revision, error_summary: errorSummary ?? null }),
    title,
    description,
    deviceId,
  ])
  return row.id
}
