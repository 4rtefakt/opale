// Regression tests pour la construction des URLs Graph (issue #8).
//
// Bug observé en prod 2026-05-16 : `encodeURIComponent(sinceIso)` puis
// `URLSearchParams.set('$filter', ...)` produisait du double-encoding,
// transformant `2026-05-16T10:40:32Z` → `2026-05-16T10%253A40%253A32Z`.
// Graph répondait 400 "Invalid filter clause: Syntax error at position 27".
//
// On teste l'URL produite, pas l'appel HTTP — pas besoin de Postgres ni
// de réseau.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildListMessagesPath, listMessagesSince, _resetSystemFolderCache } from '../../modules/email-bridge/lib/graph-mail.js'

test('buildListMessagesPath : timestamp ISO encodé UNE SEULE FOIS', () => {
  const path = buildListMessagesPath('box@example.com', '2026-05-16T10:40:32.402Z')
  // URLSearchParams encode `:` en `%3A`. Si on voit `%253A`, c'est du
  // double-encoding et Graph rejettera avec 400.
  assert.match(path, /receivedDateTime\+gt\+2026-05-16T10%3A40%3A32\.402Z/)
  assert.doesNotMatch(path, /%253A/, 'double-encoding détecté (regression)')
})

test('buildListMessagesPath : sans sinceIso, pas de $filter', () => {
  const path = buildListMessagesPath('box@example.com', null)
  assert.doesNotMatch(path, /\$filter/)
})

test('buildListMessagesPath : top clampé entre 1 et 100', () => {
  assert.match(buildListMessagesPath('box@example.com', null, { top: 0    }), /%24top=1\b/)
  assert.match(buildListMessagesPath('box@example.com', null, { top: 999  }), /%24top=100\b/)
  assert.match(buildListMessagesPath('box@example.com', null, { top: 50   }), /%24top=50\b/)
})

test('buildListMessagesPath : mailbox URL-encodée', () => {
  const path = buildListMessagesPath('user+alias@example.com', null)
  // Le `+` du local-part doit être encodé pour ne pas être interprété
  // comme un espace par Graph.
  assert.match(path, /\/users\/user%2Balias%40example\.com\//)
})

test('buildListMessagesPath : scanne TOUTE la boîte, pas que /Inbox', () => {
  // Sans ce changement, les mails déplacés par les rules Outlook vers des
  // sous-dossiers étaient invisibles. Régression facile à introduire en
  // tapant `/mailFolders/inbox/messages` par habitude.
  const path = buildListMessagesPath('box@example.com', null)
  assert.match(path, /\/messages\?/, 'doit pointer vers /messages (toute la boîte)')
  assert.doesNotMatch(path, /mailFolders\/inbox/, 'ne doit PAS être limité à /Inbox')
})

test('buildListMessagesPath : champs $select complets (incl. parentFolderId + isDraft)', () => {
  const path = buildListMessagesPath('box@example.com', null)
  // Tous les champs requis pour la classif + le matching + le filtrage
  // des dossiers système côté app.
  for (const field of ['internetMessageId', 'conversationId', 'internetMessageHeaders', 'bodyPreview', 'parentFolderId', 'isDraft']) {
    assert.ok(path.includes(field), `champ ${field} attendu dans $select`)
  }
})

// ── listMessagesSince : filtrage des dossiers système ────────────────────────

// Helper : mock fetch() global avec un router URL → response.
// Plus robuste qu'une stack ordonnée parce que getAppToken peut être
// appelé n fois (cache module-level, races sur Promise.all).
function mockFetchRouter(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const s = String(url)
    calls.push({ url: s, opts })
    for (const [matcher, response] of routes) {
      const match = typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s)
      if (match) {
        return {
          ok: response.ok !== false,
          status: response.status || 200,
          json: async () => response.body,
          text: async () => JSON.stringify(response.body || ''),
        }
      }
    }
    throw new Error(`mockFetchRouter: no route for ${s}`)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('listMessagesSince : exclut Sent/Drafts/Deleted/Junk/Outbox via parentFolderId', async () => {
  _resetSystemFolderCache()
  const mock = mockFetchRouter([
    // OAuth token endpoint (peut être appelé plusieurs fois selon le cache)
    [/login\.microsoftonline\.com.*token/, { body: { access_token: 'tok', expires_in: 3600 } }],
    // Dossiers système — chaque shortcut a son own URL
    ['mailFolders/sentitems',    { body: { id: 'sent-id'    } }],
    ['mailFolders/drafts',       { body: { id: 'drafts-id'  } }],
    ['mailFolders/deleteditems', { body: { id: 'deleted-id' } }],
    ['mailFolders/junkemail',    { body: { id: 'junk-id'    } }],
    ['mailFolders/outbox',       { body: {}, ok: false, status: 404 }],  // outbox absent → toléré
    // La page de messages (filtre côté app après fetch)
    [/\/messages\?/, { body: {
      value: [
        { id: '1', parentFolderId: 'inbox-id',   subject: 'A reçu',                    isDraft: false },
        { id: '2', parentFolderId: 'sent-id',    subject: 'B envoyé',                  isDraft: false },
        { id: '3', parentFolderId: 'drafts-id',  subject: 'C brouillon',               isDraft: true  },
        { id: '4', parentFolderId: 'deleted-id', subject: 'D corbeille',               isDraft: false },
        { id: '5', parentFolderId: 'helpdesk-id',subject: 'E sous-dossier',            isDraft: false },
        { id: '6', parentFolderId: 'junk-id',    subject: 'F spam',                    isDraft: false },
        { id: '7', parentFolderId: 'inbox-id',   subject: 'G brouillon hors drafts',   isDraft: true  },
        { id: '8', parentFolderId: 'archive-id', subject: 'H archivé',                 isDraft: false },
      ]
    }}],
  ])

  try {
    const page = await listMessagesSince('box@example.com', null)
    const subjects = (page?.value || []).map(m => m.subject).sort()
    // Doivent rester : A reçu, E sous-dossier, H archivé. Les 5 autres
    // sont exclus (sent, drafts, deleted, junk, isDraft=true).
    assert.deepEqual(subjects, ['A reçu', 'E sous-dossier', 'H archivé'])
  } finally {
    mock.restore()
    _resetSystemFolderCache()
  }
})
