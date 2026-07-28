import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkPushEndpoint } from '../../lib/push-endpoint.js'

test('accepte les endpoints des vrais services de push', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/xyz',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/QWERTY',
  ]) {
    assert.equal(checkPushEndpoint(url).ok, true, `${url} devrait être accepté`)
  }
})

test('refuse http:// — le serveur POSTe vers cette URL', () => {
  const r = checkPushEndpoint('http://fcm.googleapis.com/fcm/send/x')
  assert.equal(r.ok, false)
  assert.match(r.error, /https requis/)
})

test('refuse les hôtes locaux — c\'est le cœur du SSRF', () => {
  for (const url of [
    'https://localhost/x',
    'https://db.local/x',
    'https://api.internal/x',
  ]) {
    const r = checkPushEndpoint(url)
    assert.equal(r.ok, false, `${url} devrait être refusé`)
    assert.match(r.error, /local/)
  }
})

test('refuse les IP littérales', () => {
  for (const url of [
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5:8080/x',
    'https://[::1]/x',
  ]) {
    const r = checkPushEndpoint(url)
    assert.equal(r.ok, false, `${url} devrait être refusé`)
  }
})

test('refuse un nom sans point (service Docker interne)', () => {
  // `ollama`, `db`, `api`… résolvent sur le réseau Docker.
  const r = checkPushEndpoint('https://db/x')
  assert.equal(r.ok, false)
  assert.match(r.error, /non public/)
})

test('refuse les schémas exotiques et les identifiants embarqués', () => {
  assert.equal(checkPushEndpoint('file:///etc/passwd').ok, false)
  assert.equal(checkPushEndpoint('gopher://fcm.googleapis.com/').ok, false)
  assert.equal(checkPushEndpoint('https://user:pass@fcm.googleapis.com/x').ok, false)
})

test('refuse vide, non parsable, ou démesuré', () => {
  assert.equal(checkPushEndpoint('').ok, false)
  assert.equal(checkPushEndpoint(null).ok, false)
  assert.equal(checkPushEndpoint('pas une url').ok, false)
  assert.equal(checkPushEndpoint('https://fcm.googleapis.com/' + 'a'.repeat(3000)).ok, false)
})
