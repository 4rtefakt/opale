// L'API factice de la démo garde la surface de l'API réelle : mêmes chemins,
// mêmes formes de réponse, et les écritures modifient l'état du visiteur.
// Chaque test part d'un état neuf (seed()).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, ME } from '../seed.js'
import { handleApi } from '../api.js'

async function call(state, method, path, body) {
  const url = new URL('https://demo.test/api' + path)
  const init = { method }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' } }
  const res = await handleApi(new Request(url, init), url, state)
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

test('seed : parc, tickets, mails et compteurs cohérents', async () => {
  const s = seed()
  assert.ok(s.devices.length >= 20)
  assert.ok(s.tickets.length >= 15)
  assert.ok(s.tickets.some(t => t.awaiting_reply), 'au moins un ticket attend une réponse')
  assert.ok(s.inbox.every(m => m.action === 'pending_review'))
  const { data: count } = await call(s, 'GET', '/tickets/count')
  assert.equal(count.awaiting_reply, s.tickets.filter(t => t.awaiting_reply).length)
  const { data: inbox } = await call(s, 'GET', '/email/inbox/count')
  assert.equal(inbox.pending, s.inbox.length)
  assert.ok(inbox.threads < inbox.pending, 'les fils regroupent plusieurs mails')
})

test('sync-me renvoie l\'admin fictif ; tableau de bord et alertes ont la forme attendue', async () => {
  const s = seed()
  const me = await call(s, 'POST', '/users/sync-me', {})
  assert.equal(me.status, 200); assert.equal(me.data.isAdmin, true); assert.equal(me.data.entraId, ME.entraId)
  const { data: dash } = await call(s, 'GET', '/dashboard')
  for (const k of ['devices_online', 'devices_total', 'compliance_failing_devs', 'deployments_pending', 'tickets_open']) assert.equal(typeof dash.kpis[k], 'number', k)
  assert.ok(Array.isArray(dash.unhealthy_devices) && Array.isArray(dash.recent_tickets) && Array.isArray(dash.top_failing_rules))
  const { data: al } = await call(s, 'GET', '/alerts')
  assert.ok(al.counts.critical >= 1); assert.ok(al.disk_critical.some(d => d.hostname === 'SRV-FILES'))
  const { data: devs } = await call(s, 'GET', '/devices?status=offline')
  assert.ok(devs.devices.length >= 1 && devs.devices.every(d => d.status === 'offline'))
})

test('tickets : filtres de liste, création, statut, message, awaiting_reply', async () => {
  const s = seed()
  const all = (await call(s, 'GET', '/tickets')).data
  assert.ok(all.every(t => t.status !== 'closed'), 'les archives sont opt-in')
  const closed = (await call(s, 'GET', '/tickets?status=closed')).data
  assert.ok(closed.length >= 1 && closed.every(t => t.status === 'closed'))
  const mine = (await call(s, 'GET', '/tickets?assigned_to=me')).data
  assert.ok(mine.length >= 1 && mine.every(t => t.assigned_to_entra_id === ME.entraId))
  const q = (await call(s, 'GET', '/tickets?q=vpn')).data
  assert.ok(q.some(t => /VPN/.test(t.title)))

  const created = await call(s, 'POST', '/tickets', { title: 'Test démo', priority: 'high', device_id: s.devices[0].id, user_id: s.users[0].entra_id })
  assert.equal(created.status, 201); assert.equal(created.data.hostname, s.devices[0].hostname); assert.equal(created.data.requester_name, s.users[0].display_name)
  const id = created.data.id
  assert.equal((await call(s, 'GET', `/tickets/${id}`)).data.title, 'Test démo')

  const note = await call(s, 'POST', `/tickets/${id}/messages`, { content: 'note', type: 'internal_note' })
  assert.equal(note.data.type, 'internal_note')
  const tk = (await call(s, 'GET', `/tickets/${id}`)).data
  assert.equal(tk.awaiting_reply, false, 'ma note ne met pas le ticket en attente de ma réponse')

  const patched = await call(s, 'PATCH', `/tickets/${id}`, { status: 'resolved' })
  assert.equal(patched.data.status, 'resolved'); assert.ok(patched.data.resolved_at)
  assert.ok(patched.data.messages.some(m => m.type === 'resolution'))
  assert.equal((await call(s, 'PATCH', `/tickets/${id}`, { assigned_to_entra_id: ME.entraId })).data.assigned_to_name, ME.displayName)
  assert.equal((await call(s, 'GET', '/tickets/nope')).status, 404)
  assert.equal((await call(s, 'POST', '/tickets', { title: ' ' })).status, 400)
})

test('mails : un fil entier devient un ticket, rattacher et ignorer', async () => {
  const s = seed()
  const before = (await call(s, 'GET', '/email/inbox/count')).data
  const first = s.inbox.find(m => m.conversation_id === 'conv-budget')
  const thread = (await call(s, 'GET', `/email/inbox/${first.id}/thread`)).data
  assert.equal(thread.length, 2)
  assert.ok((await call(s, 'GET', `/email/inbox/${first.id}/body`)).data.body_text.length > 20)

  const out = await call(s, 'POST', `/email/inbox/${first.id}/to-ticket`)
  assert.equal(out.status, 200); assert.equal(out.data.absorbed, 2)
  const tk = out.data.ticket
  assert.equal(tk.has_inbound_mail, true); assert.equal(tk.inbound_mail_count, 2); assert.equal(tk.requester_name, 'Antoine Rey')
  assert.equal(tk.awaiting_reply, true, 'le demandeur a écrit en dernier')
  assert.ok(!/^RE:/i.test(tk.title))
  const after = (await call(s, 'GET', '/email/inbox/count')).data
  assert.equal(after.pending, before.pending - 2); assert.equal(after.threads, before.threads - 1)

  const other = s.inbox.find(m => m.conversation_id === 'conv-figma')
  const att = await call(s, 'POST', `/email/inbox/${other.id}/attach`, { ticket_id: tk.id })
  assert.equal(att.data.appended, 1)
  assert.equal((await call(s, 'GET', `/tickets/${tk.id}`)).data.inbound_mail_count, 3)

  const promo = s.inbox.find(m => m.conversation_id === 'conv-promo')
  assert.equal((await call(s, 'POST', `/email/inbox/${promo.id}/dismiss`, { whole_thread: true })).status, 200)
  assert.ok(!(await call(s, 'GET', '/email/inbox')).data.some(m => m.id === promo.id))

  const reply = await call(s, 'POST', `/tickets/${tk.id}/messages`, { content: 'Je regarde.' })
  const sent = await call(s, 'POST', `/tickets/${tk.id}/messages/${reply.data.id}/send-by-mail`)
  assert.ok(sent.data.email_sent_at)
  assert.equal((await call(s, 'GET', `/tickets/${tk.id}`)).data.awaiting_reply, false)
})

test('packages : approbation, déploiement avec confirmation, annulation', async () => {
  const s = seed()
  const draft = s.packages.find(p => p.status === 'draft')
  assert.equal((await call(s, 'POST', `/packages/${draft.id}/deploy`, { device_ids: [s.devices[0].id] })).status, 409)
  assert.equal((await call(s, 'POST', `/packages/${draft.id}/approve`, {})).data.status, 'approved')
  const big = await call(s, 'POST', `/packages/${draft.id}/deploy`, { scope: 'all' })
  assert.equal(big.data.requires_confirmation, true); assert.equal(big.data.count, s.devices.length)
  const ok = await call(s, 'POST', `/packages/${draft.id}/deploy`, { scope: 'all', confirmed: true })
  assert.equal(ok.data.queued, s.devices.length)
  const detail = (await call(s, 'GET', `/packages/${draft.id}`)).data
  assert.equal(detail.counts.pending, s.devices.length)
  const dep = detail.deployments[0]
  assert.equal((await call(s, 'PATCH', `/deployments/${dep.id}/cancel`, {})).data.status, 'cancelled')
  assert.equal((await call(s, 'POST', `/deployments/${dep.id}/retry`, {})).data.status, 'pending')
})

test('stock, groupes, onboarding, points, réglages : écritures cohérentes', async () => {
  const s = seed()
  const item = s.stock[0]
  const mv = await call(s, 'POST', `/stock/${item.id}/movements`, { type: 'out', quantity: 2, recipient_name: 'Test' })
  assert.equal(mv.data.item.quantity, 10)
  assert.equal((await call(s, 'POST', `/stock/${item.id}/movements`, { type: 'out', quantity: 999 })).status, 400)

  const g = await call(s, 'POST', '/groups', { name: 'Test', color: 'blue' })
  assert.equal(g.status, 201)
  assert.equal((await call(s, 'POST', '/groups', { name: 'test' })).status, 409)
  await call(s, 'POST', `/groups/${g.data.id}/members`, { device_id: s.devices[0].id })
  assert.equal((await call(s, 'POST', `/groups/${g.data.id}/members`, { device_id: s.devices[0].id })).status, 409)
  assert.equal((await call(s, 'GET', `/groups/${g.data.id}`)).data.devices.length, 1)

  const ob = await call(s, 'POST', '/onboarding', { person_name: 'Test Personne', kind: 'onboard' })
  assert.equal(ob.status, 201); assert.equal(ob.data.total_checks, 8)
  const auto = await call(s, 'POST', `/onboarding/${ob.data.id}/checks/c1/auto`, {})
  assert.ok(auto.data.created?.temporaryPassword)

  const rv = await call(s, 'POST', '/reviews', { title: 'Point test', period_start: '2026-09-14' })
  assert.equal(rv.data.period_start, '2026-09-14')
  assert.equal((await call(s, 'GET', '/reviews')).data[0].section_count, 0)

  const tok = await call(s, 'POST', '/settings/tokens', { label: 'ci' })
  assert.ok(tok.data.token.startsWith('opale_demo_'))
  assert.equal((await call(s, 'PATCH', '/me/prefs', { ui_theme: 'craie' })).data.ui_theme, 'craie')
})

test('ask : interprétation par mots-clés, même forme que l\'API', async () => {
  const s = seed()
  const disk = (await call(s, 'POST', '/ask', { question: 'postes avec le disque presque plein' })).data
  assert.equal(disk.resource, 'devices'); assert.ok(disk.rows.length >= 1 && disk.rows.every(r => r.disk_used_pct >= 80))
  const tk = (await call(s, 'POST', '/ask', { question: 'tickets en attente de réponse' })).data
  assert.equal(tk.resource, 'tickets'); assert.ok(tk.rows.length >= 1)
  const comp = (await call(s, 'POST', '/ask', { question: 'postes sans BitLocker' })).data
  assert.equal(comp.resource, 'compliance'); assert.ok(comp.rows.every(r => r.rule_id === 'bitlocker' && r.status === 'fail'))
  assert.equal((await call(s, 'POST', '/ask', { question: '' })).status, 400)
})

test('ce qui n\'existe pas dans la démo répond 403 avec un message, l\'inconnu 404', async () => {
  const s = seed()
  const ssh = await call(s, 'POST', '/ssh/grant', { deviceId: s.devices[0].id, reason: {} })
  assert.equal(ssh.status, 403); assert.match(ssh.data.error, /démo/)
  assert.equal((await call(s, 'POST', '/groups/import-from-entra', {})).status, 403)
  assert.equal((await call(s, 'GET', '/nope')).status, 404)
})

test('postes : les formes liste et détail conservent la plateforme et l’état désiré', async () => {
  const s = seed()
  const { data: list } = await call(s, 'GET', '/devices')
  const linux = list.devices.filter(d => d.platform === 'linux')
  assert.equal(linux.length, 1)
  const d = linux[0]
  assert.equal(d.managed_by, 'pull')
  assert.equal(d.profile, 'field-researcher')
  assert.equal(d.ring, 'stable')
  assert.equal(d.last_apply_status, 'success')
  assert.ok(Number.isFinite(Date.parse(d.last_apply_at)))
  const { data: detail } = await call(s, 'GET', '/devices/' + d.id)
  for (const key of ['platform', 'managed_by', 'profile', 'ring', 'last_apply_status', 'last_apply_at']) {
    assert.equal(detail[key], d[key], key)
  }
  assert.equal(detail.health_signals, null)
  assert.equal(detail.laps, null)
  assert.equal(detail.disks[0].letter, '/')
  const windows = list.devices.filter(row => row.id !== d.id)
  assert.ok(windows.every(row => row.platform === 'windows' && row.managed_by === null))
  const { data: winDetail } = await call(s, 'GET', '/devices/' + windows[0].id)
  assert.equal(winDetail.platform, 'windows')
  assert.equal(winDetail.managed_by, null)
  assert.ok(winDetail.health_signals.bitlocker)
  assert.equal(winDetail.disks[0].letter, 'C:')
})
