// front/escape.js — esc() / jsArg() partagés par le desktop et le mobile.
//
// jsArg() sert à passer une valeur non fiable (libellé, hostname, paramètre
// d'URL…) en argument d'un handler inline : onclick="fn(${jsArg(x)})". Le
// navigateur décode les entités de l'attribut PUIS évalue le JS : on rejoue
// ces deux étapes ici (fin d'attribut au premier guillemet brut, décodage des
// entités, évaluation dans un contexte vm) et on exige que fn reçoive
// exactement la valeur d'origine, sans effet de bord.
//
// escape.js est un script sans import/export (chargé en side-effect par
// app.js / mobile-app.js) : on l'évalue dans un contexte vm avec un `window`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../../../front/escape.js', import.meta.url), 'utf8')
const sandbox = { window: {} }
vm.runInNewContext(src, sandbox)
const { esc, jsArg } = sandbox.window

// Sous-ensemble du décodage des références de caractères HTML suffisant pour
// les payloads testés : numériques (&#34; &#x22;) et les entités nommées
// capables de produire des caractères significatifs en JS.
const NAMED = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", bsol: '\\', newline: '\n', lpar: '(', rpar: ')', semi: ';', sol: '/' }
function decodeHtmlAttr(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return String.fromCodePoint(cp)
    }
    const c = NAMED[ref.toLowerCase()]
    return c === undefined ? m : c
  })
}

// Simule `<b onclick=Q fn(ARG) Q>` inséré via innerHTML, clic compris.
function clickHandler(html, quote) {
  const start = html.indexOf(`onclick=${quote}`) + `onclick=${quote}`.length
  const end   = html.indexOf(quote, start)   // le tokenizer HTML ferme l'attribut ici
  const code  = decodeHtmlAttr(html.slice(start, end))
  const calls = []
  const ctx   = vm.createContext({ fn: (...args) => { calls.push(args) }, pwned: false })
  vm.runInContext(code, ctx)
  return { calls, pwned: ctx.pwned, rest: html.slice(end + 1) }
}

const PAYLOADS = [
  'simple',
  "l'apostrophe",
  'guillemet " double',
  "');pwned=true;//",
  '");pwned=true;//',
  '&quot;);pwned=true;//',         // entité écrite en clair : décodée par le navigateur
  '&#34;);pwned=true;//',
  '&#x22;);pwned=true;//',
  '&#39;);pwned=true;//',
  '&bsol;&quot;);pwned=true;//',
  '"><img src=x onerror=pwned=true>',
  "'><img src=x onerror=pwned=true>",
  '</script><script>pwned=true</script>',
  '<!-- -->',
  'anti\\slash \\" \\\\',
  'ligne\nsuivante\r\ttab',
  'sép\u2028ligne\u2029para',
  'nul\u0000char',
  '`${pwned=true}`',
  'émoji 🔐 et 中文',
  'surrogate seul \ud800',
  '&amp;quot;',
  '',
]

test('jsArg — attribut entre guillemets doubles : valeur transmise intacte, aucun effet de bord', () => {
  for (const p of PAYLOADS) {
    const html = `<b onclick="fn(${jsArg(p)})">x</b>`
    const { calls, pwned, rest } = clickHandler(html, '"')
    assert.equal(pwned, false, `effet de bord pour ${JSON.stringify(p)}`)
    assert.deepEqual(calls, [[p]], `argument altéré pour ${JSON.stringify(p)}`)
    assert.equal(rest, '>x</b>', `attribut refermé trop tôt pour ${JSON.stringify(p)}`)
  }
})

test('jsArg — attribut entre apostrophes : valeur transmise intacte, aucun effet de bord', () => {
  for (const p of PAYLOADS) {
    const html = `<b onclick='fn(${jsArg(p)})'>x</b>`
    const { calls, pwned, rest } = clickHandler(html, "'")
    assert.equal(pwned, false, `effet de bord pour ${JSON.stringify(p)}`)
    assert.deepEqual(calls, [[p]], `argument altéré pour ${JSON.stringify(p)}`)
    assert.equal(rest, '>x</b>', `attribut refermé trop tôt pour ${JSON.stringify(p)}`)
  }
})

test('jsArg — plusieurs arguments dans le même handler', () => {
  const a = '&quot;,pwned=true,&quot;'
  const b = "x');pwned=true;('"
  const html = `<b onclick="fn(${jsArg(a)},${jsArg(b)})">x</b>`
  const { calls, pwned } = clickHandler(html, '"')
  assert.equal(pwned, false)
  assert.deepEqual(calls, [[a, b]])
})

test('jsArg — la sortie ne contient aucun caractère actif pour le parseur HTML', () => {
  for (const p of PAYLOADS) {
    const out = jsArg(p)
    assert.doesNotMatch(out, /["'<>\n\r\u2028\u2029]/, `caractère actif dans ${out}`)
    // Le seul & émis est celui de &quot; (délimiteurs et \" internes).
    assert.equal(out.replace(/&quot;/g, '').includes('&'), false, `& brut dans ${out}`)
  }
})

test('jsArg — null/undefined → chaîne vide, nombres → chaîne', () => {
  assert.equal(jsArg(null), '&quot;&quot;')
  assert.equal(jsArg(undefined), '&quot;&quot;')
  assert.equal(jsArg(42), '&quot;42&quot;')
})

test('esc — échappe les 5 caractères HTML (contexte texte / attribut)', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.equal(esc(null), '')
  assert.equal(esc(0), '0')
})
