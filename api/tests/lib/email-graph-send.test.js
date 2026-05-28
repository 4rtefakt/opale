// graph-send.js — sendReply (réponse threadée via createReply).
// Pas de DB : on mocke fetchImpl pour vérifier la séquence Graph.
// getAppToken est appelé en interne ; on shunte via une variable d'env
// reconnue par le module core/graph (sinon il tenterait un vrai token).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sendReply } from '../../modules/email-bridge/lib/graph-send.js'

// Mock fetch : enregistre les appels et renvoie des réponses Graph plausibles.
function mockFetch(calls, { failAt } = {}) {
  return async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body })
    if (failAt && url.includes(failAt)) {
      return { ok: false, status: 400, text: async () => '{"error":"boom"}' }
    }
    if (url.endsWith('/createReply')) {
      // Graph renvoie le brouillon avec la citation du fil pré-remplie.
      return { ok: true, status: 201, json: async () => ({
        id: 'DRAFT-123',
        body: { contentType: 'HTML', content: '<div id="quote">De: Marie<br>&gt; message original</div>' },
      }) }
    }
    return { ok: true, status: 202, json: async () => ({}) }
  }
}

// getAppToken lit la conf Entra ; en test elle n'est pas configurée et
// lèvera. On contourne en stubbant globalThis.fetch n'est pas suffisant —
// donc on teste le chemin où getAppToken réussit en injectant un faux
// token via l'env de test reconnue par core/graph. Si ce n'est pas le cas,
// ces tests sont à exécuter avec les autres (ENTRA_* de test déjà posés).

test('sendReply : séquence createReply → PATCH → send sur la bonne mailbox', async () => {
  const calls = []
  await sendReply({
    mailbox: 'support@tdv.org',
    graphMessageId: 'AAMk-orig',
    bodyText: 'Bonjour, c\'est traité.',
    fetchImpl: mockFetch(calls), getToken: async () => 'fake-token',
  })

  assert.equal(calls.length, 3)
  // 1. createReply sur le message d'origine
  assert.match(calls[0].url, /\/users\/support%40tdv\.org\/messages\/AAMk-orig\/createReply$/)
  assert.equal(calls[0].method, 'POST')
  // 2. PATCH du brouillon créé : notre texte AU-DESSUS de la citation héritée
  assert.match(calls[1].url, /\/messages\/DRAFT-123$/)
  assert.equal(calls[1].method, 'PATCH')
  assert.match(calls[1].body, /Bonjour/)
  assert.match(calls[1].body, /message original/, 'la citation du fil est préservée')
  // ordre : notre réponse avant la citation
  const patched = JSON.parse(calls[1].body).body.content
  assert.ok(patched.indexOf('Bonjour') < patched.indexOf('message original'),
    'notre texte doit précéder la citation')
  // 3. send du brouillon
  assert.match(calls[2].url, /\/messages\/DRAFT-123\/send$/)
  assert.equal(calls[2].method, 'POST')
})

test('sendReply : échec createReply → throw, pas de PATCH/send', async () => {
  const calls = []
  await assert.rejects(
    () => sendReply({
      mailbox: 'support@tdv.org', graphMessageId: 'X', bodyText: 'x',
      fetchImpl: mockFetch(calls, { failAt: 'createReply' }), getToken: async () => 'fake-token',
    }),
    /sendReply\/createReply: 400/
  )
  assert.equal(calls.length, 1, 'on s\'arrête au createReply échoué')
})

test('sendReply : mailbox ou graphMessageId manquant → throw', async () => {
  await assert.rejects(() => sendReply({ graphMessageId: 'X', bodyText: 'x' }), /mailbox manquant/)
  await assert.rejects(() => sendReply({ mailbox: 'a@b', bodyText: 'x' }), /graphMessageId manquant/)
})
