// Ask Opale — résolution fuzzy des valeurs (db injectable mock).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveSpec } from '../../modules/ask/lib/resolve.js'

// Fabrique un db mock : map SQL→rows selon le contenu de la requête.
function fakeDb(handler) {
  return { query: async (sql, params) => ({ rows: handler(sql, params) }) }
}

test('group : match exact insensible à la casse → id canonique', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM groups')) return [
      { value: 'g-compta', label: 'Compta' },
      { value: 'g-comptoir', label: 'Comptoir' },
    ]
    return []
  })
  const r = await resolveSpec(db, {
    resource: 'devices', filters: {}, cross: { in_group: 'compta' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.spec.cross.in_group, 'g-compta')
})

test('group : candidat unique → tranche même sans exact', async () => {
  const db = fakeDb((sql) => sql.includes('FROM groups') ? [{ value: 'g-1', label: 'Direction Générale' }] : [])
  const r = await resolveSpec(db, { resource: 'devices', filters: {}, cross: { in_group: 'direction' } })
  assert.equal(r.ok, true)
  assert.equal(r.spec.cross.in_group, 'g-1')
})

test('group : introuvable → erreur explicite', async () => {
  const db = fakeDb(() => [])
  const r = await resolveSpec(db, { resource: 'devices', filters: {}, cross: { in_group: 'inexistant' } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /groupe introuvable/)
})

test('group : ambigu → erreur listant les candidats', async () => {
  const db = fakeDb((sql) => sql.includes('FROM groups') ? [
    { value: 'g-1', label: 'Réseau Paris' },
    { value: 'g-2', label: 'Réseau Lyon' },
  ] : [])
  const r = await resolveSpec(db, { resource: 'devices', filters: {}, cross: { in_group: 'réseau' } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /ambigu/)
  assert.match(r.errors[0], /Réseau Paris, Réseau Lyon/)
})

test('user : match exact sur email → entra_id', async () => {
  const db = fakeDb((sql) => sql.includes('FROM users_cache') ? [
    { value: 'entra-marie', label: 'Marie Durand', email: 'marie@tdv.org' },
    { value: 'entra-marc',  label: 'Marc Petit',   email: 'marc@tdv.org' },
  ] : [])
  const r = await resolveSpec(db, {
    resource: 'tickets', filters: { requester: 'marie@tdv.org' }, cross: {},
  })
  assert.equal(r.ok, true)
  assert.equal(r.spec.filters.requester, 'entra-marie')
})

test('department : valeur canonique stockée renvoyée', async () => {
  const db = fakeDb((sql) => sql.includes('FROM users_cache') ? [{ value: 'Pôle lagunes', label: 'Pôle lagunes' }] : [])
  const r = await resolveSpec(db, { resource: 'devices', filters: { department: 'lagunes' }, cross: {} })
  assert.equal(r.ok, true)
  assert.equal(r.spec.filters.department, 'Pôle lagunes')
})

test('filtres non-resolve laissés intacts', async () => {
  const db = fakeDb(() => { throw new Error('ne devrait pas être appelé') })
  const r = await resolveSpec(db, { resource: 'devices', filters: { status: 'offline' }, cross: {} })
  assert.equal(r.ok, true)
  assert.equal(r.spec.filters.status, 'offline')
})
