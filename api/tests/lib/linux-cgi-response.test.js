import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { parseCgiResponse } from '../../modules/linux/lib/cgi-response.js'

const chunks = (...parts) => Readable.from(parts.map(part => Buffer.from(part)))
const text = async stream => Buffer.concat(await stream.toArray()).toString()

test('réponse CGI : en-têtes puis corps, statut 200 par défaut', async () => {
  const { status, headers, body } = await parseCgiResponse(chunks('Content-Type: application/x-git-upload-pack-advertisement\r\nCache-Control: no-cache\r\n\r\n001e# service=git-upload-pack\n'))
  assert.equal(status, 200)
  assert.deepEqual(headers, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' })
  assert.equal(await text(body), '001e# service=git-upload-pack\n')
})

test('réponse CGI : la ligne Status peut suivre d’autres en-têtes et n’est pas relayée', async () => {
  const { status, headers, body } = await parseCgiResponse(chunks('Content-Type: text/plain\r\nStatus: 403 Forbidden\r\n\r\nrefus'))
  assert.equal(status, 403)
  assert.deepEqual(headers, { 'content-type': 'text/plain' })
  assert.equal(await text(body), 'refus')
})

test('réponse CGI : délimiteur coupé entre plusieurs chunks, corps recollé sans perte', async () => {
  const { status, headers, body } = await parseCgiResponse(chunks('Status: 2', '00 OK\r\nX-A: 1\r', '\n\r', '\nabc', 'def'))
  assert.equal(status, 200)
  assert.deepEqual(headers, { 'x-a': '1' })
  assert.equal(await text(body), 'abcdef')
})

test('réponse CGI : fin du flux avant le délimiteur → rejet', async () => {
  await assert.rejects(parseCgiResponse(chunks('Content-Type: text/plain\r\n')), /en-têtes/)
  await assert.rejects(parseCgiResponse(Readable.from([])), /en-têtes/)
})
