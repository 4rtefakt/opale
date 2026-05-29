// Tests de construction de l'URL Graph pour le dossier "Éléments envoyés"
// (ingestion des réponses Outlook). On teste l'URL produite, pas l'appel HTTP.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildListSentMessagesPath } from '../../modules/email-bridge/lib/graph-mail.js'

test('buildListSentMessagesPath : cible le dossier sentitems', () => {
  const path = buildListSentMessagesPath('box@example.com', null)
  assert.match(path, /\/mailFolders\/sentitems\/messages\?/)
})

test('buildListSentMessagesPath : filtre/ordonne sur sentDateTime', () => {
  const path = buildListSentMessagesPath('box@example.com', '2026-05-16T10:40:32.402Z')
  // $filter sur sentDateTime (pas receivedDateTime, souvent absent en sortant).
  assert.match(path, /sentDateTime\+gt\+2026-05-16T10%3A40%3A32\.402Z/)
  // Pas de double-encoding (régression connue côté inbound).
  assert.doesNotMatch(path, /%253A/)
  // orderby ascendant sur sentDateTime pour avancer le curseur progressivement.
  assert.match(path, /%24orderby=sentDateTime\+asc/)
})

test('buildListSentMessagesPath : sans sinceIso, pas de $filter', () => {
  const path = buildListSentMessagesPath('box@example.com', null)
  assert.doesNotMatch(path, /\$filter|%24filter/)
})

test('buildListSentMessagesPath : sentDateTime dans $select (curseur)', () => {
  const path = buildListSentMessagesPath('box@example.com', null)
  for (const field of ['internetMessageId', 'conversationId', 'internetMessageHeaders', 'sentDateTime']) {
    assert.ok(path.includes(field), `champ ${field} attendu dans $select`)
  }
})

test('buildListSentMessagesPath : top clampé entre 1 et 100', () => {
  assert.match(buildListSentMessagesPath('b@x', null, { top: 0   }), /%24top=1\b/)
  assert.match(buildListSentMessagesPath('b@x', null, { top: 999 }), /%24top=100\b/)
})

test('buildListSentMessagesPath : mailbox URL-encodée', () => {
  const path = buildListSentMessagesPath('user+alias@example.com', null)
  assert.match(path, /\/users\/user%2Balias%40example\.com\//)
})
