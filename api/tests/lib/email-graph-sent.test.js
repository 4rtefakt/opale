// Tests de construction de l'URL Graph pour le dossier "Éléments envoyés"
// (ingestion des réponses Outlook). On teste l'URL produite, pas l'appel HTTP.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildListSentMessagesPath, listSentMessagesSince } from '../../modules/email-bridge/lib/graph-mail.js'

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

test('buildListSentMessagesPath : inclusive → filtre `ge` (curseur du worker)', () => {
  const path = buildListSentMessagesPath('box@example.com', '2026-05-16T10:40:32.000Z', { inclusive: true })
  assert.match(path, /sentDateTime\+ge\+2026-05-16T10%3A40%3A32\.000Z/)
})

test('listSentMessagesSince : nextLink suivi tel quel ; hors Graph v1.0 refusé', async () => {
  const nextLink = 'https://graph.microsoft.com/v1.0/users/box%40example.com/mailFolders/sentitems/messages?%24skip=50'
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const body = /login\.microsoftonline\.com/.test(String(url))
      ? { access_token: 'tok', expires_in: 3600 }
      : { value: [{ id: 's1' }] }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  try {
    const page = await listSentMessagesSince('box@example.com', null, { nextLink })
    assert.deepEqual(page.value.map(m => m.id), ['s1'])
    assert.deepEqual(calls.filter(u => u.includes('/messages')), [nextLink])

    await assert.rejects(
      listSentMessagesSince('box@example.com', null, { nextLink: 'https://evil.example.com/v1.0/x' }),
      /nextLink inattendu/)
    assert.ok(!calls.some(u => u.includes('evil.example.com')), 'jeton jamais envoyé hors Graph')
  } finally {
    globalThis.fetch = original
  }
})
