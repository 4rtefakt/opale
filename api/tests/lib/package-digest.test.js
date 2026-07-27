import { test } from 'node:test'
import assert from 'node:assert/strict'

import { packageDigest, DIGESTED_FIELDS } from '../../modules/inventory/lib/package-digest.js'

const BASE = {
  id: 'ignored', name: 'Mon App', description: 'desc',
  type: 'script', winget_id: null,
  install_script: 'Install-Thing',
  post_install_script: null,
  detection_script: 'Test-Path C:\\x',
  version: '1.0',
}

test('stable pour un contenu identique', () => {
  assert.equal(packageDigest(BASE), packageDigest({ ...BASE }))
})

test('change dès que le script d\'installation change', () => {
  const evil = { ...BASE, install_script: 'Install-Thing; Invoke-Expression $payload' }
  assert.notEqual(packageDigest(BASE), packageDigest(evil))
})

test('change pour chacun des champs exécutables', () => {
  for (const field of DIGESTED_FIELDS) {
    const mutated = { ...BASE, [field]: 'valeur-differente' }
    assert.notEqual(
      packageDigest(BASE), packageDigest(mutated),
      `le digest doit dépendre de « ${field} »`
    )
  }
})

test('ne change PAS pour les champs non exécutables', () => {
  // Renommer un package ou corriger sa description ne doit pas invalider une
  // approbation : sinon les admins réapprouvent en boucle et le contrôle perd
  // son sens.
  for (const field of ['name', 'description', 'id', 'created_by', 'status']) {
    assert.equal(
      packageDigest(BASE), packageDigest({ ...BASE, [field]: 'autre chose' }),
      `le digest ne doit pas dépendre de « ${field} »`
    )
  }
})

test('null et undefined et chaîne vide sont équivalents', () => {
  const a = { ...BASE, post_install_script: null }
  const b = { ...BASE, post_install_script: undefined }
  const c = { ...BASE, post_install_script: '' }
  assert.equal(packageDigest(a), packageDigest(b))
  assert.equal(packageDigest(a), packageDigest(c))
})

test('les champs ne peuvent pas être confondus par concaténation', () => {
  // Sans préfixe de longueur, ('ab', '') et ('a', 'b') hasheraient pareil.
  const x = { ...BASE, winget_id: 'ab', version: '' }
  const y = { ...BASE, winget_id: 'a',  version: 'b' }
  assert.notEqual(packageDigest(x), packageDigest(y))
})

test('digest hexadécimal SHA-256', () => {
  assert.match(packageDigest(BASE), /^[0-9a-f]{64}$/)
})
