// API factice de la démo : même surface que l'API Opale (chemins, verbes,
// formes de réponse), servie depuis un état en mémoire par visiteur (seed.js).
// Les écritures modifient cet état pour que la démo « réponde » (créer un
// ticket, répondre, trier un mail, déployer un package…) sans rien persister.
//
// Ce qui n'a pas de sens sans infrastructure (SSH, console, Graph, envoi de
// mails) répond 403 avec un message clair plutôt qu'une erreur générique.

import { ME } from './seed.js'

class ApiErr extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra } }
const nope = (what = 'Indisponible dans la démo') => { throw new ApiErr(403, what) }
const notFound = (what = 'Introuvable') => { throw new ApiErr(404, what) }
const now = () => new Date().toISOString()
const H = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
const nextId = (s, p) => `${p}-${++s.nextId}`
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d }
const lc = (v) => String(v || '').toLowerCase()
const byDateDesc = (k) => (a, b) => Date.parse(b[k] || 0) - Date.parse(a[k] || 0)

// ── Vues dérivées ────────────────────────────────────────────────────────────

function thresholds(s) {
  return { warn: num(s.settings.settings.disk_warn_pct, 80), critical: num(s.settings.settings.disk_critical_pct, 90), offline_days: num(s.settings.settings.agent_offline_days, 7) }
}
function deviceStatus(s, d) {
  const t = thresholds(s)
  const ageDays = (Date.now() - Date.parse(d.last_seen)) / 86_400_000
  if (ageDays > t.offline_days) return 'offline'
  if (d.disk_used_pct >= t.critical) return 'critical'
  if (d.disk_used_pct >= t.warn) return 'warn'
  return 'online'
}
// platform / managed_by : mêmes champs que l'API (module linux désactivé en démo → parc Windows).
function deviceRow(s, d) { return { ...d, platform: d.platform ?? 'windows', managed_by: d.managed_by ?? null, status: deviceStatus(s, d) } }

// Règles de conformité : verdict déterministe par poste (pas d'aléa entre
// deux appels), lisible dans la fiche poste et la vue Conformité.
const RULES = [
  { id: 'bitlocker', label: 'Chiffrement BitLocker actif', severity: 'critical' },
  { id: 'defender', label: 'Microsoft Defender actif et à jour', severity: 'high' },
  { id: 'firewall', label: 'Pare-feu Windows actif', severity: 'high' },
  { id: 'os_uptodate', label: 'Windows à jour (< 30 jours)', severity: 'medium' },
  { id: 'local_admin', label: 'Pas de compte admin local supplémentaire', severity: 'medium' },
  { id: 'screen_lock', label: 'Verrouillage automatique ≤ 15 min', severity: 'low' },
]
function ruleResult(d, rule) {
  const n = parseInt(d.id.slice(2), 10)
  if (d.hostname.startsWith('SRV') && rule.id === 'screen_lock') return 'not_applicable'
  if (rule.id === 'bitlocker' && (d.hostname === 'SRV-FILES' || d.hostname === 'PC-PAUL')) return 'fail'
  if (rule.id === 'defender' && n % 7 === 2) return 'fail'
  if (rule.id === 'os_uptodate' && n % 4 === 1) return 'fail'
  if (rule.id === 'screen_lock' && n === 12) return 'fail'
  return 'pass'
}
function deviceCompliance(d) {
  const results = RULES.map(r => { const st = ruleResult(d, r); return { rule_id: r.id, label: r.label, severity: r.severity, status: st, value: st === 'fail' ? (r.id === 'os_uptodate' ? { age_days: 42, max: 30 } : { protection_status: 'off' }) : {} } })
  return { counts: { pass: results.filter(r => r.status === 'pass').length, fail: results.filter(r => r.status === 'fail').length }, results }
}
function complianceSummary(s) {
  const evald = s.devices.filter(d => deviceStatus(s, d) !== 'offline')
  const per = evald.map(d => deviceCompliance(d))
  const failing = per.filter(p => p.counts.fail > 0).length
  const rules = RULES.map(r => {
    const rs = evald.map(d => ruleResult(d, r))
    return { ...r, pass: rs.filter(x => x === 'pass').length, fail: rs.filter(x => x === 'fail').length, not_applicable: rs.filter(x => x === 'not_applicable').length, total: rs.length }
  })
  const pass = per.reduce((a, p) => a + p.counts.pass, 0), total = per.reduce((a, p) => a + p.counts.pass + p.counts.fail, 0)
  return {
    summary: { devices_full_compliant: evald.length - failing, devices_with_failures: failing, devices_total: s.devices.length, devices_unevaluated: s.devices.length - evald.length,
      critical_failing: rules.find(r => r.id === 'bitlocker').fail, high_failing: rules.filter(r => r.severity === 'high').reduce((a, r) => a + r.fail, 0),
      score_pct: total ? Math.round(pass / total * 100) : 100, score_eval: evald.length, score_pass: pass },
    rules,
  }
}

function alertsView(s) {
  const t = thresholds(s)
  const snz = (d, type) => s.snoozes.find(x => x.device_id === d.id && x.alert_type === type && Date.parse(x.until_at) > Date.now())?.until_at || null
  const rows = s.devices.map(d => deviceRow(s, d))
  const disk_critical = rows.filter(d => d.status !== 'offline' && d.disk_used_pct >= t.critical).map(d => ({ id: d.id, hostname: d.hostname, disk_used_pct: d.disk_used_pct, user_name: d.user_name, snoozed_until: snz(d, 'disk_critical') }))
  const disk_warn = rows.filter(d => d.status !== 'offline' && d.disk_used_pct >= t.warn && d.disk_used_pct < t.critical).map(d => ({ id: d.id, hostname: d.hostname, disk_used_pct: d.disk_used_pct, user_name: d.user_name, snoozed_until: snz(d, 'disk_high') }))
  const offline = rows.filter(d => d.status === 'offline').map(d => ({ id: d.id, hostname: d.hostname, last_seen: d.last_seen, user_name: d.user_name, snoozed_until: snz(d, 'offline') }))
  const non_compliant = rows.filter(d => d.compliance_state === 'noncompliant').map(d => ({ id: d.id, hostname: d.hostname, compliance_state: d.compliance_state, user_name: d.user_name, snoozed_until: snz(d, 'noncompliant') }))
  const live = (l) => l.filter(x => !x.snoozed_until)
  const active = [
    ...live(disk_critical).map(x => ({ device_id: x.id, hostname: x.hostname, type: 'disk_critical', message: `Disque à ${x.disk_used_pct} %`, created_at: H(1) })),
    ...live(non_compliant).map(x => ({ device_id: x.id, hostname: x.hostname, type: 'noncompliant', message: 'Non conforme Intune', created_at: H(5) })),
  ]
  return { counts: { critical: live(disk_critical).length + live(non_compliant).length, warn: live(disk_warn).length + live(offline).length }, disk_critical, disk_warn, offline, non_compliant, active }
}

function ticketRow(s, tk) {
  const { messages, related_users, related_devices, attachments, mail_authors, ...row } = tk
  return { ...row, message_count: messages.length }
}
function recomputeAwaiting(tk) {
  const last = [...tk.messages].reverse().find(m => m.type !== 'system' && m.type !== 'ai_suggestion')
  tk.awaiting_reply = ['open', 'in_progress'].includes(tk.status) && !!last && last.author !== ME.displayName
  tk.updated_at = now()
}
function getTicket(s, id) { const tk = s.tickets.find(t => t.id === id); if (!tk) notFound('Ticket introuvable'); return tk }
function pushSystem(tk, content) { tk.messages.push({ id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'system', author: ME.displayName, content, created_at: now(), email_sent_at: null }) }
function audit(s, action, target, details = {}) { s.audit.unshift({ id: `au-${s.nextId++}`, action, by_user: ME.displayName, by_user_entra_id: ME.entraId, target, details, created_at: now() }) }

