// Validation des réglages Linux au-delà du schéma : URL https sans identifiants,
// noms de branche git, existence de la branche dans l'upstream du miroir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateLinuxSettings } from '../../modules/linux/lib/settings.js'

const mirror = (serving, upstream = { main: 'a'.repeat(40), 'release/1.0': 'b'.repeat(40) }) =>
  ({ serving: () => serving, heads: () => ({ pilot: null, stable: null, upstream }) })

test('repo_url : https uniquement en v1, sans identifiants', () => {
  for (const repo_url of ['ssh://git@example.com/fleet.git', 'git@example.com:org/fleet.git', 'http://example.com/fleet.git', 'https://user:pw@example.com/fleet.git', 'pas une url']) {
    assert.equal(validateLinuxSettings({ repo_url }, mirror(false)), 'Dépôt : https uniquement en v1, sans identifiants dans l’URL', repo_url)
  }
  assert.equal(validateLinuxSettings({ repo_url: 'https://example.com/org/fleet.git' }, mirror(false)), null)
})

test('branches : grammaire git (check-ref-format) puis existence dans l’upstream quand le miroir sert', () => {
  for (const branch of ['a..b', 'a//b', 'x.lock', '/abs', 'end/', '.hidden', 'a/.b', 'a@{1}', 'fin.']) {
    assert.equal(validateLinuxSettings({ rings: { pilot: { branch } } }, mirror(true)), 'Nom de branche invalide', branch)
  }
  assert.equal(validateLinuxSettings({ rings: { stable: { branch: 'nope' } } }, mirror(true)), 'Branche inconnue : nope')
  assert.equal(validateLinuxSettings({ rings: { stable: { branch: 'nope' } } }, mirror(false)), null, 'miroir sans contenu : pas de vérification d’existence')
  assert.equal(validateLinuxSettings({ rings: { pilot: { branch: 'release/1.0' }, stable: { branch: 'main' } } }, mirror(true)), null)
  assert.equal(validateLinuxSettings({ alerts_enabled: true }, mirror(true)), null)
})
