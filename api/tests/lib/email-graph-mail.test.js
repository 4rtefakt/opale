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

import { buildListMessagesPath } from '../../modules/email-bridge/lib/graph-mail.js'

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

test('buildListMessagesPath : champs $select complets', () => {
  const path = buildListMessagesPath('box@example.com', null)
  // Tous les champs requis pour la classif + le matching.
  for (const field of ['internetMessageId', 'conversationId', 'internetMessageHeaders', 'bodyPreview']) {
    assert.ok(path.includes(field), `champ ${field} attendu dans $select`)
  }
})