function deviceDetail(s, d) {
  const n = parseInt(d.id.slice(2), 10)
  const ram = d.ram_gb
  return {
    ...deviceRow(s, d), thresholds: thresholds(s),
    system_info: { cores: 10, threads: 12, cpu_mhz: 1800, mainboard: { manufacturer: d.manufacturer, product: '0J7WYY' }, gpus: [{ name: 'Intel Iris Xe', driver_version: '31.0.101.4577' }], monitors_count: 1 + (n % 2), battery_health: d.hostname.startsWith('SRV') ? null : { health_pct: 96 - (n % 5) * 4, cycle_count: 120 + n * 17 }, current_user: d.user ? `DEMO\\${d.user.email.split('@')[0]}` : null },
    health_signals: { bitlocker: { enabled: ruleResult(d, RULES[0]) === 'pass', encryption_method: 'XtsAes256' }, defender: { antivirus_enabled: true, realtime_protection: ruleResult(d, RULES[1]) === 'pass', antispyware_enabled: true, realtime_enabled: ruleResult(d, RULES[1]) === 'pass', signatures_age_days: n % 3, threats_last_30d: 0 }, firewall: { domain: true, private: true, public: true, domain_enabled: true, private_enabled: true, public_enabled: n % 5 !== 3 }, tpm_present: true, pending_reboot: n % 6 === 2 },
    system_perf: { ram_used_gb: Math.round(ram * (0.45 + (n % 5) * 0.08) * 10) / 10, ram_total_gb: ram, ram_used_pct: Math.round(45 + (n % 5) * 8), cpu_pct: 12 + (n % 7) * 5, cpu_avg_pct: 12 + (n % 7) * 5, cpu_max_pct: 60 + (n % 4) * 9, uptime_days: n % 9, uptime_seconds: (n % 9) * 86400 + 3600 * (n % 12), battery_pct: d.hostname.startsWith('LT') ? 40 + (n % 6) * 10 : null, battery_status: d.hostname.startsWith('LT') ? (n % 2 ? 'discharging' : 'ac') : null },
    system_perf_series: Array.from({ length: 48 }, (_, i) => ({ sampled_at: H(48 - i), cpu_pct: 15 + Math.round(Math.abs(Math.sin(i / 4 + n)) * 40), ram_pct: 45 + Math.round(Math.abs(Math.cos(i / 6 + n)) * 25) })),
    disks: [{ letter: 'C:', label: 'Windows', total_gb: 476, used_gb: Math.round(476 * d.disk_used_pct / 100), used_pct: d.disk_used_pct, size_gb: 476, fs: 'NTFS' }, ...(d.hostname.startsWith('SRV') ? [{ letter: 'D:', label: 'Data', total_gb: 1863, used_gb: 1400, used_pct: 75, size_gb: 1863, fs: 'NTFS' }] : [])],
    network: [{ name: 'Wi-Fi', adapter: 'Intel Wi-Fi 6E AX211', mac: `A4:6B:B6:12:${String(n).padStart(2, '0')}:56`, ip: `192.168.1.${20 + n}`, speed_mbps: 866, type: 'wifi', up: true }, { name: 'Netbird', adapter: 'wt0', mac: '—', ip: d.ip_netbird, type: 'netbird', up: true }],
    bandwidth: null, ping: null,
    laps: { username: s.settings.settings['agent.laps_recovery_username'] || 'opale-recovery', password_changed_at: H(72 + n * 5) },
    active_alerts: alertsView(s).active.filter(a => a.device_id === d.id),
    tickets: s.tickets.filter(t => t.device_id === d.id).map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, created_at: t.created_at })),
  }
}

// ── Routeur ──────────────────────────────────────────────────────────────────

const routes = []
const on = (method, pattern, fn) => routes.push({ method, parts: pattern.split('/').filter(Boolean), fn })
function match(parts, reqParts) {
  if (parts.length !== reqParts.length) return null
  const params = {}
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(reqParts[i])
    else if (parts[i] !== reqParts[i]) return null
  }
  return params
}

// Utilisateurs
on('POST', '/users/sync-me', () => ME)
on('POST', '/users/sync-all', ({ s }) => ({ synced: s.users.length }))
on('GET', '/users', ({ s }) => s.users.map(u => ({ ...u, device: s.devices.filter(d => d.assigned_user_id === u.entra_id).map(d => ({ id: d.id, hostname: d.hostname }))[0] || null, devices: s.devices.filter(d => d.assigned_user_id === u.entra_id).map(d => ({ id: d.id, hostname: d.hostname })) })))
on('GET', '/users/search', ({ s, q }) => s.users.filter(u => !q.q || lc(u.display_name).includes(lc(q.q)) || lc(u.email).includes(lc(q.q))).slice(0, 20))
on('GET', '/users/search-aad', ({ s, q }) => s.users.filter(u => !q.q || lc(u.display_name).includes(lc(q.q))).map(u => ({ id: u.entra_id, displayName: u.display_name, mail: u.email, jobTitle: u.job_title })).slice(0, 20))
on('GET', '/users/:id', ({ s, p }) => {
  const u = s.users.find(x => x.entra_id === p.id) || notFound('Utilisateur introuvable')
  const dev = s.devices.find(d => d.assigned_user_id === u.entra_id)
  return { ...u, device: dev ? deviceRow(s, dev) : null, devices: dev ? [deviceRow(s, dev)] : [], tickets: s.tickets.filter(t => t.user_id === u.entra_id).map(t => ticketRow(s, t)), groups: s.groups.filter(g => (s.groupMembers[g.id] || []).some(m => m.user_id === u.entra_id)).map(g => ({ id: g.id, name: g.name, color: g.color })) }
})
on('GET', '/users/:id/photo', () => notFound())

// Tableau de bord
on('GET', '/dashboard', ({ s }) => {
  const rows = s.devices.map(d => deviceRow(s, d))
  const al = alertsView(s)
  const comp = complianceSummary(s)
  const t = thresholds(s)
  const versions = {}
  rows.forEach(d => { versions[d.agent_version] = (versions[d.agent_version] || 0) + 1 })
  return {
    kpis: { alerts_active: al.counts.critical + al.counts.warn, proposals_pending: s.proposals.filter(p => p.status === 'pending').length, disk_critical: al.disk_critical.length,
      deployments_running: s.deployments.filter(d => d.status === 'running').length, deployments_pending: s.deployments.filter(d => d.status === 'pending').length,
      devices_online: rows.filter(d => d.status !== 'offline').length, devices_offline: rows.filter(d => d.status === 'offline').length, devices_total: rows.length,
      compliance_score_pct: comp.summary.score_pct, compliance_failing_devs: comp.summary.devices_with_failures, stock_low: s.stock.filter(i => i.quantity <= i.threshold).length,
      tickets_open: s.tickets.filter(x => ['open', 'in_progress'].includes(x.status)).length },
    thresholds: { disk_critical_pct: t.critical, disk_warn_pct: t.warn, agent_offline_days: t.offline_days },
    unhealthy_devices: rows.filter(d => d.status !== 'online').map(d => { const c = deviceCompliance(d); return { id: d.id, hostname: d.hostname, user_name: d.user_name, model: d.model, disk_used_pct: d.disk_used_pct, last_seen: d.last_seen, crit_fails: c.results.filter(r => r.status === 'fail' && r.severity === 'critical').length, high_fails: c.results.filter(r => r.status === 'fail' && r.severity === 'high').length } }).slice(0, 8),
    recent_tickets: [...s.tickets].sort(byDateDesc('created_at')).slice(0, 6).map(x => ({ id: x.id, title: x.title, status: x.status, is_auto: x.is_auto, user_id: x.user_id, user_name: x.requester_name, created_at: x.created_at })),
    recent_activity: s.audit.slice(0, 8).map(a => ({ action: a.action, target: a.target, device_hostname: a.device_hostname, device_id: a.device_id, by_user: a.by_user, created_at: a.created_at })),
    top_failing_rules: comp.rules.filter(r => r.fail > 0).sort((a, b) => b.fail - a.fail).slice(0, 4).map(r => ({ id: r.id, label: r.label, severity: r.severity, fail: r.fail })),
    agent_versions: { latest: '2.15.3', distribution: Object.entries(versions).map(([agent_version, count]) => ({ agent_version, count })) },
  }
})

// Postes
on('GET', '/devices', ({ s, q }) => {
  let rows = s.devices.map(d => deviceRow(s, d))
  const search = lc(q.search || q.q)
  if (search) rows = rows.filter(d => lc(d.hostname).includes(search) || lc(d.user_name).includes(search) || lc(d.model).includes(search) || lc(d.serial).includes(search) || lc(d.ip_netbird).includes(search))
  if (q.status === 'online') rows = rows.filter(d => d.status === 'online')
  else if (q.status === 'offline') rows = rows.filter(d => d.status === 'offline')
  else if (q.status === 'critical') rows = rows.filter(d => ['critical', 'warn'].includes(d.status))
  else if (q.status === 'unassigned') rows = rows.filter(d => !d.assigned_user_id)
  const t = thresholds(s)
  return { devices: rows.slice(0, num(q.limit, 200)), total: rows.length, thresholds: { warn: t.warn, critical: t.critical, disk_warn_pct: t.warn, disk_critical_pct: t.critical } }
})
on('POST', '/devices/force-sync', ({ b }) => ({ ok: (b.ids || []).length, skipped: 0, errors: [] }))
on('POST', '/devices/force-checkin', ({ b }) => ({ ok: (b.ids || []).length, skipped: 0, errors: [] }))
on('GET', '/devices/:id', ({ s, p }) => deviceDetail(s, s.devices.find(d => d.id === p.id) || notFound('Poste introuvable')))
on('DELETE', '/devices/:id', ({ s, p }) => { const i = s.devices.findIndex(d => d.id === p.id); if (i === -1) notFound(); audit(s, 'device_deleted', s.devices[i].hostname); s.devices.splice(i, 1); return null })
on('DELETE', '/devices/:id/ssh-host-key', () => ({ ok: true }))
on('GET', '/devices/:id/compliance', ({ s, p }) => deviceCompliance(s.devices.find(d => d.id === p.id) || notFound()))
on('GET', '/devices/:id/remote-sessions', ({ s, p }) => ({ sessions: p.id === s.devices[1]?.id ? [{ id: 'rs-1', transport: 'ssh', ip: s.devices[1].ip_netbird, by_name: ME.displayName, started_at: H(0.5), ended_at: H(0.3), duration_s: 754, end_reason: 'closed' }, { id: 'rs-2', transport: 'agent_console', shell: 'powershell', by_name: 'Hugo Blanc', started_at: H(40), ended_at: H(39.8), duration_s: 610, end_reason: 'closed' }] : [] }))
on('GET', '/remote-sessions/:id/log', () => ({ available: false, reason: 'Journal non conservé dans la démo' }))
on('GET', '/admin-credentials/:id', ({ s, p }) => { const d = s.devices.find(x => x.id === p.id) || notFound(); audit(s, 'laps_revealed', d.hostname); return { username: s.settings.settings['agent.laps_recovery_username'] || 'opale-recovery', password: 'Demo-' + d.hostname.slice(-4) + '-x7Kq2', password_changed_at: H(72), last_accessed_at: now(), last_accessed_by: ME.displayName, rotation_requested_at: null } })
on('POST', '/admin-credentials/:id/rotate', () => ({ ok: true, rotation_requested_at: now() }))

