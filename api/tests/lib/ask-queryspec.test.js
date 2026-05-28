// Ask Opale — validation du QuerySpec (frontière de sécurité).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateQuerySpec } from '../../modules/ask/lib/queryspec.js'

test('spec valide : devices + filtres enum/number/bool', () => {
  const r = validateQuerySpec({
    resource: 'devices',
    filters: { status: 'offline', offline_since_days: 3, assigned: false },
    sort: { field: 'last_seen', dir: 'desc' },
    limit: 20,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.spec.filters, { status: 'offline', offline_since_days: 3, assigned: false })
  assert.deepEqual(r.spec.sort, { field: 'last_seen', dir: 'desc' })
  assert.equal(r.spec.limit, 20)
})

test('resource inconnue → rejet', () => {
  const r = validateQuerySpec({ resource: 'planets' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /resource inconnue/)
})

test('filtre inconnu → rejet (anti-hallucination de colonne)', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { drop_table: 1 } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /inconnu/)
})

test('valeur enum hors liste → rejet', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { status: 'exploded' } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /hors liste/)
})

test('number : coercition depuis chaîne numérique', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { disk_used_pct_gte: '90' } })
  assert.equal(r.ok, true)
  assert.strictEqual(r.spec.filters.disk_used_pct_gte, 90)
})

test('number : valeur non numérique → rejet', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { disk_used_pct_gte: 'beaucoup' } })
  assert.equal(r.ok, false)
})

test('bool : coercition depuis "true"/"false"', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { has_agent: 'true' } })
  assert.equal(r.ok, true)
  assert.strictEqual(r.spec.filters.has_agent, true)
})

test('text : chaîne vide → rejet', () => {
  const r = validateQuerySpec({ resource: 'devices', filters: { hostname_contains: '   ' } })
  assert.equal(r.ok, false)
})

test('cross-filter validé séparément des filtres directs', () => {
  const r = validateQuerySpec({
    resource: 'devices',
    cross: { has_ticket: 'critical', failing_rule: 'bitlocker_c_active' },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.spec.cross, { has_ticket: 'critical', failing_rule: 'bitlocker_c_active' })
})

test('cross-filter enum invalide → rejet', () => {
  const r = validateQuerySpec({ resource: 'devices', cross: { failing_rule: 'rule_qui_nexiste_pas' } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /cross\.failing_rule/)
})

test('sort field non triable → rejet', () => {
  const r = validateQuerySpec({ resource: 'devices', sort: 'cpu' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /sort\.field inconnu/)
})

test('limit borné à maxLimit', () => {
  const r = validateQuerySpec({ resource: 'devices', limit: 99999 })
  assert.equal(r.ok, true)
  assert.equal(r.spec.limit, 500) // devices.maxLimit
})

test('sort string → asc par défaut', () => {
  const r = validateQuerySpec({ resource: 'tickets', sort: 'created_at' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.spec.sort, { field: 'created_at', dir: 'asc' })
})

test('defaults appliqués quand sort/limit absents', () => {
  const r = validateQuerySpec({ resource: 'tickets', filters: { is_open: true } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.spec.sort, { field: 'created_at', dir: 'desc' })
  assert.equal(r.spec.limit, 100)
})
