#!/usr/bin/env node
// Checks that front/locales/fr.js and front/locales/en.js expose the exact
// same set of keys. Exits 1 and prints the diff if they diverge.
// Usage: node scripts/check-locales-parity.mjs

import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

// Dynamic import requires a file URL on all platforms.
const toFileUrl = p => new URL('file://' + p).href

const fr = await import(toFileUrl(resolve(root, 'front/locales/fr.js')))
const en = await import(toFileUrl(resolve(root, 'front/locales/en.js')))

const frKeys = Object.keys(fr.default).sort()
const enKeys = Object.keys(en.default).sort()

const missingInEn = frKeys.filter(k => !(k in en.default))
const missingInFr = enKeys.filter(k => !(k in fr.default))

if (missingInEn.length || missingInFr.length) {
  console.error('Locale parity check FAILED:')
  if (missingInEn.length) {
    console.error(`  Missing in en.js (${missingInEn.length}):`)
    for (const k of missingInEn) console.error(`    - ${k}`)
  }
  if (missingInFr.length) {
    console.error(`  Missing in fr.js (${missingInFr.length}):`)
    for (const k of missingInFr) console.error(`    - ${k}`)
  }
  process.exit(1)
}

console.log(`Locales parity OK (${frKeys.length} keys in fr.js and en.js)`)