// Tickets — routes fixes avant /:id
on('GET', '/tickets/tags', ({ s }) => s.tags)
on('POST', '/tickets/tags', ({ s, b }) => { const t = { id: nextId(s, 'tag'), name: String(b.name || '').trim(), color: b.color || 'slate' }; if (!t.name) throw new ApiErr(400, 'Nom requis'); s.tags.push(t); return t })
on('DELETE', '/tickets/tags/:id', ({ s, p }) => { s.tags = s.tags.filter(t => t.id !== p.id); s.tickets.forEach(t => { t.tags = t.tags.filter(g => g.id !== p.id) }); return null })
on('GET', '/tickets/count', ({ s }) => ({ open: s.tickets.filter(t => t.status === 'open' && !t.assigned_to_entra_id).length, awaiting_reply: s.tickets.filter(t => t.awaiting_reply).length }))
on('GET', '/tickets', ({ s, q }) => {
  let rows = s.tickets
  if (q.status === 'closed') rows = rows.filter(t => t.status === 'closed')
  else if (q.status) rows = rows.filter(t => t.status === q.status)
  else rows = rows.filter(t => t.status !== 'closed')
  if (q.is_auto === 'true') rows = rows.filter(t => t.is_auto)
  if (q.is_auto === 'false') rows = rows.filter(t => !t.is_auto)
  if (q.priority) { const set = q.priority.split(','); rows = rows.filter(t => set.includes(t.priority)) }
  if (q.tag) { const set = q.tag.split(','); rows = rows.filter(t => t.tags.some(g => set.includes(g.id))) }
  if (q.assigned_to === 'me') rows = rows.filter(t => t.assigned_to_entra_id === ME.entraId)
  else if (q.assigned_to === 'unassigned') rows = rows.filter(t => !t.assigned_to_entra_id)
  else if (q.assigned_to) rows = rows.filter(t => t.assigned_to_entra_id === q.assigned_to)
  if (q.device_id) rows = rows.filter(t => t.device_id === q.device_id)
  if (q.created_from) rows = rows.filter(t => t.created_at >= q.created_from)
  if (q.created_to) rows = rows.filter(t => t.created_at.slice(0, 10) <= q.created_to)
  const search = lc(q.q || q.search)
  if (search) rows = rows.filter(t => lc(t.title).includes(search) || lc(t.hostname).includes(search) || lc(t.requester_name).includes(search) || lc(t.description).includes(search) || t.messages.some(m => lc(m.content).includes(search)))
  return [...rows].sort(byDateDesc('updated_at')).slice(num(q.offset, 0), num(q.offset, 0) + num(q.limit, 50)).map(t => ticketRow(s, t))
})
on('POST', '/tickets', ({ s, b }) => {
  const title = String(b.title || '').trim(); if (!title) throw new ApiErr(400, 'Le titre est requis')
  const requester = s.users.find(u => u.entra_id === b.user_id)
  const device = s.devices.find(d => d.id === b.device_id)
  const tk = { id: nextId(s, 't'), title, description: b.description || '', status: 'open', priority: b.priority || 'normal', created_at: now(), updated_at: now(), resolved_at: null,
    requester_name: requester?.display_name || null, requester_email: requester?.email || null, user_id: requester?.entra_id || null, hostname: device?.hostname || null, device_id: device?.id || null,
    assigned_to_name: b.assigned_to_name || null, assigned_to_entra_id: b.assigned_to_entra_id || null, is_auto: false, source: 'manual', created_by_name: ME.displayName,
    has_inbound_mail: false, inbound_mail_count: 0, outbound_mail_count: 0, mail_authors: [], tags: s.tags.filter(g => (b.tag_ids || []).includes(g.id)),
    related_users: requester ? [{ entra_id: requester.entra_id, display_name: requester.display_name, email: requester.email, role: 'requester' }] : [], related_devices: device ? [{ id: device.id, hostname: device.hostname }] : [], attachments: [], messages: [], awaiting_reply: false }
  if (tk.description) tk.messages.push({ id: nextId(s, 'm'), type: 'comment', author: ME.displayName, content: tk.description, created_at: now(), email_sent_at: null })
  s.tickets.unshift(tk); audit(s, 'ticket_created', title)
  return tk
})
on('GET', '/tickets/:id', ({ s, p }) => getTicket(s, p.id))
on('PATCH', '/tickets/:id', ({ s, p, b }) => {
  const tk = getTicket(s, p.id)
  if (b.title !== undefined) tk.title = String(b.title).trim() || tk.title
  if (b.description !== undefined) tk.description = b.description
  if (b.priority) tk.priority = b.priority
  if (b.status && b.status !== tk.status) {
    tk.status = b.status
    if (['resolved', 'closed'].includes(b.status)) { tk.resolved_at = now(); if (b.status === 'resolved') tk.messages.push({ id: nextId(s, 'm'), type: 'resolution', author: ME.displayName, content: 'Ticket résolu', created_at: now() }) }
    else { tk.resolved_at = null; pushSystem(tk, b.status === 'in_progress' ? 'Ticket pris en charge' : 'Ticket rouvert') }
  }
  if ('assigned_to_entra_id' in b) {
    const u = b.assigned_to_entra_id === ME.entraId ? { entra_id: ME.entraId, display_name: ME.displayName } : s.users.find(x => x.entra_id === b.assigned_to_entra_id)
    tk.assigned_to_entra_id = u?.entra_id || null; tk.assigned_to_name = u?.display_name || b.assigned_to_name || null
    if (u && tk.status === 'open') tk.status = 'in_progress'
  }
  if ('user_id' in b) { const u = s.users.find(x => x.entra_id === b.user_id); tk.user_id = u?.entra_id || null; tk.requester_name = u?.display_name || null; tk.requester_email = u?.email || null; if (u && !tk.related_users.some(r => r.entra_id === u.entra_id)) tk.related_users.unshift({ entra_id: u.entra_id, display_name: u.display_name, email: u.email, role: 'requester' }) }
  if ('device_id' in b) { const d = s.devices.find(x => x.id === b.device_id); tk.device_id = d?.id || null; tk.hostname = d?.hostname || null; if (d && !tk.related_devices.some(r => r.id === d.id)) tk.related_devices.unshift({ id: d.id, hostname: d.hostname }) }
  recomputeAwaiting(tk)
  return tk
})
on('POST', '/tickets/:id/messages', ({ s, p, b }) => {
  const tk = getTicket(s, p.id)
  const content = String(b.content || '').trim(); if (!content) throw new ApiErr(400, 'Contenu requis')
  // Comme le serveur : un admin écrit une note interne par défaut ; elle
  // devient un mail via send-by-mail.
  const m = { id: nextId(s, 'm'), type: b.type === 'comment' ? 'comment' : 'internal_note', author: ME.displayName, content, created_at: now(), email_sent_at: null }
  if (m.type === 'comment' && !tk.has_inbound_mail) m.email_sent_at = now()
  tk.messages.push(m); recomputeAwaiting(tk); return m
})
on('POST', '/tickets/:id/messages/:mid/send-by-mail', ({ s, p }) => { const tk = getTicket(s, p.id); if (!tk.has_inbound_mail) throw new ApiErr(409, 'Ticket sans origine mail, envoi impossible'); const m = tk.messages.find(x => x.id === p.mid) || notFound(); m.type = 'comment'; m.email_sent_at = now(); m.outbound_failed_at = null; tk.outbound_mail_count++; return m })
on('POST', '/tickets/:id/messages/:mid/retry-send', ({ s, p }) => { const tk = getTicket(s, p.id); const m = tk.messages.find(x => x.id === p.mid) || notFound(); m.email_sent_at = now(); m.outbound_failed_at = null; return m })
on('POST', '/tickets/:id/ai-suggest', ({ s, p }) => {
  const tk = getTicket(s, p.id)
  const who = (tk.requester_name || 'Bonjour').split(' ')[0]
  const m = { id: nextId(s, 'm'), type: 'ai_suggestion', author: 'Opale IA', content: `Bonjour ${who},\n\nMerci pour votre message. J'ai bien pris en compte le problème « ${tk.title} ». Je regarde cela dès maintenant et je reviens vers vous dans la matinée avec une solution ou un créneau d'intervention.\n\nBonne journée,\n${ME.displayName}`, created_at: now() }
  tk.messages.push(m); return m
})
on('DELETE', '/tickets/:id/messages/:mid', ({ s, p }) => { const tk = getTicket(s, p.id); tk.messages = tk.messages.filter(m => m.id !== p.mid); recomputeAwaiting(tk); return null })
on('POST', '/tickets/:id/attachments', ({ s, p, b }) => { const tk = getTicket(s, p.id); const a = { id: nextId(s, 'att'), filename: b.filename || 'fichier.bin', size_bytes: b.size || 0, created_at: now(), uploaded_by: ME.displayName }; tk.attachments.push(a); return a })
on('DELETE', '/tickets/:id/attachments/:aid', ({ s, p }) => { const tk = getTicket(s, p.id); tk.attachments = tk.attachments.filter(a => a.id !== p.aid); return null })
on('GET', '/tickets/:id/attachments/:aid/download', () => nope('Pièces jointes non stockées dans la démo'))
on('POST', '/tickets/:id/users', ({ s, p, b }) => { const tk = getTicket(s, p.id); const u = s.users.find(x => x.entra_id === b.entra_id) || notFound('Utilisateur introuvable'); const role = b.role || 'involved'; tk.related_users = tk.related_users.filter(r => r.entra_id !== u.entra_id); if (role === 'requester') { tk.related_users.forEach(r => { if (r.role === 'requester') r.role = 'involved' }); tk.user_id = u.entra_id; tk.requester_name = u.display_name; tk.requester_email = u.email } tk.related_users.push({ entra_id: u.entra_id, display_name: u.display_name, email: u.email, role }); return tk })
on('DELETE', '/tickets/:id/users/:eid', ({ s, p }) => { const tk = getTicket(s, p.id); tk.related_users = tk.related_users.filter(r => r.entra_id !== p.eid); if (tk.user_id === p.eid) { tk.user_id = null; tk.requester_name = null; tk.requester_email = null } return null })
on('POST', '/tickets/:id/devices', ({ s, p, b }) => { const tk = getTicket(s, p.id); const d = s.devices.find(x => x.id === b.device_id) || notFound('Poste introuvable'); if (!tk.related_devices.some(r => r.id === d.id)) tk.related_devices.push({ id: d.id, hostname: d.hostname }); if (!tk.device_id) { tk.device_id = d.id; tk.hostname = d.hostname } return tk })
on('DELETE', '/tickets/:id/devices/:did', ({ s, p }) => { const tk = getTicket(s, p.id); tk.related_devices = tk.related_devices.filter(r => r.id !== p.did); if (tk.device_id === p.did) { tk.device_id = tk.related_devices[0]?.id || null; tk.hostname = tk.related_devices[0]?.hostname || null } return null })
on('POST', '/tickets/:id/merge', ({ s, p, b }) => { const src = getTicket(s, p.id); const dst = getTicket(s, b.target_ticket_id); dst.messages.push(...src.messages.filter(m => m.type !== 'system')); dst.messages.sort((a, c) => Date.parse(a.created_at) - Date.parse(c.created_at)); pushSystem(dst, `Ticket « ${src.title} » fusionné ici`); src.status = 'closed'; src.merged_into = dst.id; recomputeAwaiting(dst); return { ok: true, target: dst.id } })
on('POST', '/tickets/:id/tags', ({ s, p, b }) => { const tk = getTicket(s, p.id); const g = s.tags.find(x => x.id === b.tag_id) || notFound('Tag introuvable'); if (!tk.tags.some(x => x.id === g.id)) tk.tags.push(g); return tk })
on('DELETE', '/tickets/:id/tags/:tid', ({ s, p }) => { const tk = getTicket(s, p.id); tk.tags = tk.tags.filter(g => g.id !== p.tid); return null })

