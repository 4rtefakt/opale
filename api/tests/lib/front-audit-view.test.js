// front/views/audit.js — rendu du journal d'audit (vue desktop).
//
// Couvre l'entrée `mail_ingest_abandoned` (mail entrant abandonné par le
// worker de polling, cf. api/modules/email-bridge/lib/poll-cursor.js) :
// libellé, badge, catégorie de filtre, et résumé (date du mail,
// internet_message_id, erreur) ÉCHAPPÉ — ces champs viennent d'un mail
// externe et d'un message d'erreur DB.
//
// audit.js est un module navigateur sans import (globals t, esc,
// formatRelative, document, window.api…) : on l'évalue dans un contexte vm
// avec des stubs, comme front-escape.test.js (pas d'import ESM d'un
// fichier du front, compatible Node 20 en CI).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const escSrc   = readFileSync(new URL('../../../front/escape.js', import.meta.url), 'utf8')
const auditSrc = readFileSync(new URL('../../../front/views/audit.js', import.meta.url), 'utf8')

function loadAuditView({ rows, category = 'default' }) {
  const elements = new Map()
  const getElementById = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', style: {},
        value: id === 'audit-filter-category' ? category : '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        insertAdjacentHTML(_pos, html) { this.innerHTML += html },
      })
    }
    return elements.get(id)
  }
  const auditCalls = []
  const ctx = vm.createContext({
    window: { api: { getAudit: async params => { auditCalls.push(params); return { rows, total: rows.length } } } },
    document: { getElementById },
    localStorage: { getItem: () => category, setItem() {} },
    t: key => key,
    formatRelative: () => 'il y a 1 min',
    setInterval, clearInterval,
  })
  vm.runInContext(escSrc, ctx)
  ctx.esc = ctx.window.esc
  vm.runInContext(auditSrc.replace(/^export /m, ''), ctx)
  return { ctx, getElementById, auditCalls }
}

const ABANDONED = {
  action: 'mail_ingest_abandoned',
  by_user: 'system',
  target: 'helpdesk@example.com',
  created_at: '2026-05-10T10:31:00Z',
  details: {
    level: 'error',
    worker: 'email-bridge',
    internet_message_id: '<a&b@mail.example.com>',
    graph_message_id: 'AAMkAD…',
    date: '2026-05-10T09:00:01Z',
    attempts: 7,
    error: 'échec simulé <img src=x onerror=alert(1)>',
  },
}

test('audit : mail_ingest_abandoned → libellé, badge et résumé (date, internet_message_id, erreur) échappés', async () => {
  const { ctx, getElementById } = loadAuditView({ rows: [ABANDONED] })
  await ctx.renderAudit({ innerHTML: '' })
  const html = getElementById('audit-body').innerHTML

  assert.match(html, /mail abandonné \(ingestion\)/, 'libellé lisible, pas le code brut')
  assert.doesNotMatch(html, /ti-dots/, 'badge dédié (pas le badge par défaut)')
  assert.match(html, /2026-05-10 09:00:01 UTC/, 'date du mail')
  assert.match(html, /&lt;a&amp;b@mail\.example\.com&gt;/, 'internet_message_id échappé')
  assert.match(html, /échec simulé &lt;img src=x onerror=alert\(1\)&gt;/, 'erreur échappée')
  assert.doesNotMatch(html, /<img/, 'aucune balise injectée')
  assert.match(html, /ERROR/, 'niveau error affiché')
})

const BLOCKED = {
  action: 'mail_ingest_blocked',
  by_user: 'system',
  target: 'helpdesk@example.com',
  created_at: '2026-05-10T10:31:00Z',
  details: {
    level: 'error',
    internet_message_id: '<c"d@mail.example.com>',
    since: '2026-05-10T10:00:00.000Z',
    attempts: 7,
    error: 'panne <script>x</script>',
    next_error: 'panne aussi',
    recovery_sql: "UPDATE settings SET value = '2026-05-10T09:00:02.000Z' WHERE key = 'mail.cursor.o''brien@example.com';",
    log: "Ingestion bloquée…\n   UPDATE settings SET value = '2026-05-10T09:00:02.000Z' WHERE key = 'mail.cursor.o''brien@example.com';",
  },
}

