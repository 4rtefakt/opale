// Ask Opale — scoring d'eval + cohérence du jeu de cas avec le registre.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { scoreCase } from '../../modules/ask/eval/score.js'
import { validateQuerySpec } from '../../modules/ask/lib/queryspec.js'

const norm = (o) => validateQuerySpec(o).spec // helper : forme normalisée

test('exact : ressource + filtre identiques', () => {
  const c = { q: '', resource: 'devices', filters: { status: 'offline' } }
  const r = scoreCase(c, norm({ resource: 'devices', filters: { status: 'offline' } }))
  assert.equal(r.status, 'exact')
})

test('partial : filtre attendu manquant', () => {
  const c = { q: '', resource: 'devices', filters: { status: 'offline', has_agent: true } }
  const r = scoreCase(c, norm({ resource: 'devices', filters: { status: 'offline' } }))
  assert.equal(r.status, 'partial')
  assert.deepEqual(r.missing, ['filters.has_agent'])
})

test('partial : filtre superflu', () => {
  const c = { q: '', resource: 'devices', filters: { status: 'offline' } }
  const r = scoreCase(c, norm({ resource: 'devices', filters: { status: 'offline', has_agent: true } }))
  assert.equal(r.status, 'partial')
  assert.deepEqual(r.extra, ['filters.has_agent'])
})

test('fail : mauvaise ressource', () => {
  const c = { q: '', resource: 'devices', filters: { status: 'offline' } }
  const r = scoreCase(c, norm({ resource: 'tickets', filters: { is_open: true } }))
  assert.equal(r.status, 'fail')
})

test('alt : représentation alternative acceptée comme exact', () => {
  const c = {
    q: '', resource: 'devices', filters: { bitlocker_active: false },
    alt: [{ resource: 'devices', cross: { failing_rule: 'bitlocker_c_active' } }],
  }
  const r = scoreCase(c, norm({ resource: 'devices', cross: { failing_rule: 'bitlocker_c_active' } }))
  assert.equal(r.status, 'exact')
})

test('valeur de filtre comparée insensiblement à la casse', () => {
  const c = { q: '', resource: 'devices', filters: { department: 'Compta' } }
  const r = scoreCase(c, norm({ resource: 'devices', filters: { department: 'compta' } }))
  assert.equal(r.status, 'exact')
})

test('sort vérifié seulement si attendu le précise', () => {
  const c = { q: '', resource: 'devices', sort: { field: 'last_seen', dir: 'desc' }, limit: 10 }
  const ok = scoreCase(c, norm({ resource: 'devices', sort: { field: 'last_seen', dir: 'desc' }, limit: 10 }))
  assert.equal(ok.status, 'exact')
  const bad = scoreCase(c, norm({ resource: 'devices', sort: { field: 'hostname' }, limit: 10 }))
  assert.ok(bad.missing.includes('sort'))
})

// Méta : tout spec attendu (primaire + alternatives) du jeu d'eval doit être
// VALIDE contre le registre — sinon l'eval contient des cibles impossibles
// (typo de nom de filtre, valeur d'enum erronée…). Garde-fou anti-dérive.
test('cohérence : tous les cas d\'eval valident contre le registre', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const cases = JSON.parse(readFileSync(join(here, '../../modules/ask/eval/cases.json'), 'utf8'))
  assert.ok(cases.length >= 30, `attendu ≥30 cas, trouvé ${cases.length}`)

  for (const c of cases) {
    const { q, alt, ...spec } = c
    for (const s of [spec, ...(alt || [])]) {
      const v = validateQuerySpec(s)
      assert.ok(v.ok, `cas invalide « ${q} » → ${(v.errors || []).join(' ; ')}`)
    }
  }
})
