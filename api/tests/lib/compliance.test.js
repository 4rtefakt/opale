// Tests "golden" sur RULES[].evaluate — fige le comportement des 12 règles
// de conformité v1. Si on change un seuil ou une logique d'évaluation, un
// test pète et force à le rationaliser (ces verdicts pilotent un dashboard
// qui peut envoyer des push + créer des tickets côté admin, donc un drift
// silencieux est inacceptable).
//
// Volontairement pas de mock de Date.now : les règles temporelles (windows
// update, agent_seen_recent) reçoivent des timestamps en entrée — on les
// calcule relativement à `Date.now()` pour rester déterministes sans
// dépendre d'un timecop.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RULES, RULES_BY_ID, ALERTING_SEVERITIES } from '../../modules/monitoring/lib/compliance.js'

// Toutes les règles RULES doivent être indexées dans RULES_BY_ID — sinon
// les drill-down par rule_id côté routes/compliance.js cassent.
test('RULES — toutes indexées dans RULES_BY_ID, ids uniques', () => {
  assert.equal(RULES.length, 12, 'le set v1 contient exactement 12 règles')
  assert.equal(RULES_BY_ID.size, 12, 'pas de collision sur les ids')
  for (const r of RULES) {
    assert.equal(RULES_BY_ID.get(r.id), r)
    assert.match(r.id, /^[a-z][a-z0-9_]+$/, `id ${r.id} doit être un slug snake_case`)
    assert.ok(['low', 'medium', 'high', 'critical'].includes(r.severity), `severity ${r.severity} de ${r.id} invalide`)
    assert.equal(typeof r.evaluate, 'function')
    assert.equal(typeof r.label, 'string')
  }
})

test('ALERTING_SEVERITIES — uniquement high + critical (PR4 alertes)', () => {
  // Si on étend à medium, le fan-out de push notifs explose au rollout
  // initial. On veut un test qui force à valider le choix explicitement.
  assert.deepEqual([...ALERTING_SEVERITIES].sort(), ['critical', 'high'])
})

// Helper : retourne la règle par id ou throw (les tests qui se trompent
// d'id doivent péter explicitement, pas retourner undefined).
function rule(id) {
  const r = RULES_BY_ID.get(id)
  if (!r) throw new Error(`règle inconnue: ${id}`)
  return r
}

// Helper : assertion compacte (status + presence/absence de value).
function expectStatus(result, status) {
  assert.equal(result.status, status, `status attendu ${status}, got ${result.status} (value=${JSON.stringify(result.value)})`)
}

// ─── bitlocker_c_active ──────────────────────────────────────────────────────

test('bitlocker_c_active — pass / fail / N/A', () => {
  const r = rule('bitlocker_c_active')
  expectStatus(r.evaluate({ health: { bitlocker: { volume: 'C:', protection_status: 'on' } } }), 'pass')
  expectStatus(r.evaluate({ health: { bitlocker: { volume: 'C:', protection_status: 'off', enabled: false } } }), 'fail')
  // Volume autre que C: (cas pathologique) → N/A explicite (ni pass ni fail).
  expectStatus(r.evaluate({ health: { bitlocker: { volume: 'D:', protection_status: 'on' } } }), 'not_applicable')
  // Signal absent → N/A (pas de faux positif sur un poste qui n'a pas
  // encore remonté le bloc bitlocker).
  expectStatus(r.evaluate({}), 'not_applicable')
  expectStatus(r.evaluate({ health: {} }), 'not_applicable')
  expectStatus(r.evaluate({ health: { bitlocker: null } }), 'not_applicable')
})

// ─── defender_av_active + defender_rt_active ─────────────────────────────────

test('defender_av_active — pass si antivirus_enabled === true', () => {
  const r = rule('defender_av_active')
  expectStatus(r.evaluate({ health: { defender: { antivirus_enabled: true } } }), 'pass')
  expectStatus(r.evaluate({ health: { defender: { antivirus_enabled: false } } }), 'fail')
  // Strict === true : "truthy" (1, "yes") ne suffit pas, on veut une
  // remontée explicite de l'agent.
  expectStatus(r.evaluate({ health: { defender: { antivirus_enabled: 1 } } }), 'fail')
  expectStatus(r.evaluate({ health: {} }), 'not_applicable')
})

test('defender_rt_active — pass si realtime_protection === true', () => {
  const r = rule('defender_rt_active')
  expectStatus(r.evaluate({ health: { defender: { realtime_protection: true } } }), 'pass')
  expectStatus(r.evaluate({ health: { defender: { realtime_protection: false } } }), 'fail')
  expectStatus(r.evaluate({ health: { defender: {} } }), 'fail') // realtime_protection absent → fail (le bloc defender existe)
  expectStatus(r.evaluate({ health: {} }), 'not_applicable')
})