// Propositions
on('GET', '/ticket-proposals/count', ({ s }) => ({ pending: s.proposals.filter(p => p.status === 'pending').length }))
on('GET', '/ticket-proposals', ({ s, q }) => s.proposals.filter(p => !q.status || p.status === q.status))
on('POST', '/ticket-proposals/:id/accept', ({ s, p }) => {
  const pr = s.proposals.find(x => x.id === p.id) || notFound(); pr.status = 'accepted'
  const device = s.devices.find(d => d.id === pr.device_id)
  const tk = { id: nextId(s, 't'), title: pr.suggested_title, description: pr.suggested_description || '', status: 'open', priority: pr.suggested_priority || 'normal', created_at: now(), updated_at: now(), resolved_at: null, requester_name: null, requester_email: null, user_id: null, hostname: device?.hostname || null, device_id: device?.id || null, assigned_to_name: null, assigned_to_entra_id: null, is_auto: true, source: pr.source, created_by_name: 'Opale', has_inbound_mail: false, inbound_mail_count: 0, outbound_mail_count: 0, mail_authors: [], tags: [], related_users: [], related_devices: device ? [{ id: device.id, hostname: device.hostname }] : [], attachments: [], messages: [{ id: nextId(s, 'm'), type: 'system', author: 'Opale', content: 'Ticket créé depuis une proposition', created_at: now() }], awaiting_reply: false }
  s.tickets.unshift(tk); return { ticket: tk, id: tk.id }
})
on('POST', '/ticket-proposals/:id/reject', ({ s, p, b }) => { const pr = s.proposals.find(x => x.id === p.id) || notFound(); pr.status = 'rejected'; pr.reject_reason = b.reason || null; return { ok: true } })

// Pont mail
const pendingMails = (s) => s.inbox.filter(m => m.action === 'pending_review')
const threadOf = (s, m) => s.inbox.filter(x => (x.conversation_id || x.id) === (m.conversation_id || m.id)).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))
function absorbThread(s, m, tk) {
  const mails = threadOf(s, m)
  for (const x of mails) {
    if (tk.messages.some(mm => mm.mail_id === x.id)) continue
    tk.messages.push({ id: nextId(s, 'm'), type: 'comment', author: x.from_name || x.from_address, content: x.body_text || x.body_preview, created_at: x.received_at, email_sent_at: x.received_at, mail_id: x.id })
    x.action = 'message_appended'
  }
  tk.messages.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  tk.has_inbound_mail = true; tk.inbound_mail_count = tk.messages.filter(x => x.mail_id).length
  const authors = new Set(tk.mail_authors); mails.forEach(x => { if (x.from_name) authors.add(x.from_name); authors.add(x.from_address) }); tk.mail_authors = [...authors]
  recomputeAwaiting(tk)
  return mails.length
}
on('GET', '/email/inbox/count', ({ s }) => { const pm = pendingMails(s); return { pending: pm.length, threads: new Set(pm.map(m => m.conversation_id || m.id)).size } })
on('GET', '/email/inbox', ({ s, q }) => pendingMails(s).sort(byDateDesc('received_at')).slice(0, num(q.limit, 200)).map(({ body_text, ...m }) => m))
on('GET', '/email/inbox/:id/thread', ({ s, p }) => { const m = s.inbox.find(x => x.id === p.id) || notFound('Mail introuvable'); return threadOf(s, m).map(({ body_text, ...x }) => x) })
on('GET', '/email/inbox/:id/body', ({ s, p }) => { const m = s.inbox.find(x => x.id === p.id) || notFound('Mail introuvable'); return { body_text: m.body_text || m.body_preview, source: 'db' } })
on('POST', '/email/inbox/:id/to-ticket', ({ s, p }) => {
  const m = s.inbox.find(x => x.id === p.id) || notFound('Mail introuvable')
  const first = threadOf(s, m)[0]
  const requester = s.users.find(u => u.entra_id === first.suggested_user_id)
  const device = s.devices.find(d => d.id === first.suggested_device_id)
  const tk = { id: nextId(s, 't'), title: String(first.subject || '(sans objet)').replace(/^\s*(?:(?:re|tr|fwd|fw)\s*:\s*)+/i, ''), description: '', status: 'open', priority: 'normal', created_at: now(), updated_at: now(), resolved_at: null,
    requester_name: requester?.display_name || null, requester_email: requester?.email || first.from_address, user_id: requester?.entra_id || null, hostname: device?.hostname || null, device_id: device?.id || null,
    assigned_to_name: null, assigned_to_entra_id: null, is_auto: false, source: 'email', created_by_name: ME.displayName, has_inbound_mail: true, inbound_mail_count: 0, outbound_mail_count: 0, mail_authors: [], tags: [],
    related_users: requester ? [{ entra_id: requester.entra_id, display_name: requester.display_name, email: requester.email, role: 'requester' }] : [], related_devices: device ? [{ id: device.id, hostname: device.hostname }] : [], attachments: [], messages: [], awaiting_reply: false }
  const absorbed = absorbThread(s, m, tk)
  s.tickets.unshift(tk); audit(s, 'ticket_created', tk.title, { source: 'email', absorbed })
  return { ticket: tk, absorbed }
})
on('POST', '/email/inbox/:id/attach', ({ s, p, b }) => { const m = s.inbox.find(x => x.id === p.id) || notFound('Mail introuvable'); const tk = getTicket(s, b.ticket_id); const appended = absorbThread(s, m, tk); return { ok: true, appended, ticket_id: tk.id } })
on('POST', '/email/inbox/:id/dismiss', ({ s, p, b }) => { const m = s.inbox.find(x => x.id === p.id) || notFound('Mail introuvable'); (b.whole_thread ? threadOf(s, m) : [m]).forEach(x => { x.action = 'skipped_other' }); return { ok: true } })
on('GET', '/email/stats', ({ s, q }) => { const by = {}; s.inbox.forEach(m => { by[m.action] = (by[m.action] || 0) + 1 }); by.message_appended = (by.message_appended || 0) + 38; by.skipped_other = (by.skipped_other || 0) + 12; return { total: Object.values(by).reduce((a, b) => a + b, 0), days: num(q.days, 7), by_action: by } })
on('GET', '/email/recent', ({ s, q }) => s.inbox.filter(m => !q.status || m.action === q.status).sort(byDateDesc('received_at')).slice(0, num(q.limit, 50)).map(({ body_text, ...m }) => ({ ...m, ticket_id: null })))
on('GET', '/email/status', ({ s }) => ({ poll_enabled: true, mailboxes: [{ address: 'support@demo.opale.fr', cursor: now(), total_ingested: 61 + s.inbox.length, last_received_at: pendingMails(s)[0]?.received_at || now(), blocked: null }], sent_mailboxes: [{ address: 'support@demo.opale.fr', cursor: now(), blocked: null }] }))
on('GET', '/email/diagnostic', ({ s }) => ({ config: { inboxes: ['support@demo.opale.fr'], poll_enabled: true, send_enabled: true, sender_address: 'support@demo.opale.fr', mark_as_read_enabled: true, classifier: { enabled: true, url: 'https://api.mistral.ai', model: 'mistral-small', fallback_intent: 'new_ticket' } }, cursor: { 'support@demo.opale.fr': now() }, blocked: [], activity: { days: 7, total: 14, by_action: { pending_review: pendingMails(s).length, message_appended: 9, skipped_other: 2 } }, recent_errors: [], in_queue: 0 }))

