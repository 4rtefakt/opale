// lib/prefs.js : validation des préférences utilisateur. Logique pure, aucun
// accès DB → ces tests tournent toujours (pas de gate PG_TEST_URL). On cible la
// frontière serveur : mobile_nav (cardinalité 1-4, ensemble fermé, doublons) et
// le merge de patch (corps non-objet, clé inconnue).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateMobileNav, validatePrefsPatch, MOBILE_NAV_ROUTES } from '../../modules/core/lib/prefs.js'

test('validateMobileNav — accepte 1 à 4 routes autorisées distinctes', () => {
  for (const v of [['dashboard'], ['dashboard', 'postes', 'alertes', 'tickets']]) {
    const res = validateMobileNav(v)
    assert.equal(res.ok, true)
    assert.deepEqual(res.value, v)
  }
})

test('validateMobileNav — rejette non-tableau', () => {
  for (const v of ['dashboard', { 0: 'dashboard' }, null, 3]) {
    assert.equal(validateMobileNav(v).ok, false)
  }
})

test('validateMobileNav — rejette < 1 ou > 4 entrées', () => {
  assert.equal(validateMobileNav([]).ok, false)
  assert.equal(validateMobileNav(['dashboard', 'postes', 'alertes', 'tickets', 'scripts']).ok, false)
})

test('validateMobileNav — rejette une route hors ensemble autorisé', () => {
  const res = validateMobileNav(['dashboard', 'settings'])
  assert.equal(res.ok, false)
  assert.match(res.error, /settings/)
})

test('validateMobileNav — rejette les doublons', () => {
  const res = validateMobileNav(['dashboard', 'dashboard'])
  assert.equal(res.ok, false)
  assert.match(res.error, /doublon/)
})

test('validateMobileNav — rejette les éléments non-string', () => {
  assert.equal(validateMobileNav(['dashboard', 42]).ok, false)
})

test('MOBILE_NAV_ROUTES — contient les routes attendues', () => {
  for (const r of ['dashboard', 'postes', 'alertes', 'tickets', 'scripts', 'stock',
                   'onboarding', 'rapports', 'audit', 'packages', 'conformite', 'ask']) {
    assert.ok(MOBILE_NAV_ROUTES.has(r), `manque ${r}`)
  }
})

test('validatePrefsPatch — rejette corps non-objet ou vide', () => {
  for (const v of [null, [], 'x', 42, {}]) {
    assert.equal(validatePrefsPatch(v).ok, false)
  }
})

test('validatePrefsPatch — rejette une clé inconnue', () => {
  const res = validatePrefsPatch({ theme: 'dark' })
  assert.equal(res.ok, false)
  assert.match(res.error, /inconnue/)
})

test('validatePrefsPatch — normalise et renvoie le patch validé', () => {
  const res = validatePrefsPatch({ mobile_nav: ['dashboard', 'tickets'] })
  assert.equal(res.ok, true)
  assert.deepEqual(res.patch, { mobile_nav: ['dashboard', 'tickets'] })
})

test('validatePrefsPatch — propage l\'erreur du validateur de clé', () => {
  const res = validatePrefsPatch({ mobile_nav: [] })
  assert.equal(res.ok, false)
})
