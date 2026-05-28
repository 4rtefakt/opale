// Ask Opale — compilation QuerySpec → SQL paramétré (fonction pure).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compile } from '../../modules/ask/lib/compile.js'

// Helper : spec déjà validé/résolu (forme normalisée).
const spec = (o) => ({ filters: {}, cross: {}, sort: null, limit: undefined, ...o })

test('devices status:offline → fragment + LIMIT paramétrés', () => {
  const { text, params } = compile(spec({
    resource: 'devices', filters: { status: 'offline' },
    sort: { field: 'hostname', dir: 'asc' }, limit: 50,
  }))
  assert.match(text, /FROM devices d/)
  assert.match(text, /d\.last_seen IS NULL OR d\.last_seen < now\(\)/)
  assert.match(text, /ORDER BY d\.hostname ASC/)
  assert.match(text, /LIMIT \$1/)
  assert.deepEqual(params, [50])
})

test('valeurs passent en paramètres, jamais en littéral', () => {
  const { text, params } = compile(spec({
    resource: 'devices', filters: { hostname_contains: "x'; DROP TABLE devices;--" }, limit: 10,
  }))
  // La valeur dangereuse n'apparaît PAS dans le SQL : elle est en params.
  assert.doesNotMatch(text, /DROP TABLE/)
  assert.match(text, /d\.hostname ILIKE \$1/)
  assert.equal(params[0], "%x'; DROP TABLE devices;--%")
})

test('plusieurs filtres → AND, placeholders incrémentés', () => {
  const { text, params } = compile(spec({
    resource: 'devices',
    filters: { disk_used_pct_gte: 90, os_contains: 'Windows 11' },
    limit: 100,
  }))
  assert.match(text, /\$1[\s\S]*\$2[\s\S]*LIMIT \$3/)
  assert.equal(params.length, 3)
  assert.ok(params.includes(90))
  assert.ok(params.includes('%Windows 11%'))
})

test('cross-filter → clause EXISTS', () => {
  const { text } = compile(spec({
    resource: 'devices', cross: { has_ticket: 'critical' }, limit: 100,
  }))
  assert.match(text, /EXISTS \(SELECT 1 FROM ticket_devices td/)
  assert.match(text, /t\.priority = 'critical'/)
})

test('cross failing_rule param + EXISTS compliance', () => {
  const { text, params } = compile(spec({
    resource: 'devices', cross: { failing_rule: 'defender_av_active' }, limit: 100,
  }))
  assert.match(text, /EXISTS \(SELECT 1 FROM compliance_results cr/)
  assert.match(text, /cr\.rule_id = \$1/)
  assert.equal(params[0], 'defender_av_active')
})

test('seuils disque surchargeables via opts (status:critical)', () => {
  const { text } = compile(
    spec({ resource: 'devices', filters: { status: 'critical' }, limit: 10 }),
    { thresholds: { warn: 70, critical: 85 } },
  )
  assert.match(text, /d\.disk_used_pct >= 85/)
})

test('tickets : tri priorité custom + dir desc', () => {
  const { text } = compile(spec({
    resource: 'tickets', filters: { is_open: true },
    sort: { field: 'priority', dir: 'asc' }, limit: 100,
  }))
  assert.match(text, /CASE t\.priority WHEN 'critical' THEN 0/)
  assert.match(text, /t\.status NOT IN \('resolved','closed','merged'\)/)
})

test('compliance : rule + status, total fenêtré présent', () => {
  const { text, params } = compile(spec({
    resource: 'compliance', filters: { rule: 'bitlocker_c_active', status: 'fail' }, limit: 200,
  }))
  assert.match(text, /FROM compliance_results cr/)
  assert.match(text, /COUNT\(\*\) OVER\(\) AS _total/)
  assert.ok(params.includes('bitlocker_c_active'))
  assert.ok(params.includes('fail'))
})