// Alertes
on('GET', '/alerts', ({ s }) => alertsView(s))
on('GET', '/alert-snoozes', ({ s }) => s.snoozes.map(x => ({ ...x, hostname: s.devices.find(d => d.id === x.device_id)?.hostname })))
on('POST', '/alert-snoozes', ({ s, b }) => { s.snoozes = s.snoozes.filter(x => !(x.device_id === b.device_id && x.alert_type === b.alert_type)); const x = { id: nextId(s, 'snz'), device_id: b.device_id, alert_type: b.alert_type, until_at: b.until_at, reason: b.reason || null, by_name: ME.displayName, created_at: now() }; s.snoozes.push(x); return x })
on('DELETE', '/alert-snoozes/:id', ({ s, p }) => { s.snoozes = s.snoozes.filter(x => x.id !== p.id); return null })

// Paramètres
on('GET', '/settings/audit', ({ s, q }) => { let rows = s.audit; if (q.action) rows = rows.filter(a => a.action === q.action); if (q.device_id) rows = rows.filter(a => a.device_id === q.device_id); const search = lc(q.q); if (search) rows = rows.filter(a => lc(a.target).includes(search) || lc(a.by_user).includes(search)); const off = num(q.offset, 0); return { total: rows.length, rows: rows.slice(off, off + num(q.limit, 50)) } })
on('GET', '/settings', ({ s }) => s.settings)
on('PATCH', '/settings', ({ s, b }) => { Object.assign(s.settings.settings, b); return s.settings })
on('POST', '/settings/tokens', ({ s, b }) => { const t = { id: nextId(s, 'tk'), label: b.label || 'token', hostname: null, created_at: now(), created_by: ME.displayName, last_used_at: null, revoked_at: null }; s.settings.tokens.unshift(t); audit(s, 'token_created', t.label); return { ...t, token: 'opale_demo_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14) } })
on('DELETE', '/settings/tokens/:id', ({ s, p }) => { const t = s.settings.tokens.find(x => x.id === p.id) || notFound(); t.revoked_at = now(); return null })
on('DELETE', '/settings/cli-tokens/:id', ({ s, p }) => { const t = s.settings.cli_tokens.find(x => x.id === p.id) || notFound(); t.revoked_at = now(); return null })
on('POST', '/settings/ssh-keys', ({ s, b }) => { if (!b.public_key || !/^ssh-(ed25519|rsa|ecdsa)/.test(b.public_key)) throw new ApiErr(400, 'Clé publique invalide'); const k = { id: nextId(s, 'k'), label: b.label || 'clé', public_key: b.public_key, created_at: now(), created_by: ME.displayName }; s.settings.ssh_keys.push(k); return k })
on('DELETE', '/settings/ssh-keys/:id', ({ s, p }) => { s.settings.ssh_keys = s.settings.ssh_keys.filter(k => k.id !== p.id); return null })
on('PATCH', '/settings/admins/:id', ({ s, p, b }) => { const u = s.users.find(x => x.entra_id === p.id); const a = s.settings.admins.find(x => x.entra_id === p.id); if (b.is_admin && !a && u) s.settings.admins.push({ entra_id: u.entra_id, display_name: u.display_name, email: u.email, is_admin: true }); if (!b.is_admin) { if (p.id === ME.entraId) throw new ApiErr(400, 'Impossible de se retirer soi-même'); s.settings.admins = s.settings.admins.filter(x => x.entra_id !== p.id) } return { ok: true, admins: s.settings.admins } })
on('POST', '/settings/sync-intune', ({ s }) => { audit(s, 'intune_sync', null, { upserted: s.devices.length, errors: 0 }); return { ok: true, upserted: s.devices.length, errors: [] } })
on('GET', '/me/prefs', ({ s }) => s.prefs)
on('PATCH', '/me/prefs', ({ s, b }) => { Object.assign(s.prefs, b); return s.prefs })
on('GET', '/push/vapid-public', () => ({ publicKey: null }))
on('POST', '/push/subscribe', () => ({ ok: true }))

// Onboarding
const obRow = (ob) => ({ ...ob, total_checks: ob.checks.length, done_checks: ob.checks.filter(c => c.done).length })
on('GET', '/onboarding', ({ s, q }) => s.onboardings.filter(o => !q.status || q.status === 'all' || (q.status === 'active' ? o.status !== 'done' : o.status === q.status)).map(obRow))
on('POST', '/onboarding', ({ s, b }) => {
  const kind = b.kind === 'offboard' ? 'offboard' : 'onboard'
  const checks = (kind === 'onboard'
    ? [['Compte', 'Créer le compte Entra', true], ['Compte', 'Ajouter aux groupes de sécurité', true], ['Compte', 'Licence Microsoft 365', true], ['Matériel', 'Préparer le poste (Autopilot)', false], ['Matériel', 'Casque + écran', false], ['Matériel', 'Badge d\'accès', false], ['Accueil', 'Mail de bienvenue', false], ['Accueil', 'Présentation outils (30 min)', false]]
    : [['Compte', 'Désactiver le compte Entra', true], ['Compte', 'Transférer la boîte mail', false], ['Matériel', 'Récupérer le portable', false], ['Matériel', 'Récupérer le badge', false]]
  ).map(([section, label, is_auto], i) => ({ id: `c${i + 1}`, section, label, is_auto, done: false }))
  const ob = { id: nextId(s, 'ob'), person_name: String(b.person_name || '').trim(), kind, status: 'in_progress', contract_type: b.contract_type || null, start_date: b.start_date || null, end_date: b.end_date || null, email: b.email || null, role: b.role || null, department: b.department || null, manager_name: b.manager_name || null, notes: b.notes || '', by_name: ME.displayName, created_at: now(), entra_id_created: null, checks }
  if (!ob.person_name) throw new ApiErr(400, 'Nom requis')
  s.onboardings.unshift(ob); return obRow(ob)
})
on('GET', '/onboarding/:id', ({ s, p }) => obRow(s.onboardings.find(o => o.id === p.id) || notFound('Dossier introuvable')))
on('PATCH', '/onboarding/:id', ({ s, p, b }) => { const ob = s.onboardings.find(o => o.id === p.id) || notFound(); Object.assign(ob, b); return obRow(ob) })
on('PATCH', '/onboarding/:id/checks/:cid', ({ s, p, b }) => { const ob = s.onboardings.find(o => o.id === p.id) || notFound(); const c = ob.checks.find(x => x.id === p.cid) || notFound(); c.done = !!b.done; c.done_by = c.done ? ME.displayName : null; c.done_at = c.done ? now() : null; if (ob.checks.every(x => x.done)) ob.status = 'done'; return obRow(ob) })
on('POST', '/onboarding/:id/checks/:cid/auto', ({ s, p }) => { const ob = s.onboardings.find(o => o.id === p.id) || notFound(); const c = ob.checks.find(x => x.id === p.cid) || notFound(); c.done = true; c.done_by = ME.displayName; c.done_at = now(); const created = c.label.startsWith('Créer le compte') ? { id: 'entra-' + ob.id, userPrincipalName: (ob.email || 'nouveau@demo.opale.fr'), temporaryPassword: 'Bienvenue-' + Math.random().toString(36).slice(2, 8) + '!' } : null; if (created) ob.entra_id_created = created.id; return { ok: true, created, warning: null } })

// Scripts
on('GET', '/scripts/executions/device/:id', ({ s, p, q }) => { const rows = s.executions.filter(e => e.device_id === p.id).sort(byDateDesc('queued_at')); const off = num(q.offset, 0); return { total: rows.length, limit: 20, rows: rows.slice(off, off + 20) } })
on('GET', '/scripts', ({ s }) => s.scripts)
on('POST', '/scripts', ({ s, b }) => { const sc = { id: nextId(s, 'sc'), name: String(b.name || '').trim(), description: b.description || '', category: b.category || 'Divers', shell_type: b.shell_type || 'powershell', is_builtin: false, by_name: ME.displayName, exec_count: 0, last_run: null, code: b.code || '' }; if (!sc.name) throw new ApiErr(400, 'Nom requis'); s.scripts.push(sc); return sc })
on('PUT', '/scripts/:id', ({ s, p, b }) => { const sc = s.scripts.find(x => x.id === p.id) || notFound(); Object.assign(sc, { name: b.name ?? sc.name, description: b.description ?? sc.description, category: b.category ?? sc.category, shell_type: b.shell_type ?? sc.shell_type, code: b.code ?? sc.code }); return sc })
on('DELETE', '/scripts/:id', ({ s, p }) => { s.scripts = s.scripts.filter(x => x.id !== p.id); return null })
on('POST', '/scripts/:id/run', ({ s, p, b }) => { const sc = s.scripts.find(x => x.id === p.id) || notFound('Script introuvable'); const d = s.devices.find(x => x.id === b.device_id) || notFound('Poste introuvable'); const e = { id: nextId(s, 'ex'), device_id: d.id, hostname: d.hostname, script_id: sc.id, script_name: sc.name, by_name: ME.displayName, status: 'queued', output: null, queued_at: now(), completed_at: null }; s.executions.unshift(e); sc.exec_count++; sc.last_run = now(); audit(s, 'setup_script', d.hostname, { script: sc.name }); setTimeout(() => { e.status = 'done'; e.output = `[démo] ${sc.name} exécuté sur ${d.hostname}\nOK`; e.completed_at = now() }, 4000); return { ok: true, execution: e } })

// Rapports & points
on('GET', '/rapports', ({ s, q }) => {
  const days = num(q.days, 30); const rows = s.devices.map(d => deviceRow(s, d)); const comp = complianceSummary(s)
  const cnt = (id) => { const r = comp.rules.find(x => x.id === id); return { key: id, ok: r.pass, ko: r.fail, na: r.not_applicable } }
  return { kpis: { parc: { total: rows.length, active_7d: rows.filter(d => d.status !== 'offline').length }, security_score: comp.summary.score_pct, actions_count: 148, time_saved: { minutes: 1260, eur: 473, annual_eur: 5680 } },
    compliance: [cnt('bitlocker'), cnt('defender'), cnt('firewall'), { key: 'tpm', ok: rows.length - 1, ko: 0, na: 1 }, { key: 'reboot', ok: rows.length - 4, ko: 4, na: 0 }, cnt('os_uptodate')].map(c => c.key === 'os_uptodate' ? { ...c, key: 'update' } : c),
    activity: [{ label: 'Scripts exécutés à distance', count: 64, estimated_minutes: 10, total_eur: 240 }, { label: 'Packages déployés', count: s.deployments.filter(d => d.status === 'success').length, estimated_minutes: 15, total_eur: 175 }, { label: 'Sessions SSH', count: 53, estimated_minutes: 3, total_eur: 58 }, { label: 'Mails triés en tickets', count: 38, estimated_minutes: 4, total_eur: 57 }],
    tickets_by_tag: { weeks: Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.now() - (11 - i) * 7 * 86400000); return `${d.getFullYear()}-W${String(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}` }), datasets: [{ name: 'réseau', color: 'blue', data: [2, 3, 1, 4, 2, 3, 5, 2, 1, 3, 2, 4] }, { name: 'urgent', color: 'red', data: [1, 0, 2, 1, 0, 1, 2, 1, 0, 1, 1, 0] }, { name: 'matériel', color: 'amber', data: [1, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2, 1] }, { name: null, color: null, data: [4, 5, 3, 6, 4, 5, 3, 4, 6, 5, 4, 3] }] },
    disk_top: [...rows].sort((a, b) => b.disk_used_pct - a.disk_used_pct).slice(0, 5).map(d => ({ id: d.id, hostname: d.hostname, disk_used_pct: d.disk_used_pct })),
    battery: { total: rows.filter(d => d.hostname.startsWith('LT')).length, good: rows.filter(d => d.hostname.startsWith('LT')).length - 2, degraded: 1, critical: 1 }, days }
})
on('GET', '/reviews', ({ s }) => s.reviews.map(({ snapshot, sections, ...r }) => ({ ...r, section_count: sections.length })))
on('POST', '/reviews', ({ s, b }) => { const r = { id: nextId(s, 'rv'), title: String(b.title || '').trim(), period_start: b.period_start || null, period_end: b.period_end || null, snapshot: b.snapshot || {}, sections: Array.isArray(b.sections) ? b.sections : [], created_by_name: ME.displayName, created_by_entra_id: ME.entraId, created_at: now(), updated_at: now() }; if (!r.title) throw new ApiErr(400, 'Titre requis'); s.reviews.unshift(r); return r })
on('GET', '/reviews/:id', ({ s, p }) => s.reviews.find(r => r.id === p.id) || notFound('Point introuvable'))
on('PATCH', '/reviews/:id', ({ s, p, b }) => { const r = s.reviews.find(x => x.id === p.id) || notFound('Point introuvable'); Object.assign(r, b, { updated_at: now() }); return r })
on('DELETE', '/reviews/:id', ({ s, p }) => { s.reviews = s.reviews.filter(r => r.id !== p.id); return null })
on('GET', '/network/top', ({ s, q }) => {
  const limit = num(q.limit, 20); const rows = s.devices.map(d => deviceRow(s, d))
  return { period: q.period || '24h', sort: q.sort || 'total', rows: rows.slice(0, limit).map((d, i) => { const n = parseInt(d.id.slice(2), 10); const recv = (30 - n) * 0.9 * 1024 ** 3, sent = (30 - n) * 0.2 * 1024 ** 3; return { device_id: d.id, hostname: d.hostname, user_name: d.user_name, adapter: n % 2 ? 'Wi-Fi' : 'Ethernet', recv_bytes: recv, sent_bytes: sent, total_bytes: recv + sent, peak_mbps: Math.round(640 / (n % 6 + 1)), online: d.status !== 'offline', series_mbps: Array.from({ length: 24 }, (_, k) => Math.abs(Math.sin(k / 3 + n)) * 40 + (k === 15 && n === 1 ? 60 : 0)), trend: { delta_pct: n === 1 ? 68 : n === 2 ? 14 : -5 }, last_seen: d.last_seen } }).sort((a, b) => b.total_bytes - a.total_bytes) }
})

