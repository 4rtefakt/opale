// Identifiants interpolés dans les paths Graph (core/lib/graph.js).
//
// Toute fonction qui construit un path Graph à partir d'un id (route, body,
// colonne éditable par un admin) doit refuser un id hors format AVANT le
// moindre fetch : sinon `/`, `?`, `#` réécrivent la requête vers un autre
// endpoint Graph accessible au token applicatif.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isGraphUserId, isGraphGuid,
  getUserPhoto, disableEntraUser, revokeUserSessions, addUserToGroup,
  syncIntuneDevice, getGroupDeviceHostnames, getGroupUserIds,
} from '../../modules/core/lib/graph.js'

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const INJECTED = `${GUID}/messages?$select=subject#`

function trapFetch() {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('fetch interdit dans ce test') }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('isGraphUserId : GUID et UPN acceptés, caractères de path/query refusés', () => {
  assert.equal(isGraphUserId(GUID), true)
  assert.equal(isGraphUserId('jean.dupont@contoso.fr'), true)
  for (const bad of [INJECTED, '../users', 'a%2Fb@c.fr', 'x@y.fr?$top=1', 'x@y.fr#', 'a@b', '', null, 42]) {
    assert.equal(isGraphUserId(bad), false, `devrait refuser ${JSON.stringify(bad)}`)
  }
  assert.equal(isGraphGuid(GUID), true)
  assert.equal(isGraphGuid('jean.dupont@contoso.fr'), false)
})

test('fonctions Graph : id injecté → refus sans aucun fetch', async () => {
  const mock = trapFetch()
  try {
    assert.equal(await getUserPhoto(INJECTED), null)
    await assert.rejects(disableEntraUser(INJECTED), /invalide/)
    await assert.rejects(revokeUserSessions(INJECTED), /invalide/)
    await assert.rejects(addUserToGroup(INJECTED, GUID), /invalide/)
    await assert.rejects(addUserToGroup(GUID, INJECTED), /invalide/)
    await assert.rejects(syncIntuneDevice(INJECTED), /invalide/)
    await assert.rejects(getGroupDeviceHostnames(INJECTED), /invalide/)
    await assert.rejects(getGroupUserIds(INJECTED), /invalide/)
    assert.deepEqual(mock.calls, [])
  } finally {
    mock.restore()
  }
})
