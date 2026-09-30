// L'itérateur garde le backpressure et les octets déjà lus après les en-têtes.
import { Readable } from 'node:stream'

export async function parseCgiResponse(stream) {
  const iterator = stream[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  for (;;) {
    const { value, done } = await iterator.next()
    if (done) throw new Error('Réponse CGI sans en-têtes complets')
    buffer = Buffer.concat([buffer, value])
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) continue
    let status = 200
    const headers = {}
    for (const line of buffer.subarray(0, end).toString().split('\r\n')) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (name === 'status') status = Number.parseInt(value, 10)
      else headers[name] = value
    }
    const body = Readable.from((async function* () {
      try { yield buffer.subarray(end + 4); yield* { [Symbol.asyncIterator]: () => iterator } }
      finally { await iterator.return?.() }
    })())
    return { status, headers, body }
  }
}