// Packages & déploiements
const pkgCounts = (s, id) => { const deps = s.deployments.filter(d => d.package_id === id); const c = (st) => deps.filter(d => d.status === st).length; return { pending: c('pending'), running: c('running'), success: c('success'), failed: c('failed'), cancelled: c('cancelled'), detected: c('success'), total_rows: deps.length, unique_devices: new Set(deps.map(d => d.device_id)).size } }
on('GET', '/packages/winget/search', ({ q }) => { const all = [['Mozilla.Firefox', 'Mozilla Firefox', '131.0'], ['VideoLAN.VLC', 'VLC media player', '3.0.21'], ['Notepad++.Notepad++', 'Notepad++', '8.7'], ['Microsoft.VisualStudioCode', 'Visual Studio Code', '1.94'], ['Zoom.Zoom', 'Zoom', '6.2'], ['Greenshot.Greenshot', 'Greenshot', '1.3.290']]; return all.filter(([id, name]) => lc(id + name).includes(lc(q.q))).map(([id, name, version]) => ({ id, name, version, source: 'winget' })) })
on('GET', '/packages', ({ s }) => s.packages.map(p => { const c = pkgCounts(s, p.id); return { ...p, success_count: c.success, failed_count: c.failed, pending_count: c.pending, running_count: c.running, detected_count: c.detected } }))
on('POST', '/packages', ({ s, b }) => { const p = { id: nextId(s, 'pk'), name: String(b.name || '').trim(), type: b.type === 'script' ? 'script' : 'winget', winget_id: b.winget_id || null, install_script: b.install_script || null, post_install_script: b.post_install_script || null, detection_script: b.detection_script || null, version: b.version || null, description: b.description || '', status: 'draft', created_at: now() }; if (!p.name) throw new ApiErr(400, 'Nom requis'); s.packages.push(p); return p })
on('GET', '/packages/:id', ({ s, p }) => { const pk = s.packages.find(x => x.id === p.id) || notFound('Package introuvable'); const c = pkgCounts(s, pk.id); return { ...pk, success_count: c.success, failed_count: c.failed, pending_count: c.pending, running_count: c.running, counts: c, active_jobs: pk.status === 'approved' && s.deployments.some(d => d.package_id === pk.id && d.job_id === 'job-1') ? [{ id: 'job-1', scope: 'all', deployed_by_name: ME.displayName, created_at: pk.approved_at || pk.created_at }] : [], deployments: s.deployments.filter(d => d.package_id === pk.id).sort(byDateDesc('created_at')) } })
on('PATCH', '/packages/:id', ({ s, p, b }) => { const pk = s.packages.find(x => x.id === p.id) || notFound(); Object.assign(pk, b, { status: 'draft' }); return pk })
on('DELETE', '/packages/:id', ({ s, p }) => { s.packages = s.packages.filter(x => x.id !== p.id); s.deployments = s.deployments.filter(d => d.package_id !== p.id); return null })
on('POST', '/packages/:id/approve', ({ s, p }) => { const pk = s.packages.find(x => x.id === p.id) || notFound(); pk.status = 'approved'; pk.approved_at = now(); pk.approved_by_name = ME.displayName; return pk })
on('POST', '/packages/:id/deploy', ({ s, p, b }) => {
  const pk = s.packages.find(x => x.id === p.id) || notFound(); if (pk.status !== 'approved') throw new ApiErr(409, 'Package non approuvé')
  let targets = []
  if (b.scope === 'all' || (!b.device_ids && !b.scope)) targets = s.devices
  else if (b.scope === 'native_group') targets = s.devices.filter(d => (s.groupMembers[b.native_group_id] || []).some(m => m.device_id === d.id))
  else if (b.scope === 'user') targets = s.devices.filter(d => d.assigned_user_id === b.user_entra_id)
  else targets = s.devices.filter(d => (b.device_ids || []).includes(d.id))
  if (!targets.length) throw new ApiErr(400, 'Aucun poste ciblé')
  if (targets.length > 5 && !b.confirmed) return { requires_confirmation: true, count: targets.length }
  let queued = 0
  for (const d of targets) { if (s.deployments.some(x => x.package_id === pk.id && x.device_id === d.id && ['pending', 'running'].includes(x.status))) continue; s.deployments.unshift({ id: nextId(s, 'dp'), package_id: pk.id, package_name: pk.name, device_id: d.id, hostname: d.hostname, assigned_user_name: d.user_name, status: 'pending', exit_code: null, deployed_by_name: ME.displayName, created_at: now(), queued_at: now(), completed_at: null, output: null, job_id: null }); queued++ }
  audit(s, 'package_deployed', pk.name, { devices: queued }); return { queued, count: targets.length }
})
on('POST', '/packages/:id/cancel-all', ({ s, p }) => { let n = 0; s.deployments.forEach(d => { if (d.package_id === p.id && d.status === 'pending') { d.status = 'cancelled'; n++ } }); return { cancelled: n } })
on('POST', '/packages/jobs/:id/cancel', () => ({ ok: true }))
on('GET', '/deployments', ({ s, q }) => { let rows = s.deployments; if (q.status) rows = rows.filter(d => d.status === q.status); if (q.package_id) rows = rows.filter(d => d.package_id === q.package_id); if (q.device_id) rows = rows.filter(d => d.device_id === q.device_id); const off = num(q.offset, 0); return { total: rows.length, rows: rows.slice(off, off + num(q.limit, 100)) } })
on('PATCH', '/deployments/:id/cancel', ({ s, p }) => { const d = s.deployments.find(x => x.id === p.id) || notFound(); if (d.status !== 'pending') throw new ApiErr(409, 'Déploiement déjà démarré'); d.status = 'cancelled'; return d })
on('POST', '/deployments/:id/retry', ({ s, p }) => { const d = s.deployments.find(x => x.id === p.id) || notFound(); d.status = 'pending'; d.exit_code = null; d.output = null; d.completed_at = null; d.queued_at = now(); return d })
on('POST', '/deployments/cancel-bulk', ({ s, b }) => { let n = 0; s.deployments.forEach(d => { if ((b.ids || []).includes(d.id) && d.status === 'pending') { d.status = 'cancelled'; n++ } }); return { cancelled: n } })
on('POST', '/deployments/retry-bulk', ({ s, b }) => { let n = 0; s.deployments.forEach(d => { if ((b.ids || []).includes(d.id)) { d.status = 'pending'; d.completed_at = null; n++ } }); return { retried: n } })

