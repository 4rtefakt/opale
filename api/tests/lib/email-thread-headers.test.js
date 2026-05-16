// Tests de la construction des headers de threading sortants (Phase 4).
//
// Sans ces tests, un bug silencieux dans buildSubject / buildThreadHeaders
// = thread cassé côté Outlook destinataire (chaque message apparaît en
// conversation séparée). C'est la fonctionnalité-clé du pont sortant —
// faciles à régresser, donc tests indispensables.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ticketTagFromUuid,
  buildSubject,
  buildThreadHeaders,
} from '../../modules/email-bridge/lib/thread-headers.js'

// ── ticketTagFromUuid ─────────────────────────────────────────────────────────

test('ticketTagFromUuid : extrait 8 hex chars en majuscules', () => {
  assert.equal(ticketTagFromUuid('a1b2c3d4-e5f6-7890-abcd-ef0123456789'), 'A1B2C3D4')
})

test('ticketTagFromUuid : null/undefined/vide → null', () => {
  assert.equal(ticketTagFromUuid(null), null)
  assert.equal(ticketTagFromUuid(undefined), null)
  assert.equal(ticketTagFromUuid(''), null)
})

// ── buildSubject ──────────────────────────────────────────────────────────────

test('buildSubject : injection du tag dans un subject simple', () => {
  assert.equal(
    buildSubject('Imprimante bloque', 'a1b2c3d4-x-x'),
    '[Opale #A1B2C3D4] Imprimante bloque'
  )
})

test('buildSubject : préserve Re: en tête, tag après', () => {
  assert.equal(
    buildSubject('Re: Imprimante bloque', 'a1b2c3d4-x-x'),
    'Re: [Opale #A1B2C3D4] Imprimante bloque'
  )
})

test('buildSubject : préserve plusieurs préfixes (TR: Re:)', () => {
  assert.equal(
    buildSubject('TR: Re: Imprimante', 'a1b2c3d4-x-x'),
    'TR: Re: [Opale #A1B2C3D4] Imprimante'
  )
})

test('buildSubject : ne dédouble PAS un tag existant', () => {
  // Cas critique : si le subject contient déjà un tag (réponse), on doit
  // strip l'ancien et ne mettre QUE le nouveau, sinon le sujet enfle à
  // chaque aller-retour.
  assert.equal(
    buildSubject('Re: [Opale #ABC12345] Imprimante', 'a1b2c3d4-x-x'),
    'Re: [Opale #A1B2C3D4] Imprimante'
  )
})

test('buildSubject : subject vide → "(sans sujet)" préfixé', () => {
  assert.equal(
    buildSubject(null, 'a1b2c3d4-x-x'),
    '[Opale #A1B2C3D4] (sans sujet)'
  )
  assert.equal(
    buildSubject('', 'a1b2c3d4-x-x'),
    '[Opale #A1B2C3D4] (sans sujet)'
  )
})

test('buildSubject : sans ticketUuid → subject inchangé', () => {
  assert.equal(buildSubject('Imprimante', null), 'Imprimante')
  assert.equal(buildSubject(null, null), '(sans sujet)')
})

// ── buildThreadHeaders ────────────────────────────────────────────────────────

test('buildThreadHeaders : liste vide → tout null', () => {
  assert.deepEqual(buildThreadHeaders([]),    { inReplyTo: null, references: null })
  assert.deepEqual(buildThreadHeaders(null),  { inReplyTo: null, references: null })
})

test('buildThreadHeaders : un seul inbound', () => {
  const out = buildThreadHeaders([
    { internet_message_id: '<m1@x>', direction: 'inbound' },
  ])
  assert.equal(out.inReplyTo, '<m1@x>')
  assert.equal(out.references, '<m1@x>')
})

test('buildThreadHeaders : In-Reply-To = DERNIER inbound, References = chaîne complète', () => {
  const out = buildThreadHeaders([
    { internet_message_id: '<m1@x>', direction: 'inbound' },
    { internet_message_id: '<m2@x>', direction: 'inbound' },
    { internet_message_id: '<m3@x>', direction: 'inbound' },
  ])
  assert.equal(out.inReplyTo, '<m3@x>')
  assert.equal(out.references, '<m1@x> <m2@x> <m3@x>')
})

test('buildThreadHeaders : normalise les Message-IDs sans chevrons', () => {
  const out = buildThreadHeaders([
    { internet_message_id: 'sans-chevrons@x', direction: 'inbound' },
  ])
  assert.equal(out.inReplyTo, '<sans-chevrons@x>')
  assert.equal(out.references, '<sans-chevrons@x>')
})

test('buildThreadHeaders : dédup IDs dupliqués dans References', () => {
  const out = buildThreadHeaders([
    { internet_message_id: '<m1@x>', direction: 'inbound' },
    { internet_message_id: '<m1@x>', direction: 'inbound' },  // doublon
    { internet_message_id: '<m2@x>', direction: 'inbound' },
  ])
  assert.equal(out.references, '<m1@x> <m2@x>')
})

test('buildThreadHeaders : pas d\'inbound (cas pathologique) → utilise le dernier mapping tout court', () => {
  // Si la séquence n'a que des outbound (jamais arrivé en pratique mais
  // garde-fou), on prend le dernier sans crash.
  const out = buildThreadHeaders([
    { internet_message_id: '<o1@x>', direction: 'outbound' },
  ])
  assert.equal(out.inReplyTo, '<o1@x>')
})
