// Helper : pousser un event `type='system'` dans tous les tickets ouverts/en
// cours qui concernent un device. Utilisé pour tracer les accès distants
// (console-via-agent, SSH) dans le fil des tickets connexes — l'admin qui
// suit un ticket voit immédiatement qu'une intervention a eu lieu sur le
// poste concerné, sans devoir cross-référencer avec /audit.
//
// Idempotence : un INSERT unique par session (open) + un autre (close). Si
// l'admin ouvre 3 consoles, 6 rows sont créées par ticket — c'est voulu,
// c'est de la traçabilité (pas de dédup).
//
// Best-effort : un échec d'INSERT NE DOIT PAS faire échouer l'ouverture
// de la console / SSH. L'appelant est responsable de catcher.
//
// Sécu : `content` est rendu côté front via `esc(m.content)` (cf.
// front/views/tickets.js:763), donc safe vis-à-vis XSS. La donnée est
// considérée sensible (motif lié à un incident, nom admin), à la même
// hauteur que les autres ticket_messages — déjà admin-only côté API.

export async function attachSystemEventToOpenTicketsOfDevice(db, deviceId, author, content) {
  if (!deviceId || !content) return { inserted: 0 }
  const { rowCount } = await db.query(`
    INSERT INTO ticket_messages (ticket_id, type, author, content)
    SELECT id, 'system', $1, $2
    FROM tickets
    WHERE device_id = $3
      AND status NOT IN ('resolved', 'closed')
  `, [author || 'Système', content, deviceId])
  return { inserted: rowCount }
}
