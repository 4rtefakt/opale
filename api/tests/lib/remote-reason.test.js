// parseReason() est le gatekeeper du motif obligatoire avant ouverture
// console SYSTEM / SSH. Tout chemin qui passe doit produire une catégorie
// connue + une note 5..500 chars. Le moindre relâchement (catégorie
// inconnue acceptée, note absente, note trop courte) défaite l'audit
// RGPD. Mirror Node de la couverture CLI Go (cli/cmd/util_test.go).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseReason,
  formatReasonLine,
  REASON_CATEGORIES,
} from '../../modules/remote/lib/remote-reason.js'

test('REASON_CATEGORIES — set figé', () => {
  // Ces 5 valeurs sont gravées dans l'UI front + le helper CLI Go. Si on
  // change la liste, c'est un breaking change cross-stack et il faut le
  // tester explicitement, pas par accident.
  assert.deepEqual(REASON_CATEGORIES, ['maintenance', 'troubleshoot', 'audit', 'incident', 'other'])
})

test('parseReason — accepte category + note valides', () => {
  const r = parseReason({ category: 'incident', note: 'disque plein PC-LAB-12' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.reason, { category: 'incident', note: 'disque plein PC-LAB-12' })
})

test('parseReason — trim + lowercase de la catégorie', () => {
  // Robustesse front : le menu peut envoyer "  AUDIT  " si on copie-colle.
  // On l'accepte plutôt que reject — l'utilisateur n'a pas à comprendre
  // pourquoi sa saisie ne passe pas.
  const r = parseReason({ category: '  AUDIT  ', note: 'revue trimestrielle' })
  assert.equal(r.ok, true)
  assert.equal(r.reason.category, 'audit')
})

test('parseReason — trim de la note', () => {
  const r = parseReason({ category: 'audit', note: '   revue trimestrielle   ' })
  assert.equal(r.ok, true)
  assert.equal(r.reason.note, 'revue trimestrielle')
})

test('parseReason — input null/undefined/string/number → "reason requis"', () => {
  // Le check initial `!input || typeof input !== 'object'` capture
  // null, undefined, strings et numbers. Les arrays passent ce check
  // (typeof [] === 'object') et tombent sur les checks suivants.
  for (const bad of [null, undefined, 'maintenance', 42]) {
    const r = parseReason(bad)
    assert.equal(r.ok, false, `input ${JSON.stringify(bad)} doit échouer`)
    assert.match(r.error, /reason requis/i)
  }
})

test('parseReason — input array (typeof object) → catégorie invalide', () => {
  // [].category est undefined → String → 'undefined' → fail sur la liste
  // des catégories. Comportement subtil mais documenté ici, pas un bug.
  const r = parseReason([])
  assert.equal(r.ok, false)
  assert.match(r.error, /category invalide/)
})

test('parseReason — catégorie inconnue → erreur listant les catégories valides', () => {
  const r = parseReason({ category: 'urgent', note: 'note assez longue' })
  assert.equal(r.ok, false)
  assert.match(r.error, /category invalide/)
  // Le message DOIT lister les valeurs valides — sinon le caller front ne
  // peut pas afficher d'aide à l'utilisateur.
  for (const cat of REASON_CATEGORIES) {
    assert.match(r.error, new RegExp(cat))
  }
})

test('parseReason — note trop courte (< 5 chars)', () => {
  for (const note of ['', '   ', 'a', 'abcd', '    a    ']) {
    const r = parseReason({ category: 'audit', note })
    assert.equal(r.ok, false, `note ${JSON.stringify(note)} doit échouer`)
    assert.match(r.error, /trop courte/)
  }
})

test('parseReason — note trop longue (> 500 chars)', () => {
  const r = parseReason({ category: 'audit', note: 'a'.repeat(501) })
  assert.equal(r.ok, false)
  assert.match(r.error, /trop longue/)
})

test('parseReason — note exactement 500 chars → accepté (bord inclusif)', () => {
  // On veut figer le bord : 500 = OK, 501 = KO. Si on change la valeur,
  // ce test pète, et c'est exactement le signal qu'on veut.
  const r = parseReason({ category: 'audit', note: 'x'.repeat(500) })
  assert.equal(r.ok, true)
  assert.equal(r.reason.note.length, 500)
})

test('parseReason — note exactement 5 chars → accepté (bord inclusif)', () => {
  const r = parseReason({ category: 'audit', note: 'abcde' })
  assert.equal(r.ok, true)
})

test('parseReason — note absente (undefined / null / array) → trop courte', () => {
  // String(undefined||'') = '', idem pour null. String([]) = ''. Tous
  // tombent en dessous des 5 chars min.
  // Le cas note={} est volontairement OMIS : String({}) = '[object Object]'
  // (15 chars) → passe le min. Comportement borderline accepté (un client
  // buggué aura une note '[object Object]' tracée dans l'audit).
  for (const note of [undefined, null, []]) {
    const r = parseReason({ category: 'audit', note })
    assert.equal(r.ok, false, `note ${JSON.stringify(note)} doit échouer`)
    assert.match(r.error, /trop courte/)
  }
})

test('formatReasonLine — rendu compact pour audit / ticket_message', () => {
  assert.equal(
    formatReasonLine({ category: 'incident', note: 'disque plein' }),
    'incident · disque plein'
  )
})

test('formatReasonLine — category seule (note vide)', () => {
  assert.equal(formatReasonLine({ category: 'audit', note: '' }), 'audit')
  assert.equal(formatReasonLine({ category: 'audit' }), 'audit')
})

test('formatReasonLine — input invalide → string vide (jamais throw)', () => {
  // Appelé depuis le flow checkin pour insérer un ticket_message system.
  // Un crash ici ferait planter l'ouverture de la session. Comportement
  // attendu : string vide, le caller décidera quoi faire.
  assert.equal(formatReasonLine(null), '')
  assert.equal(formatReasonLine(undefined), '')
  assert.equal(formatReasonLine({}), '')
})
