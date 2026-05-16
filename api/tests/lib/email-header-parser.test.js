// Tests du parser d'en-têtes mail (issue #8, pont mail ↔ tickets).
//
// Trois primitives à valider, toutes critiques pour le threading :
//   - parseMessageIdList : sans ça, on perd les répliques Outlook → ticket cassé
//   - extractTicketTag   : fallback robuste si le client mail démolit le threading
//   - normalizeMessageId : sans normalisation, lookup DB renvoie false même
//     quand le mail correspond — bug silencieux qui fragmente les threads
//
// On vise les EDGE CASES (vide, malformé, multi-IDs, séparateurs exotiques),
// pas la paraphrase de l'implémentation.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeMessageId,
  parseMessageIdList,
  extractTicketTag,
  extractMatchingHints,
} from '../../modules/email-bridge/lib/header-parser.js'

// ── normalizeMessageId ────────────────────────────────────────────────────────

test('normalizeMessageId : ajoute les chevrons manquants', () => {
  assert.equal(normalizeMessageId('abc@host'), '<abc@host>')
})

test('normalizeMessageId : conserve les chevrons existants', () => {
  assert.equal(normalizeMessageId('<abc@host>'), '<abc@host>')
})

test('normalizeMessageId : trim avant chevrons', () => {
  assert.equal(normalizeMessageId('  abc@host  '), '<abc@host>')
})

test('normalizeMessageId : null/undefined/vide → null', () => {
  assert.equal(normalizeMessageId(null), null)
  assert.equal(normalizeMessageId(undefined), null)
  assert.equal(normalizeMessageId(''), null)
  assert.equal(normalizeMessageId('   '), null)
})

// ── parseMessageIdList ────────────────────────────────────────────────────────

test('parseMessageIdList : header absent → []', () => {
  assert.deepEqual(parseMessageIdList(null), [])
  assert.deepEqual(parseMessageIdList(undefined), [])
  assert.deepEqual(parseMessageIdList(''), [])
  assert.deepEqual(parseMessageIdList('   '), [])
})

test('parseMessageIdList : un seul ID avec chevrons', () => {
  assert.deepEqual(
    parseMessageIdList('<abc@host>'),
    ['<abc@host>']
  )
})

test('parseMessageIdList : plusieurs IDs séparés par espaces (cas References standard)', () => {
  assert.deepEqual(
    parseMessageIdList('<a@x> <b@y> <c@z>'),
    ['<a@x>', '<b@y>', '<c@z>']
  )
})

test('parseMessageIdList : séparateurs CRLF + tab (clients tolérants)', () => {
  assert.deepEqual(
    parseMessageIdList('<a@x>\r\n\t<b@y>\n <c@z>'),
    ['<a@x>', '<b@y>', '<c@z>']
  )
})

test('parseMessageIdList : déduplication first-wins', () => {
  assert.deepEqual(
    parseMessageIdList('<a@x> <b@y> <a@x>'),
    ['<a@x>', '<b@y>']
  )
})

test('parseMessageIdList : tokens parasites hors chevrons ignorés', () => {
  // Certains clients préfixent ou suffixent du texte libre — on doit
  // l'ignorer plutôt que de polluer la liste.
  assert.deepEqual(
    parseMessageIdList('was: <a@x> see also <b@y>'),
    ['<a@x>', '<b@y>']
  )
})

test('parseMessageIdList : ID nu sans chevrons (fallback Exchange)', () => {
  // Cas observé : Exchange parfois retourne juste "abc@host" sans chevrons.
  // On accepte uniquement si aucun chevron n'est présent du tout — sinon
  // on aurait fait du parsing partiel hasardeux.
  assert.deepEqual(
    parseMessageIdList('abc@host'),
    ['<abc@host>']
  )
})

test('parseMessageIdList : chevrons vides ignorés', () => {
  assert.deepEqual(parseMessageIdList('<>'), [])
  assert.deepEqual(parseMessageIdList('<> <a@x>'), ['<a@x>'])
})

test('parseMessageIdList : Message-ID avec caractères atypiques', () => {
  // RFC 5322 autorise +, =, /, etc. dans le local-part. Notre regex doit
  // accepter tout sauf < et >.
  assert.deepEqual(
    parseMessageIdList('<DM5PR12MB1234.namprd12.prod.outlook.com>'),
    ['<DM5PR12MB1234.namprd12.prod.outlook.com>']
  )
  assert.deepEqual(
    parseMessageIdList('<abc+tag/sub=1@host.tld>'),
    ['<abc+tag/sub=1@host.tld>']
  )
})

// ── extractTicketTag ──────────────────────────────────────────────────────────

test('extractTicketTag : tag standard "[Opale #324]"', () => {
  assert.equal(extractTicketTag('[Opale #324] Re: imprimante'), '324')
})

test('extractTicketTag : insensible à la casse', () => {
  assert.equal(extractTicketTag('[opale #abc-123] sujet'), 'abc-123')
  assert.equal(extractTicketTag('[OPALE #42] sujet'),       '42')
})

test('extractTicketTag : tolère espaces autour du #', () => {
  assert.equal(extractTicketTag('[ Opale # 324 ] Re: x'), '324')
})

test('extractTicketTag : tag dans le milieu du subject', () => {
  // Si le client ré-écrit le subject (TR:, Fwd:, etc.) le tag peut bouger.
  assert.equal(extractTicketTag('Fwd: TR: [Opale #99] Re: bug'), '99')
})

test('extractTicketTag : pas de tag → null', () => {
  assert.equal(extractTicketTag('Re: imprimante bloque'), null)
  assert.equal(extractTicketTag(''), null)
  assert.equal(extractTicketTag(null), null)
})

test('extractTicketTag : faux positifs proches', () => {
  // "[Opal #324]" sans 'e' → ignoré. "Opale 324" sans crochets → ignoré.
  assert.equal(extractTicketTag('[Opal #324] x'), null)
  assert.equal(extractTicketTag('Opale 324 x'), null)
  assert.equal(extractTicketTag('[Opale 324] x'), null)  // sans #
})

test('extractTicketTag : caractères invalides dans l\'ID → null', () => {
  // L'ID accepte alphanumérique + tiret seulement. Espace, slash, $, etc. = pas un tag.
  assert.equal(extractTicketTag('[Opale #a b] x'), null)
  assert.equal(extractTicketTag('[Opale #a/b] x'), null)
})

// ── extractMatchingHints (intégration des trois) ─────────────────────────────

test('extractMatchingHints : combine les 3 sources', () => {
  const hints = extractMatchingHints({
    inReplyTo:  '<reply@x>',
    references: '<root@x> <mid@x> <reply@x>',
    subject:    '[Opale #324] Re: imprimante',
  })
  assert.deepEqual(hints.inReplyTo,  ['<reply@x>'])
  assert.deepEqual(hints.references, ['<root@x>', '<mid@x>', '<reply@x>'])
  assert.equal(hints.ticketTag, '324')
})

test('extractMatchingHints : tous les champs absents → structure vide cohérente', () => {
  const hints = extractMatchingHints({})
  assert.deepEqual(hints.inReplyTo,  [])
  assert.deepEqual(hints.references, [])
  assert.equal(hints.ticketTag, null)
})

test('extractMatchingHints : sans arguments du tout', () => {
  const hints = extractMatchingHints()
  assert.deepEqual(hints.inReplyTo,  [])
  assert.deepEqual(hints.references, [])
  assert.equal(hints.ticketTag, null)
})