// ─── defender_signature_fresh ───────────────────────────────────────────────

test('defender_signature_fresh — seuil 7 jours, bord inclusif', () => {
  const r = rule('defender_signature_fresh')
  expectStatus(r.evaluate({ health: { defender: { signature_age_days: 0 } } }), 'pass')
  expectStatus(r.evaluate({ health: { defender: { signature_age_days: 7 } } }), 'pass') // bord inclusif
  expectStatus(r.evaluate({ health: { defender: { signature_age_days: 8 } } }), 'fail')
  // signature_age_days non-numérique (string, undefined) → N/A.
  expectStatus(r.evaluate({ health: { defender: { signature_age_days: '3' } } }), 'not_applicable')
  expectStatus(r.evaluate({ health: { defender: {} } }), 'not_applicable')
})

// ─── defender_no_recent_threats ─────────────────────────────────────────────

test('defender_no_recent_threats — 0 menaces = pass, ≥1 = fail', () => {
  const r = rule('defender_no_recent_threats')
  expectStatus(r.evaluate({ health: { defender: { threats_last_30d: 0 } } }), 'pass')
  expectStatus(r.evaluate({ health: { defender: { threats_last_30d: 1 } } }), 'fail')
  expectStatus(r.evaluate({ health: { defender: { threats_last_30d: 42, last_threat_at: '2026-05-01' } } }), 'fail')
  expectStatus(r.evaluate({ health: { defender: {} } }), 'not_applicable')
})

// ─── firewall_all_profiles ──────────────────────────────────────────────────

test('firewall_all_profiles — exige les 3 profils ON', () => {
  const r = rule('firewall_all_profiles')
  expectStatus(r.evaluate({ health: { firewall: { domain_enabled: true, private_enabled: true, public_enabled: true } } }), 'pass')
  // Un seul profil OFF → fail.
  expectStatus(r.evaluate({ health: { firewall: { domain_enabled: true, private_enabled: true, public_enabled: false } } }), 'fail')
  expectStatus(r.evaluate({ health: { firewall: { domain_enabled: false, private_enabled: true, public_enabled: true } } }), 'fail')
  // Profil non remonté (undefined) → fail (le bloc firewall existe, donc
  // c'est une donnée incomplète qu'on traite comme défaillance).
  expectStatus(r.evaluate({ health: { firewall: { domain_enabled: true, private_enabled: true } } }), 'fail')
  expectStatus(r.evaluate({}), 'not_applicable')
})

// ─── agent_seen_recent ──────────────────────────────────────────────────────

test('agent_seen_recent — seuil 24h, bord inclusif', () => {
  const r = rule('agent_seen_recent')
  const now = Date.now()
  expectStatus(r.evaluate({ last_seen: new Date(now - 1 * 3600_000).toISOString() }), 'pass') // 1h
  expectStatus(r.evaluate({ last_seen: new Date(now - 23 * 3600_000).toISOString() }), 'pass') // 23h
  expectStatus(r.evaluate({ last_seen: new Date(now - 25 * 3600_000).toISOString() }), 'fail') // 25h
  expectStatus(r.evaluate({ last_seen: new Date(now - 7 * 24 * 3600_000).toISOString() }), 'fail') // 7j
  expectStatus(r.evaluate({}), 'not_applicable')
  expectStatus(r.evaluate({ last_seen: null }), 'not_applicable')
})

// ─── agent_version_current ──────────────────────────────────────────────────

test('agent_version_current — semver stricte (current ≥ latest)', () => {
  const r = rule('agent_version_current')
  expectStatus(r.evaluate({ agent_version: '2.14.0', latest_agent_version: '2.14.0' }), 'pass') // égalité
  expectStatus(r.evaluate({ agent_version: '3.0.0', latest_agent_version: '2.14.0' }), 'pass') // dev/main "999"
  expectStatus(r.evaluate({ agent_version: '2.13.0', latest_agent_version: '2.14.0' }), 'fail')
  expectStatus(r.evaluate({ agent_version: '2.13.99', latest_agent_version: '2.14.0' }), 'fail')
  // Comparaison patch-level (cf. bug historique du downgrade `!==`).
  expectStatus(r.evaluate({ agent_version: '2.14.1', latest_agent_version: '2.14.0' }), 'pass')
  expectStatus(r.evaluate({}), 'not_applicable')
  expectStatus(r.evaluate({ agent_version: '2.14.0' }), 'not_applicable') // latest manquant
})

// ─── disk_c_under_90 ────────────────────────────────────────────────────────

