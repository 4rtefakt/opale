// Validation du motif requis avant ouverture d'une session distante (console-
// via-agent SYSTEM, SSH). Conformité RGPD / sécurité : toute prise de main
// admin sur un poste laisse une trace explicite "pourquoi".
//
// Choix v1 :
//   - Set fixe de catégories (pas d'admin UI pour les éditer — voir
//     project_compliance.md pour le même choix philosophique).
//   - Note libre OBLIGATOIRE à chaque ouverture (5..500 chars), peu importe
//     la catégorie. Couvre le cas où la catégorie seule ne suffit pas en
//     audit (ex: "incident — alerte disque critique remontée à 14h sur
//     PC-LAB-12").

export const REASON_CATEGORIES = ['maintenance', 'troubleshoot', 'audit', 'incident', 'other']

const NOTE_MIN = 5
const NOTE_MAX = 500

// parseReason — valide le body.reason d'un endpoint /grant. Retourne :
//   { ok: true,  reason: { category, note } }    si valide
//   { ok: false, error: string }                 sinon (à renvoyer en 400)
//
// Volontairement strict : un client buggué doit échouer fort, pas dégrader
// silencieusement vers "motif vide" qui défaite tout l'intérêt audit.
export function parseReason(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'reason requis ({ category, note })' }
  }
  const category = String(input.category || '').trim().toLowerCase()
  if (!REASON_CATEGORIES.includes(category)) {
    return { ok: false, error: `category invalide (attendu : ${REASON_CATEGORIES.join('|')})` }
  }
  const note = String(input.note || '').trim()
  if (note.length < NOTE_MIN) {
    return { ok: false, error: `note trop courte (min ${NOTE_MIN} caractères)` }
  }
  if (note.length > NOTE_MAX) {
    return { ok: false, error: `note trop longue (max ${NOTE_MAX} caractères)` }
  }
  return { ok: true, reason: { category, note } }
}

// formatReasonLine — rendu compact pour insertion dans un ticket_message
// system ou un audit_log details. Ex:
//   "incident · alerte disque critique remontée à 14h"
export function formatReasonLine(reason) {
  if (!reason || !reason.category) return ''
  if (!reason.note) return reason.category
  return `${reason.category} · ${reason.note}`
}
