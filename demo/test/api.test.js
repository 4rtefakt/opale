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
  assert.equal(linux.length, 2)
  const d = linux.find(x => x.hostname === 'LT-PRET-02')
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
  const windows = list.devices.filter(row => row.platform !== 'linux')
  assert.ok(windows.every(row => row.platform === 'windows' && row.managed_by === null))
  const { data: winDetail } = await call(s, 'GET', '/devices/' + windows[0].id)
  assert.equal(winDetail.platform, 'windows')
  assert.equal(winDetail.managed_by, null)
  assert.ok(winDetail.health_signals.bitlocker)
  assert.equal(winDetail.disks[0].letter, 'C:')
})

test('parc Linux : liste, fiche, rapports, file, pré-inscriptions et réglages ont la forme de la spec', async () => {
  const s = seed()
  const { data: list } = await call(s, 'GET', '/linux/devices')
  assert.equal(list.total, 2); assert.equal(list.rows.length, 2)
  for (const row of list.rows) {
    for (const k of ['id', 'hostname', 'serial', 'platform', 'managed_by', 'profile', 'ring', 'assigned_user', 'os', 'last_seen', 'online', 'disk_used_pct', 'key', 'last_revision_applied', 'last_successful_revision', 'last_apply_status', 'last_apply_at', 'ring_tip', 'lagging', 'needs_escrow']) assert.ok(k in row, k)
    assert.equal(row.platform, 'linux'); assert.equal(row.managed_by, 'pull'); assert.equal(row.key.status, 'approved'); assert.equal('luks_root' in row.key, false)
  }
  const onTip = list.rows.find(r => r.hostname === 'LT-PRET-02'), lagging = list.rows.find(r => r.hostname === 'LT-EMMA')
  assert.equal(onTip.lagging, false); assert.equal(onTip.needs_escrow, false)
  assert.equal(lagging.lagging, true); assert.equal(lagging.needs_escrow, true); assert.equal(lagging.last_apply_status, 'failed')
  assert.equal((await call(s, 'GET', '/linux/devices?apply_status=failed')).data.total, 1)
  assert.equal((await call(s, 'GET', '/linux/devices?escrow=missing')).data.rows[0].hostname, 'LT-EMMA')
  assert.equal((await call(s, 'GET', '/linux/devices?q=pret')).data.total, 1)

  const { data: detail } = await call(s, 'GET', '/linux/devices/' + lagging.id)
  for (const k of ['kernel', 'luks_root', 'last_report', 'laps', 'recovery_keys', 'converted_from_windows']) assert.ok(k in detail, k)
  assert.equal(detail.last_report.status, 'failed'); assert.ok(detail.last_report.log_tail.length > 20)
  const { data: reports } = await call(s, 'GET', `/linux/devices/${lagging.id}/reports?status=success`)
  assert.ok(reports.total >= 1 && reports.rows.every(r => r.status === 'success'))
  assert.equal((await call(s, 'GET', `/linux/devices/${onTip.id}/recovery-keys`)).data.rows[0].current, true)
  assert.equal((await call(s, 'POST', `/linux/devices/${onTip.id}/recovery-keys/rk-1/reveal`, { reason: { category: 'audit', note: 'vérification' } })).status, 403)

  const patched = await call(s, 'PATCH', `/linux/devices/${lagging.id}`, { ring: 'stable', assigned_user_id: s.users[0].entra_id })
  assert.equal(patched.data.ring, 'stable'); assert.equal(patched.data.assigned_user.entra_id, s.users[0].entra_id)
  assert.equal((await call(s, 'POST', `/linux/devices/${lagging.id}/revoke`, { reason: 'trop' })).status, 400)
  const revoked = await call(s, 'POST', `/linux/devices/${lagging.id}/revoke`, { reason: 'Poste perdu, déclaration #42' })
  assert.equal(revoked.data.key.status, 'revoked')
  assert.equal((await call(s, 'POST', `/linux/devices/${lagging.id}/revoke`, { reason: 'Encore une fois' })).status, 409)

  assert.equal((await call(s, 'GET', '/linux/enrollments/count')).data.pending, 1)
  const pending = (await call(s, 'GET', '/linux/enrollments')).data.rows[0]
  const approved = await call(s, 'POST', `/linux/enrollments/${pending.id}/approve`, { profile: 'office', ring: 'pilot', hostname: 'lx-nouveau' })
  assert.equal(approved.status, 200); assert.equal(approved.data.hostname, 'lx-nouveau'); assert.equal(approved.data.profile, 'office')
  assert.equal((await call(s, 'GET', '/linux/enrollments/count')).data.pending, 0)
  assert.equal((await call(s, 'GET', '/linux/devices')).data.total, 3)

  const imported = await call(s, 'POST', '/linux/preregistrations', { rows: [
    { serial: 'NEW00001', profile: 'office', ring: 'stable', email: s.users[1].email },
    { serial: 'PF3ABC12', profile: 'office', ring: 'stable' },
    { serial: 'NEW00002', profile: 'Office!', ring: 'stable' },
    { serial: 'NEW00003', profile: 'office', ring: 'stable', email: 'personne@nulle.part' },
  ] })
  assert.equal(imported.data.ok, 1); assert.equal(imported.data.skipped, 3)
  assert.deepEqual(imported.data.errors.map(e => [e.id, e.code]), [['1', 'DUPLICATE_SERIAL'], ['2', 'INVALID_PROFILE'], ['3', 'UNKNOWN_USER']])
  const prereg = (await call(s, 'GET', '/linux/preregistrations')).data
  assert.equal(prereg.total, 2); assert.ok('matches_device' in prereg.rows[0])
  const fromDevices = await call(s, 'POST', '/linux/preregistrations/from-devices', { device_ids: [s.devices[0].id, onTip.id], profile: 'office', ring: 'pilot' })
  assert.equal(fromDevices.data.ok, 1); assert.deepEqual(fromDevices.data.errors[0].code, 'PULL_MANAGED')
  assert.equal((await call(s, 'GET', '/linux/preregistrations')).data.rows[0].matches_device.hostname, s.devices[0].hostname)
  assert.equal((await call(s, 'DELETE', `/linux/preregistrations/${prereg.rows[0].id}`)).status, 204)

  const rings = (await call(s, 'GET', '/linux/rings')).data
  assert.ok(rings.stable.candidates.length >= 3 && rings.stable.candidates.some(c => c.is_ancestor_of_stable))
  assert.equal(rings.pilot.candidates.length, 0); assert.equal(rings.mirror_state, 'ready')
  assert.equal((await call(s, 'POST', '/linux/rings/stable/promote', { revision: rings.stable.candidates[0].sha })).status, 403)
  const settings = (await call(s, 'GET', '/linux/settings')).data
  for (const k of ['repo_url', 'allowed_signers', 'alerts_enabled', 'rings', 'local_admin_username', 'escrow']) assert.ok(k in settings, k)
  assert.equal((await call(s, 'PATCH', '/linux/settings', { repo_url: 'http://insecure' })).status, 400)
  assert.equal((await call(s, 'PATCH', '/linux/settings', { alerts_enabled: false })).data.alerts_enabled, false)
  const escrow = (await call(s, 'GET', '/linux/escrow/status')).data
  assert.equal(escrow.status, 'ok'); assert.equal(typeof escrow.devices_needing_escrow, 'number')
  assert.equal((await call(s, 'POST', '/linux/escrow/confirm-backup', { key_id: escrow.key_id, confirmed: true })).status, 403)
  const dash = (await call(s, 'GET', '/linux/dashboard')).data
  for (const k of ['devices_total', 'lagging', 'failed_applies', 'pending_approvals', 'not_escrowed']) assert.equal(typeof dash[k], 'number', k)
  assert.equal(dash.pending_approvals, 0); assert.equal(dash.devices_total, 3)
})

test('matériel : liste filtrée, création, changement de statut, relance, note', async () => {
  const s = seed()
  const { data: open } = await call(s, 'GET', '/hardware-requests?state=open')
  assert.ok(open.length >= 5 && open.every(r => !['done', 'cancelled'].includes(r.status)))
  assert.ok(open.every(r => !('events' in r)), 'la liste ne porte pas l\'historique')

  const { status, data: r } = await call(s, 'POST', '/hardware-requests', { title: 'Souris ergonomique', requester_entra_id: 'u-001', status: 'to_order' })
  assert.equal(status, 201)
  assert.equal(r.requester_name, 'Alice Martin')

  const { data: done } = await call(s, 'PATCH', `/hardware-requests/${r.id}`, { status: 'done' })
  assert.ok(done.closed_at)
  const { data: rem } = await call(s, 'POST', `/hardware-requests/${r.id}/reminders`, {})
  assert.equal(rem.reminder_count, 1)
  await call(s, 'POST', `/hardware-requests/${r.id}/notes`, { note: 'Livrée' })
  const { data: detail } = await call(s, 'GET', `/hardware-requests/${r.id}`)
  assert.deepEqual(detail.events.map(e => e.kind), ['note', 'reminder', 'status', 'created'])
})