test('disk_c_under_90 — seuil strict 90% (≥90 = fail)', () => {
  const r = rule('disk_c_under_90')
  expectStatus(r.evaluate({ disk_c_used_pct: 0 }), 'pass')
  expectStatus(r.evaluate({ disk_c_used_pct: 89.9 }), 'pass')
  expectStatus(r.evaluate({ disk_c_used_pct: 90 }), 'fail') // strict (< 90)
  expectStatus(r.evaluate({ disk_c_used_pct: 95.5 }), 'fail')
  expectStatus(r.evaluate({}), 'not_applicable')
  expectStatus(r.evaluate({ disk_c_used_pct: null }), 'not_applicable')
})

// ─── windows_update_recent ──────────────────────────────────────────────────

test('windows_update_recent — seuil 30j, format YYYY-MM-DD', () => {
  const r = rule('windows_update_recent')
  const today = new Date()
  const fmt = (d) => d.toISOString().slice(0, 10)
  const minus = (days) => fmt(new Date(today.getTime() - days * 86400_000))

  expectStatus(r.evaluate({ health: { last_windows_update: minus(0) } }), 'pass')
  expectStatus(r.evaluate({ health: { last_windows_update: minus(15) } }), 'pass')
  expectStatus(r.evaluate({ health: { last_windows_update: minus(30) } }), 'pass') // bord inclusif
  expectStatus(r.evaluate({ health: { last_windows_update: minus(31) } }), 'fail')
  // Format invalide → N/A (pas fail — agent qui remonte une string bidon
  // n'est pas un poste "non patché", c'est un bug à investiguer côté agent).
  expectStatus(r.evaluate({ health: { last_windows_update: 'pas une date' } }), 'not_applicable')
  expectStatus(r.evaluate({ health: { last_windows_update: 12345 } }), 'not_applicable')
  expectStatus(r.evaluate({}), 'not_applicable')
})

// ─── no_pending_reboot ──────────────────────────────────────────────────────

test('no_pending_reboot — exige un booléen explicite', () => {
  const r = rule('no_pending_reboot')
  expectStatus(r.evaluate({ health: { pending_reboot: false } }), 'pass')
  expectStatus(r.evaluate({ health: { pending_reboot: true } }), 'fail')
  // Type checking strict : 0/1, "false" → N/A (pas remonté correctement).
  expectStatus(r.evaluate({ health: { pending_reboot: 0 } }), 'not_applicable')
  expectStatus(r.evaluate({ health: { pending_reboot: 'false' } }), 'not_applicable')
  expectStatus(r.evaluate({}), 'not_applicable')
})

// ─── intune_compliant ───────────────────────────────────────────────────────

test('intune_compliant — N/A si compliance_state null (poste hors Intune)', () => {
  const r = rule('intune_compliant')
  expectStatus(r.evaluate({ compliance_state: 'compliant' }), 'pass')
  expectStatus(r.evaluate({ compliance_state: 'noncompliant' }), 'fail')
  expectStatus(r.evaluate({ compliance_state: 'inGracePeriod' }), 'fail')
  // null / undefined = device pas dans Intune → N/A (pas fail, sinon
  // chaque poste hors Intune polluerait le dashboard).
  expectStatus(r.evaluate({ compliance_state: null }), 'not_applicable')
  expectStatus(r.evaluate({}), 'not_applicable')
})

// ─── invariant transverse ───────────────────────────────────────────────────

test('evaluate() reste robuste sur snapshot avec champs partiels', () => {
  // Le wrapper evaluateAndPersist a un try/catch global, mais la convention
  // côté regle.evaluate est de rester défensif (optional chaining, typeof
  // checks). On exerce ici les cas réalistes que le hook checkin peut
  // produire : bloc absent, bloc null, sous-bloc null.
  //
  // Note : `null` / `undefined` en argument direct N'EST PAS testé — les
  // règles font `s.health?.x` (pas `s?.health?.x`), donc s=null throw. En
  // prod le snapshot est toujours un objet (cf. routes/agent.js
  // buildSnapshot). Si on veut durcir la défense en profondeur, c'est un
  // changement explicite côté compliance.js (cf. note d'observation PR1).
  const realistic = [
    {},
    { health: null },
    { health: {} },
    { health: { defender: null, bitlocker: null, firewall: null } },
    { last_seen: 'not-iso' },
    { compliance_state: undefined },
  ]
  for (const r of RULES) {
    for (const snap of realistic) {
      const result = r.evaluate(snap)
      assert.ok(['pass', 'fail', 'not_applicable'].includes(result.status),
        `${r.id} sur ${JSON.stringify(snap)} doit retourner un status valide, got ${result.status}`)
    }
  }
})
