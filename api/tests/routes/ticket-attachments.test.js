// routes/tickets.js — pièces jointes (upload / download / delete).
//
// On teste à travers l'API (multipart construit à la main, pas de dep
// form-data). ATTACHMENTS_DIR pointe vers un tmpdir isolé, nettoyé en fin
// de suite.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'
import { setupTestJwks } from '../helpers/jwt.js'
import { buildApp } from '../helpers/build-app.js'
import { seedAdmin, seedNonAdmin } from '../fixtures/users.js'

import ticketsRoute from '../../modules/tickets/routes/tickets.js'

const SKIP = isDbAvailable() ? false : 'PG_TEST_URL non défini'

let db, release, fastify, jwt, tmpDir, prevEnv

before(async () => {
  if (!isDbAvailable()) return
  prevEnv = { ATTACHMENTS_DIR: process.env.ATTACHMENTS_DIR, ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID, ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID }
  process.env.ENTRA_TENANT_ID = 'test-tenant'
  process.env.ENTRA_CLIENT_ID = 'test-client'
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opale-att-'))
  process.env.ATTACHMENTS_DIR = tmpDir

  const acquired = await acquireSchema()
  db = acquired.db; release = acquired.release
  jwt = await setupTestJwks()
  fastify = await buildApp({
    db, jwks: jwt.jwks,
    routes: async (f) => { await f.register(ticketsRoute, { prefix: '/api/tickets' }) },
  })
})

after(async () => {
  if (fastify) await fastify.close()
  if (release) await release()
  await closeSharedPool()
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(prevEnv || {})) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function adminAuth(entraId = 'oid-att-admin', name = 'Att Admin') {
  const a = await seedAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: a, token: await jwt.sign({ oid: a.entraId, name: a.displayName, preferred_username: a.email }) }
}
async function userAuth(entraId = 'oid-att-user', name = 'Att User') {
  const u = await seedNonAdmin(db, { entraId, displayName: name, email: `${entraId}@x` })
  return { user: u, token: await jwt.sign({ oid: u.entraId, name: u.displayName, preferred_username: u.email }) }
}
async function createTicket(token, body = {}) {
  const res = await fastify.inject({
    method: 'POST', url: '/api/tickets/',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Ticket PJ', ...body },
  })
  return res.json().id
}

// Construit un body multipart/form-data avec un seul champ fichier.
function multipart(filename, content, mime = 'text/plain') {
  const boundary = '----opaleTestBoundary' + Math.random().toString(36).slice(2)
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`
  const payload = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content), Buffer.from(tail, 'utf8')])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function upload(ticketId, token, filename, content, mime) {
  const mp = multipart(filename, content, mime)
  return fastify.inject({
    method: 'POST', url: `/api/tickets/${ticketId}/attachments`,
    headers: { authorization: `Bearer ${token}`, ...mp.headers },
    payload: mp.payload,
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('POST attachments — upload OK + exposé dans GET /:id', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-up')
  const id = await createTicket(token)

  const res = await upload(id, token, 'capture.txt', 'contenu de test', 'text/plain')
  assert.equal(res.statusCode, 201)
  const att = res.json()
  assert.equal(att.filename, 'capture.txt')
  assert.equal(att.mime_type, 'text/plain')
  assert.ok(att.size_bytes > 0)

  const det = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  const list = det.json().attachments
  assert.equal(list.length, 1)
  assert.equal(list[0].filename, 'capture.txt')
})

test('GET download — renvoie le contenu en attachment', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-dl')
  const id = await createTicket(token)
  const up = await upload(id, token, 'doc.txt', 'HELLO-DOWNLOAD', 'text/plain')
  const attId = up.json().id

  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}/attachments/${attId}/download`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-disposition'], /^attachment;/)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.equal(res.body, 'HELLO-DOWNLOAD')
})

test('GET download — filename unicode encodé (RFC 5987)', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-unicode')
  const id = await createTicket(token)
  const up = await upload(id, token, 'rapport été.txt', 'x', 'text/plain')
  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}/attachments/${up.json().id}/download`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.match(res.headers['content-disposition'], /filename\*=UTF-8''/)
})

test('DELETE attachment — retire de la liste', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-del')
  const id = await createTicket(token)
  const up = await upload(id, token, 'todelete.txt', 'bye', 'text/plain')
  const attId = up.json().id

  const del = await fastify.inject({
    method: 'DELETE', url: `/api/tickets/${id}/attachments/${attId}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(del.statusCode, 204)

  const det = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(det.json().attachments.length, 0)
})

test('POST attachments — non-membre → 403', { skip: SKIP }, async () => {
  const owner = await adminAuth('oid-att-acl-owner')
  const other = await userAuth('oid-att-acl-other')
  const id = await createTicket(owner.token, { user_id: owner.user.entraId })
  const res = await upload(id, other.token, 'x.txt', 'nope')
  assert.equal(res.statusCode, 403)
})

test('GET download — pièce jointe inexistante → 404', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-404')
  const id = await createTicket(token)
  const res = await fastify.inject({
    method: 'GET', url: `/api/tickets/${id}/attachments/00000000-0000-0000-0000-000000000000/download`,
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 404)
})

test('POST attachments — sans fichier → 400', { skip: SKIP }, async () => {
  const { token } = await adminAuth('oid-att-nofile')
  const id = await createTicket(token)
  const res = await fastify.inject({
    method: 'POST', url: `/api/tickets/${id}/attachments`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=xyz' },
    payload: '--xyz--\r\n',
  })
  assert.equal(res.statusCode, 400)
})