// Stock
on('GET', '/stock', ({ s, q }) => { const search = lc(q.q || q.search); return s.stock.filter(i => !search || lc(i.name).includes(search) || lc(i.category).includes(search)) })
on('POST', '/stock', ({ s, b }) => { const it = { id: nextId(s, 'st'), name: String(b.name || '').trim(), category: b.category || 'Divers', quantity: num(b.quantity, 0), threshold: num(b.threshold ?? b.alert_threshold, 0), alert_threshold: num(b.threshold ?? b.alert_threshold, 0), unit: b.unit || 'pcs', description: b.description || '', last_movement_at: null }; if (!it.name) throw new ApiErr(400, 'Nom requis'); s.stock.unshift(it); return it })
on('GET', '/stock/:id/movements', ({ s, p }) => s.movements[p.id] || [])
on('POST', '/stock/:id/movements', ({ s, p, b }) => { const it = s.stock.find(x => x.id === p.id) || notFound(); const qty = num(b.quantity, 0); if (qty <= 0) throw new ApiErr(400, 'Quantité invalide'); if (b.type === 'out' && it.quantity < qty) throw new ApiErr(400, 'Stock insuffisant'); it.quantity += b.type === 'out' ? -qty : qty; it.last_movement_at = now(); const m = { id: nextId(s, 'mv'), type: b.type === 'out' ? 'out' : 'in', quantity: qty, by_name: ME.displayName, recipient_name: b.recipient_name || null, user_id: b.user_id || null, note: b.note || null, created_at: now() }; (s.movements[p.id] = s.movements[p.id] || []).unshift(m); return { item: it, movement: m } })