test('audit : mail_ingest_blocked → libellé, résumé échappé, reprise SQL dans le panneau dépliable', async () => {
  const { ctx, getElementById } = loadAuditView({ rows: [BLOCKED] })
  await ctx.renderAudit({ innerHTML: '' })
  const html = getElementById('audit-body').innerHTML

  assert.match(html, /boîte mail bloquée/)
  assert.doesNotMatch(html, /ti-dots/, 'badge dédié')
  assert.match(html, /bloquée depuis 2026-05-10 10:00:00 UTC/)
  assert.match(html, /7 tentatives/)
  assert.match(html, /&lt;c&quot;d@mail\.example\.com&gt;/, 'internet_message_id échappé')
  assert.match(html, /panne &lt;script&gt;x&lt;\/script&gt;/, 'erreur échappée')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /<pre>[^<]*UPDATE settings SET value = &#39;2026-05-10T09:00:02\.000Z&#39;/, 'SQL de reprise dans le panneau, échappé')
})

test('audit : mail_ingest_second_skipped → libellé et résumé chiffré', async () => {
  const row = {
    action: 'mail_ingest_second_skipped', by_user: 'system', target: 'helpdesk@example.com',
    created_at: '2026-05-10T10:31:00Z',
    details: { level: 'error', cursor: '2026-05-10T09:00:01.200Z', next_cursor: '2026-05-10T09:00:02.000Z',
               already_handled: 2000, not_ingested: 500, not_ingested_exact: false },
  }
  const { ctx, getElementById } = loadAuditView({ rows: [row] })
  await ctx.renderAudit({ innerHTML: '' })
  const html = getElementById('audit-body').innerHTML

  assert.match(html, /mails sautés \(même seconde\)/)
  assert.doesNotMatch(html, /ti-dots/, 'badge dédié')
  assert.match(html, /≥ 500 mails non ingérés/, 'décompte (minimum si non exact)')
  assert.match(html, /seconde 2026-05-10 09:00:01 UTC/)
})

// front/views/tickets.js — diagnostic du pont mail : une ligne rouge par
// boîte bloquée (champ `blocked` de /api/email/status).
test('tickets : diagnostic mail → ligne rouge pour une boîte bloquée, champs échappés', () => {
  const ticketsSrc = readFileSync(new URL('../../../front/views/tickets.js', import.meta.url), 'utf8')
  const ctx = vm.createContext({
    window: {}, t: (key, vars) => key + (vars ? JSON.stringify(vars) : ''), formatRelative: () => 'il y a 1 min',
  })
  vm.runInContext(escSrc, ctx)
  ctx.esc = ctx.window.esc
  vm.runInContext(ticketsSrc.replace(/^export /gm, ''), ctx)

  const status = { mailboxes: [
    { address: 'a@example.com', cursor: '2026-05-10T09:00:00Z', total_ingested: 3,
      blocked: { since: '2026-05-10T10:00:00.000Z', attempts: 7, error: 'panne <b>x</b>', internet_message_id: '<id@x>' } },
    { address: 'b@example.com', cursor: '2026-05-10T09:00:00Z', total_ingested: 1, blocked: null },
  ], sent_mailboxes: [
    { address: 'agent@example.com', cursor: '2026-05-10T09:00:00Z',
      blocked: { since: '2026-05-10T10:00:00.000Z', attempts: 9, error: 'envoyés en panne', internet_message_id: '<s@x>' } },
  ] }
  const html = ctx.renderMailDiagConfig({ config: {} }, status)
  assert.match(html, /agent@example\.com — tickets\.mail_diag\.sent/, 'boîte des Éléments envoyés listée')
  const red = (html.match(/<div style="color:var\(--red\)[^"]*">[^\n]*<\/div>/g) || []).filter(l => !/envoyés en panne/.test(l))
  assert.ok(/envoyés en panne/.test(html), 'blocage des Éléments envoyés affiché')
  assert.equal(red.length, 1, 'une seule boîte de réception bloquée')
  assert.match(red[0], /tickets\.mail_diag\.blocked/)
  assert.match(red[0], /panne &lt;b&gt;x&lt;\/b&gt;/, 'erreur échappée')
  assert.match(red[0], /&lt;id@x&gt;/, 'internet_message_id échappé')
  assert.doesNotMatch(html, /<b>x<\/b>/)
})

test('audit : catégorie « Pont mail » → filtre sur les actions du pont mail', async () => {
  const { ctx, auditCalls } = loadAuditView({ rows: [ABANDONED], category: 'mail' })
  const container = { innerHTML: '' }
  await ctx.renderAudit(container)

  assert.match(container.innerHTML, /<option value="mail" selected>/, 'catégorie proposée dans le filtre')
  assert.equal(auditCalls.length, 1)
  assert.deepEqual(auditCalls[0].actions_in.split(',').sort(),
    ['mail_ingest_abandoned', 'mail_ingest_blocked', 'mail_ingest_second_skipped'])
})
