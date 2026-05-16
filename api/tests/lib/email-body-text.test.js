// Tests des helpers de nettoyage de body mail (issue #8, Phase 5b).
//
// Trois fonctions à valider :
//   - htmlToText      : conversion HTML → texte préservant les sauts de ligne
//   - stripSignature  : coupe RFC 3676, footer mobile, bloc cité Outlook
//   - extractMailBodyText : combinateur (preview vs full, troncature)
//
// Tests centrés sur les cas réalistes (mails Outlook, mobile, réponses)
// plutôt que sur du HTML générique. Pas de mock — c'est du pur texte.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  htmlToText,
  stripSignature,
  extractMailBodyText,
} from '../../modules/email-bridge/lib/body-text.js'

// ── htmlToText ────────────────────────────────────────────────────────────────

test('htmlToText : null/vide → string vide', () => {
  assert.equal(htmlToText(null), '')
  assert.equal(htmlToText(''), '')
  assert.equal(htmlToText(undefined), '')
})

test('htmlToText : <br> devient \\n', () => {
  assert.equal(htmlToText('Ligne 1<br>Ligne 2<br/>Ligne 3'), 'Ligne 1\nLigne 2\nLigne 3')
})

test('htmlToText : </p> devient double \\n', () => {
  assert.equal(htmlToText('<p>Para 1</p><p>Para 2</p>'), 'Para 1\n\nPara 2')
})

test('htmlToText : entités décodées', () => {
  assert.equal(htmlToText('&amp; &lt; &gt; &quot; &#39; &nbsp;X'), '& < > " \'  X'.replace(' ', ' '))
})

test('htmlToText : <style> et <script> retirés totalement', () => {
  const html = '<p>Texte</p><style>.x{color:red}</style><script>alert(1)</script><p>Autre</p>'
  const out = htmlToText(html)
  assert.match(out, /^Texte\s*Autre$/m)
  assert.doesNotMatch(out, /color:red|alert/)
})

test('htmlToText : <li> → "- " préfixe', () => {
  assert.match(htmlToText('<ul><li>A</li><li>B</li></ul>'), /- A\n- B/)
})

test('htmlToText : collapse les blancs multiples', () => {
  // 5 \n d'affilée → max 2.
  assert.match(htmlToText('A<br><br><br><br><br>B'), /A\n\nB/)
})

test('htmlToText : trim final', () => {
  assert.equal(htmlToText('<p>Texte</p><br><br>'), 'Texte')
})

// ── stripSignature ────────────────────────────────────────────────────────────

test('stripSignature : coupe au délimiteur RFC `-- `', () => {
  const t = `Message principal.\n\n-- \nClément Boutin\nResponsable Info`
  assert.equal(stripSignature(t), 'Message principal.')
})

test('stripSignature : footer mobile "Envoyé depuis"', () => {
  const t = `Bonjour,\n\nMa question.\n\nMerci\n\nEnvoyé depuis mon iPhone`
  const out = stripSignature(t)
  assert.match(out, /Ma question/)
  assert.doesNotMatch(out, /iPhone/)
})

test('stripSignature : footer "Get Outlook for iOS"', () => {
  const t = `Question.\n\nGet Outlook for iOS<https://aka.ms/o0ukef>`
  const out = stripSignature(t)
  assert.match(out, /^Question\.$/m)
  assert.doesNotMatch(out, /Outlook/i)
})

test('stripSignature : bloc cité "De: ...\\nEnvoyé: ..."', () => {
  const t = `Bonjour,\n\nMa réponse.\n\nDe: Marie <marie@x>\nEnvoyé: jeudi 16 mai 2026 14:00\nÀ: Clément\nObjet: Test`
  const out = stripSignature(t)
  assert.match(out, /Ma réponse/)
  assert.doesNotMatch(out, /Marie/)
})

test('stripSignature : aucun marqueur → texte intact', () => {
  const t = `Juste un message court sans signature ni footer.`
  assert.equal(stripSignature(t), t)
})

test('stripSignature : marqueur en TOUT début → conservé', () => {
  // Si "Envoyé depuis" apparaît au début, c'est pas une signature mais
  // le texte lui-même — on ne coupe pas (heuristique : index > 20).
  const t = `Envoyé depuis chez moi. Ma question est : ça marche ?`
  assert.equal(stripSignature(t), t)
})

test('stripSignature : null/vide → retourné tel quel', () => {
  assert.equal(stripSignature(null), null)
  assert.equal(stripSignature(''), '')
})

// ── extractMailBodyText ───────────────────────────────────────────────────────

test('extractMailBodyText : full HTML body décodé + signature strippée', () => {
  const graph = { bodyPreview: 'short' }
  const full = {
    body: {
      contentType: 'HTML',
      content: '<p>Bonjour Clément,</p><p>Ma question urgente.</p><p>-- <br>Cordialement<br>Marie</p>',
    }
  }
  const out = extractMailBodyText(graph, full)
  assert.match(out, /Bonjour Clément/)
  assert.match(out, /Ma question urgente/)
  // La signature après -- est coupée.
  assert.doesNotMatch(out, /Marie/)
})

test('extractMailBodyText : full body plain text utilisé tel quel', () => {
  const graph = { bodyPreview: 'preview tronqué' }
  const full = { body: { contentType: 'Text', content: 'Message complet en plain text' } }
  const out = extractMailBodyText(graph, full)
  assert.equal(out, 'Message complet en plain text')
})

test('extractMailBodyText : pas de full body → fallback sur bodyPreview', () => {
  const graph = { bodyPreview: 'preview seul' }
  const out = extractMailBodyText(graph, null)
  assert.equal(out, 'preview seul')
})

test('extractMailBodyText : tout vide → string vide', () => {
  const out = extractMailBodyText({}, null)
  assert.equal(out, '')
})

test('extractMailBodyText : maxChars tronque + marqueur', () => {
  const long = 'A'.repeat(10_000)
  const out = extractMailBodyText({}, { body: { contentType: 'Text', content: long } }, { maxChars: 100 })
  assert.equal(out.length, 100 + '\n…(tronqué)'.length)
  assert.match(out, /…\(tronqué\)$/)
})