// Groupes
const groupRow = (s, g) => ({ ...g, member_count: (s.groupMembers[g.id] || []).length })
on('GET', '/groups/overlaps', ({ s }) => { const out = []; for (let i = 0; i < s.groups.length; i++) for (let j = i + 1; j < s.groups.length; j++) { const a = new Set((s.groupMembers[s.groups[i].id] || []).map(m => m.device_id || m.user_id)); const shared = (s.groupMembers[s.groups[j].id] || []).filter(m => a.has(m.device_id || m.user_id)).length; if (shared) out.push({ a: s.groups[i].id, b: s.groups[j].id, a_name: s.groups[i].name, b_name: s.groups[j].name, shared }) } return out })
on('GET', '/groups/search', ({ s, q }) => s.groups.filter(g => lc(g.name).includes(lc(q.q))).map(g => groupRow(s, g)))
on('GET', '/groups', ({ s }) => s.groups.map(g => groupRow(s, g)))
on('POST', '/groups', ({ s, b }) => { const g = { id: nextId(s, 'g'), name: String(b.name || '').trim(), color: b.color || 'slate', source: 'native', entra_group_id: null, description: b.description || '', created_at: now() }; if (!g.name) throw new ApiErr(400, 'Nom requis'); if (s.groups.some(x => lc(x.name) === lc(g.name))) throw new ApiErr(409, 'Un groupe porte déjà ce nom'); s.groups.push(g); s.groupMembers[g.id] = []; return groupRow(s, g) })
on('POST', '/groups/import-from-entra', () => nope('Import Entra indisponible dans la démo'))
on('GET', '/groups/:id', ({ s, p }) => { const g = s.groups.find(x => x.id === p.id) || notFound('Groupe introuvable'); const m = s.groupMembers[g.id] || []; return { ...groupRow(s, g), devices: m.filter(x => x.device_id).map(x => ({ ...x, status: deviceStatus(s, s.devices.find(d => d.id === x.device_id) || { last_seen: now(), disk_used_pct: 0 }) })), users: m.filter(x => x.user_id), groups: m.filter(x => x.member_group_id).map(x => ({ ...x, name: s.groups.find(g2 => g2.id === x.member_group_id)?.name })) } })
on('PATCH', '/groups/:id', ({ s, p, b }) => { const g = s.groups.find(x => x.id === p.id) || notFound(); Object.assign(g, { name: b.name ?? g.name, color: b.color ?? g.color, description: b.description ?? g.description }); return groupRow(s, g) })
on('DELETE', '/groups/:id', ({ s, p }) => { s.groups = s.groups.filter(x => x.id !== p.id); delete s.groupMembers[p.id]; return null })
on('POST', '/groups/:id/members', ({ s, p, b }) => { const g = s.groups.find(x => x.id === p.id) || notFound(); const list = s.groupMembers[g.id] = s.groupMembers[g.id] || []; let row; if (b.device_id) { const d = s.devices.find(x => x.id === b.device_id) || notFound('Poste introuvable'); if (list.some(x => x.device_id === d.id)) throw new ApiErr(409, 'Ce membre est déjà dans le groupe'); row = { member_id: nextId(s, 'gm'), device_id: d.id, hostname: d.hostname, os: d.os } } else if (b.user_id) { const u = s.users.find(x => x.entra_id === b.user_id) || notFound('Utilisateur introuvable'); if (list.some(x => x.user_id === u.entra_id)) throw new ApiErr(409, 'Ce membre est déjà dans le groupe'); row = { member_id: nextId(s, 'gm'), user_id: u.entra_id, display_name: u.display_name, email: u.email } } else if (b.member_group_id) { if (b.member_group_id === g.id) throw new ApiErr(400, 'Un groupe ne peut pas se contenir lui-même'); const g2 = s.groups.find(x => x.id === b.member_group_id) || notFound('Groupe membre introuvable'); row = { member_id: nextId(s, 'gm'), member_group_id: g2.id, name: g2.name } } else throw new ApiErr(400, 'device_id, user_id ou member_group_id requis'); list.push(row); return { id: row.member_id, group_id: g.id, ...row } })
on('DELETE', '/groups/:id/members/:mid', ({ s, p }) => { const list = s.groupMembers[p.id] || notFound(); s.groupMembers[p.id] = list.filter(m => m.member_id !== p.mid); return null })
on('POST', '/groups/:id/sync-from-entra', () => nope('Synchronisation Entra indisponible dans la démo'))
on('POST', '/groups/:id/detach-entra', ({ s, p }) => { const g = s.groups.find(x => x.id === p.id) || notFound(); g.source = 'native'; g.entra_group_id = null; return groupRow(s, g) })

// Conformité
on('GET', '/compliance', ({ s }) => complianceSummary(s))
on('GET', '/compliance/rules/:id', ({ s, p }) => { const rule = RULES.find(r => r.id === p.id) || notFound('Règle introuvable'); return { rule, devices: s.devices.map(d => { const st = ruleResult(d, rule); return { device_id: d.id, hostname: d.hostname, user_name: d.user_name, status: st, value: st === 'fail' ? { protection_status: 'off' } : {} } }).sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1)) } })

// Accès distant : pas de réseau derrière la démo
on('POST', '/ssh/grant', () => nope('SSH indisponible dans la démo (aucun agent réel derrière ces postes)'))
on('POST', '/console/grant', () => nope('Console indisponible dans la démo (aucun agent réel derrière ces postes)'))

// Ask Opale : interprétation par mots-clés, même forme de réponse que l'API.
on('GET', '/ask/capabilities', () => ({ enabled: true, provider: 'demo', configured: true, resources: [{ name: 'devices' }, { name: 'tickets' }, { name: 'compliance' }] }))
on('POST', '/ask', ({ s, b }) => {
  const q = lc(b.question); if (!q.trim()) throw new ApiErr(400, 'question requise')
  const rows = s.devices.map(d => deviceRow(s, d)); const t = thresholds(s)
  let resource = 'devices', filters = {}, out
  if (/ticket|demande|incident|attente|répon|repon/.test(q)) {
    resource = 'tickets'; out = s.tickets.filter(x => x.status !== 'closed')
    if (/critique|urgent/.test(q)) { filters.priority = 'critical'; out = out.filter(x => x.priority === 'critical') }
    if (/attente|répon|repon/.test(q)) { filters.awaiting_reply = true; out = out.filter(x => x.awaiting_reply) }
    if (/non assign|sans assign|personne/.test(q)) { filters.assigned = 'none'; out = out.filter(x => !x.assigned_to_entra_id) }
    if (/résolu|resolu/.test(q)) { filters.status = 'resolved'; out = s.tickets.filter(x => x.status === 'resolved') }
    out = out.map(x => ({ id: x.id, title: x.title, status: x.status, priority: x.priority, device_hostname: x.hostname, requester_name: x.requester_name }))
  } else if (/bitlocker|defender|pare-feu|firewall|conform|règle|regle/.test(q)) {
    resource = 'compliance'; const rule = /bitlocker/.test(q) ? RULES[0] : /defender/.test(q) ? RULES[1] : /pare-feu|firewall/.test(q) ? RULES[2] : /jour|update/.test(q) ? RULES[3] : null
    if (rule) filters.rule_id = rule.id; filters.status = 'fail'
    out = s.devices.flatMap(d => (rule ? [rule] : RULES).map(r => ({ device_id: d.id, hostname: d.hostname, rule_id: r.id, status: ruleResult(d, r), severity: r.severity }))).filter(r => r.status === 'fail')
  } else {
    out = rows
    if (/disque|disk|plein|espace/.test(q)) { filters.disk_used_pct = `>=${t.warn}`; out = out.filter(d => d.disk_used_pct >= t.warn) }
    if (/hors ligne|offline|injoignable|vu depuis/.test(q)) { filters.status = 'offline'; out = out.filter(d => d.status === 'offline') }
    if (/portable|laptop/.test(q)) { filters.model = 'laptop'; out = out.filter(d => d.hostname.startsWith('LT')) }
    if (/serveur|server|srv/.test(q)) { filters.hostname = 'SRV*'; out = out.filter(d => d.hostname.startsWith('SRV')) }
    if (/sans utilisateur|libre|non assign/.test(q)) { filters.assigned_user = 'none'; out = out.filter(d => !d.assigned_user_id) }
    const dept = s.users.map(u => u.department).find(dep => q.includes(lc(dep))); if (dept) { filters.department = dept; const ids = new Set(s.users.filter(u => u.department === dept).map(u => u.entra_id)); out = out.filter(d => ids.has(d.assigned_user_id)) }
    const ver = q.match(/2\.\d+\.\d+/); if (ver) { filters.agent_version = ver[0]; out = out.filter(d => d.agent_version === ver[0]) }
    out = out.map(d => ({ id: d.id, hostname: d.hostname, model: d.model, user_name: d.user_name, status: d.status, disk_used_pct: d.disk_used_pct, agent_version: d.agent_version }))
  }
  const limit = 50
  audit(s, 'ask_query', b.question.slice(0, 200), { resource, total: out.length })
  return { resource, spec: { resource, filters, sort: null, limit }, total: out.length, count: Math.min(out.length, limit), rows: out.slice(0, limit) }
})

// ── Point d'entrée ───────────────────────────────────────────────────────────

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

export async function handleApi(request, url, state) {
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/'
  const reqParts = path.split('/').filter(Boolean)
  const method = request.method.toUpperCase()
  let body = {}
  if (!['GET', 'HEAD'].includes(method)) {
    const ct = request.headers.get('content-type') || ''
    try {
      if (ct.includes('application/json')) body = await request.json()
      else if (ct.includes('multipart/form-data')) { const fd = await request.formData(); const f = fd.get('file'); body = { filename: f?.name || 'fichier', size: f?.size || 0 } }
    } catch { body = {} }
  }
  const query = Object.fromEntries(url.searchParams.entries())
  for (const r of routes) {
    if (r.method !== method) continue
    const params = match(r.parts, reqParts)
    if (!params) continue
    try {
      const out = await r.fn({ s: state, p: params, q: query, b: body || {} })
      if (out === null) return new Response(null, { status: 204 })
      if (out instanceof Response) return out
      return json(out, method === 'POST' && ['/tickets', '/tickets/tags', '/groups', '/scripts', '/packages', '/onboarding', '/reviews', '/stock', '/settings/tokens', '/settings/ssh-keys', '/alert-snoozes'].includes(path) ? 201 : 200)
    } catch (err) {
      if (err instanceof ApiErr) return json({ error: err.message, ...err.extra }, err.status)
      return json({ error: 'Erreur interne de la démo : ' + (err?.message || err) }, 500)
    }
  }
  return json({ error: `Route inconnue dans la démo : ${method} ${path}` }, 404)
}
