// Vue Journal d'audit
let _offset = 0
let _total  = 0
let _timer  = null

// Catégories : chaque entrée définit soit `in` (actions visibles), soit
// `notIn` (actions masquées). Ordre = ordre du dropdown UI.
const _CATEGORIES = {
  default: {
    label: 'Tout sauf connexion agent',
    notIn: ['agent_ws_connect', 'agent_ws_disconnect', 'agent_checkin'],
  },
  all: {
    label: 'Toutes les actions',
  },
  remote: {
    label: 'Accès distants',
    in: ['agent_console_open', 'agent_console_close', 'agent_console_takeover', 'ssh_open', 'ssh_close'],
  },
  devices: {
    label: 'Gestion des postes',
    in: ['rmm_force_checkin', 'intune_force_sync', 'device_deleted', 'intune_sync'],
  },
  linux: {
    get label() { return t('nav.linux') },
    in: [
      'linux_device_enrolled', 'linux_enroll_serial_conflict', 'linux_enroll_flood',
      'linux_key_serial_mismatch', 'linux_device_approved', 'linux_device_converted',
      'linux_device_reenrolled', 'linux_device_rejected', 'linux_device_revoked',
      'linux_assignment_changed', 'linux_apply_failed', 'linux_apply_recovered',
      'linux_recovery_key_escrowed', 'linux_recovery_key_viewed', 'linux_escrow_backup_confirmed',
      'linux_settings_changed', 'linux_ring_promoted', 'linux_git_synced',
      'linux_preregistrations_imported', 'device_assigned',
    ],
  },
  security: {
    label: 'Tokens & sécurité',
    in: ['token_created', 'token_revoked', 'agent_bootstrap_exchange', 'admin_granted', 'admin_revoked',
         'agent_bootstrap_exchange_refused', 'agent_token_bind_refused', 'agent_token_bound',
         'ssh_host_key_learned', 'ssh_host_key_mismatch', 'ssh_host_key_reset',
         'ip_netbird_cleared', 'linux_enroll_flood', 'linux_key_serial_mismatch'],
  },
  mail: {
    label: 'Pont mail',
    in: ['mail_ingest_abandoned', 'mail_ingest_blocked', 'mail_ingest_second_skipped'],
  },
  agent_conn: {
    label: 'Connexion agent (bruyant)',
    in: ['agent_ws_connect', 'agent_ws_disconnect', 'agent_checkin', 'setup_script'],
  },
}

const _CATEGORY_STORAGE_KEY = 'audit:category'

export async function renderAudit(container) {
  const savedCategory = localStorage.getItem(_CATEGORY_STORAGE_KEY) || 'default'
  const catOptions = Object.entries(_CATEGORIES)
    .map(([key, c]) => `<option value="${key}"${key === savedCategory ? ' selected' : ''}>${esc(c.label)}</option>`)
    .join('')

  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <h1 class="page-title">${t('settings.audit.title')}</h1>
        <span class="topbar-sub" id="audit-count"></span>
      </div>
      <div class="topbar-actions" style="gap:6px">
        <select id="audit-filter-category" class="form-select" style="width:auto;height:32px;font-size:12px;padding:0 8px" onchange="auditOnCategoryChange()">
          ${catOptions}
        </select>
        <select id="audit-filter-level" class="form-select" style="width:auto;height:32px;font-size:12px;padding:0 8px" onchange="auditLoad()">
          <option value="">${t('audit.filter.all_levels')}</option>
          <option value="info">${t('audit.level.info')}</option>
          <option value="warn">${t('audit.level.warn')}</option>
          <option value="error">${t('audit.level.error')}</option>
        </select>
        <button class="btn btn-sm" id="audit-auto-refresh" onclick="auditToggleRefresh()" title="${t('audit.btn.auto_refresh_title')}">
          <i class="ti ti-refresh"></i> ${t('audit.btn.auto_refresh')}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div id="audit-body" class="audit-list">
        <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
      </div>
      <div id="audit-footer" style="display:flex;justify-content:center">
        <button class="btn" id="audit-load-more" style="display:none" onclick="auditLoadMore()">${t('audit.load_more')}</button>
      </div>
    </div>`

  window.auditLoad             = auditLoad
  window.auditLoadMore         = auditLoadMore
  window.auditToggleRefresh    = auditToggleRefresh
  window.auditToggleRow        = auditToggleRow
  window.auditOnCategoryChange = auditOnCategoryChange

  await auditLoad()
}

function auditOnCategoryChange() {
  const cat = document.getElementById('audit-filter-category')?.value || 'default'
  localStorage.setItem(_CATEGORY_STORAGE_KEY, cat)
  auditLoad()
}

async function auditLoad() {
  _offset = 0
  const body = document.getElementById('audit-body')
  if (!body) return
  body.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>`
  await _fetch(false)
}

async function auditLoadMore() {
  _offset += 50
  await _fetch(true)
}

async function _fetch(append) {
  const cat   = document.getElementById('audit-filter-category')?.value || 'default'
  const level = document.getElementById('audit-filter-level')?.value    || null
  const def   = _CATEGORIES[cat] || _CATEGORIES.default
  const params = {
    level,
    limit:  50,
    offset: _offset,
    actions_in:     def.in    ? def.in.join(',')    : null,
    actions_not_in: def.notIn ? def.notIn.join(',') : null,
  }
  try {
    const data = await window.api.getAudit(params)
    _total = data.total
    _renderRows(data.rows, append)
    const countEl = document.getElementById('audit-count')
    if (countEl) countEl.textContent = t('audit.count', { n: Math.min(_offset + data.rows.length, _total), total: _total })
    const moreBtn = document.getElementById('audit-load-more')
    if (moreBtn) moreBtn.style.display = (_offset + data.rows.length < _total) ? '' : 'none'
  } catch {
    const body = document.getElementById('audit-body')
    if (body && !append) body.innerHTML = `<div class="empty-state"><p>${t('audit.error.load')}</p></div>`
  }
}

const _BADGE = {
  settings_changed:          ['b-prog',   'ti-settings'],
  linux_device_enrolled: ['b-done', 'ti-brand-debian'],
  linux_enroll_serial_conflict: ['b-prog', 'ti-alert-triangle'],
  linux_enroll_flood: ['b-closed', 'ti-shield-exclamation'],
  linux_key_serial_mismatch: ['b-closed', 'ti-key-off'],
  linux_device_approved: ['b-done', 'ti-check'],
  linux_device_converted: ['b-done', 'ti-arrows-exchange'],
  linux_device_reenrolled: ['b-done', 'ti-refresh'],
  linux_device_rejected: ['b-closed', 'ti-x'],
  linux_device_revoked: ['b-closed', 'ti-key-off'],
  linux_preregistrations_imported: ['b-done', 'ti-file-import'],
  linux_assignment_changed: ['b-open', 'ti-file-settings'],
  linux_apply_failed: ['b-closed', 'ti-alert-octagon'],
  linux_apply_recovered: ['b-done', 'ti-circle-check'],
  linux_recovery_key_escrowed: ['b-done', 'ti-lock'],
  linux_recovery_key_viewed: ['b-prog', 'ti-eye'],
  linux_escrow_backup_confirmed: ['b-done', 'ti-shield-check'],
  linux_settings_changed: ['b-open', 'ti-settings'],
  linux_ring_promoted: ['b-open', 'ti-arrow-up-circle'],
  linux_git_synced: ['b-open', 'ti-git-branch'],
  laps_viewed: ['b-prog', 'ti-eye'],
  laps_rotated: ['b-done', 'ti-lock'],
  device_assigned: ['b-done', 'ti-user-check'],

  agent_checkin:             ['b-done',   'ti-device-laptop'],
  setup_script:              ['b-open',   'ti-script'],
  intune_sync:               ['b-open',   'ti-cloud-download'],
  intune_force_sync:         ['b-open',   'ti-cloud-download'],
  rmm_force_checkin:         ['b-open',   'ti-refresh'],
  device_deleted:            ['b-closed', 'ti-trash'],
  token_created:             ['b-prog',   'ti-key'],
  token_revoked:             ['b-prog',   'ti-key-off'],
  admin_granted:             ['b-prog',   'ti-shield-check'],
  admin_revoked:             ['b-prog',   'ti-shield-off'],
  agent_bootstrap_exchange:  ['b-done',   'ti-arrows-exchange'],
  agent_bootstrap_exchange_refused: ['b-prog', 'ti-shield-x'],
  agent_token_bind_refused:  ['b-prog',   'ti-lock-x'],
  agent_token_bound:         ['b-done',   'ti-link'],
  ssh_host_key_learned:      ['b-done',   'ti-key'],
  ssh_host_key_mismatch:     ['b-closed', 'ti-alert-octagon'],
  ssh_host_key_reset:        ['b-prog',   'ti-key-off'],
  ip_netbird_cleared:        ['b-prog',   'ti-network-off'],
  agent_ws_connect:          ['b-done',   'ti-broadcast'],
  agent_ws_disconnect:       ['b-closed', 'ti-broadcast-off'],
  agent_console_open:        ['b-prog',   'ti-terminal-2'],
  agent_console_close:       ['b-done',   'ti-terminal-2'],
  agent_console_takeover:    ['b-prog',   'ti-hand-grab'],
  ssh_open:                  ['b-prog',   'ti-terminal'],
  ssh_close:                 ['b-done',   'ti-terminal'],
  mail_ingest_abandoned:     ['b-prog',   'ti-mail-x'],
  mail_ingest_blocked:       ['b-prog',   'ti-mail-pause'],
  mail_ingest_second_skipped: ['b-prog',  'ti-mail-exclamation'],
}

// Libellés FR pour les actions remontées dans les badges. Si absent,
// on tombe sur le nom brut de l'action (forward-compat).
const _ACTION_LABEL = {
  settings_changed:       'Paramètres modifiés',
  get linux_device_enrolled() { return t('dashboard.activity.action.linux_device_enrolled') },
  get linux_enroll_serial_conflict() { return t('dashboard.activity.action.linux_enroll_serial_conflict') },
  get linux_enroll_flood() { return t('dashboard.activity.action.linux_enroll_flood') },
  get linux_key_serial_mismatch() { return t('dashboard.activity.action.linux_key_serial_mismatch') },
  get linux_device_approved() { return t('dashboard.activity.action.linux_device_approved') },
  get linux_device_converted() { return t('dashboard.activity.action.linux_device_converted') },
  get linux_device_reenrolled() { return t('dashboard.activity.action.linux_device_reenrolled') },
  get linux_device_rejected() { return t('dashboard.activity.action.linux_device_rejected') },
  get linux_device_revoked() { return t('dashboard.activity.action.linux_device_revoked') },
  get linux_preregistrations_imported() { return t('dashboard.activity.action.linux_preregistrations_imported') },
  get linux_assignment_changed() { return t('dashboard.activity.action.linux_assignment_changed') },
  get linux_apply_failed() { return t('dashboard.activity.action.linux_apply_failed') },
  get linux_apply_recovered() { return t('dashboard.activity.action.linux_apply_recovered') },
  get linux_recovery_key_escrowed() { return t('dashboard.activity.action.linux_recovery_key_escrowed') },
  get linux_recovery_key_viewed() { return t('dashboard.activity.action.linux_recovery_key_viewed') },
  get linux_escrow_backup_confirmed() { return t('dashboard.activity.action.linux_escrow_backup_confirmed') },
  get linux_settings_changed() { return t('dashboard.activity.action.linux_settings_changed') },
  get linux_ring_promoted() { return t('dashboard.activity.action.linux_ring_promoted') },
  get linux_git_synced() { return t('dashboard.activity.action.linux_git_synced') },
  get laps_viewed() { return t('dashboard.activity.action.laps_viewed') },
  get laps_rotated() { return t('dashboard.activity.action.laps_rotated') },
  get device_assigned() { return t('dashboard.activity.action.device_assigned') },

  agent_console_open:     'console ouverte',
  agent_console_close:    'console fermée',
  agent_console_takeover: 'console reprise',
  ssh_open:               'ssh ouvert',
  ssh_close:              'ssh fermé',
  agent_ws_connect:       'agent connecté',
  agent_ws_disconnect:    'agent déconnecté',
  agent_checkin:          'checkin agent',
  rmm_force_checkin:      'forçage checkin',
  intune_force_sync:      'forçage sync intune',
  device_deleted:         'poste supprimé',
  agent_bootstrap_exchange_refused: 'échange bootstrap refusé',
  agent_token_bind_refused:         'liaison token refusée',
  agent_token_bound:                'token lié au poste',
  ssh_host_key_learned:             'clé d\'hôte SSH apprise',
  ssh_host_key_mismatch:            'clé d\'hôte SSH inattendue',
  ssh_host_key_reset:               'clé d\'hôte SSH réinitialisée',
  ip_netbird_cleared:               'IP Netbird invalide purgée',
  mail_ingest_abandoned:            'mail abandonné (ingestion)',
  mail_ingest_blocked:              'boîte mail bloquée',
  mail_ingest_second_skipped:       'mails sautés (même seconde)',
}

function _formatDuration(s) {
  if (s == null || !Number.isFinite(s)) return ''
  if (s < 60)    return `${s} s`
  if (s < 3600)  return `${Math.floor(s / 60)} min ${s % 60} s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h} h ${m} min`
}

// Rendu compact "motif: <category> — <note tronquée>" pour la ligne de
// résumé. Note tronquée à ~60 chars pour ne pas casser le layout — la
// version complète reste visible dans le panneau d'expansion (details JSON).
function _reasonShort(reason) {
  if (!reason || !reason.category) return ''
  const note = (reason.note || '').slice(0, 60)
  const ellipsis = (reason.note || '').length > 60 ? '…' : ''
  return note ? `motif: ${reason.category} — ${note}${ellipsis}` : `motif: ${reason.category}`
}

// Horodatage ISO → « AAAA-MM-JJ HH:MM:SS UTC » (résumés du pont mail).
function _utc(iso) {
  return String(iso).replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC')
}

function _truncate(s, n) {
  const str = s ? String(s) : ''
  return str.length > n ? str.slice(0, n) + '…' : str
}

function _summary(action, details) {
  if (!details) return ''
  if (action === 'settings_changed') return Object.keys(details.changed || {}).join(', ')
  if (action === 'device_assigned') return [details.hostname, details.assigned_user_id || t('poste.facts.unassigned')].filter(Boolean).join(' · ')
  if (action === 'linux_preregistrations_imported') return t('linux.queue.bulk_result', { ok: details.ok ?? details.imported ?? 0, skipped: details.skipped ?? 0 })
  if (action === 'linux_enroll_flood') return t('linux.queue.pending', { n: details.pending ?? details.count ?? '—' })
  if (action === 'linux_key_serial_mismatch') return [details.serial_claimed, details.serial, details.fingerprint].filter(Boolean).join(' · ')
  if (['linux_device_enrolled', 'linux_enroll_serial_conflict', 'linux_device_approved', 'linux_device_converted', 'linux_device_reenrolled', 'linux_device_rejected', 'linux_device_revoked'].includes(action)) {
    return [details.hostname, details.serial_claimed || details.serial, details.profile, details.ring, details.reason].filter(Boolean).join(' · ')
  }
  // Transitions d'application, escrow, réglages et rings (PR 6). Les motifs
  // des révélations suivent le format des sessions distantes.
  const sha = s => (s ? String(s).slice(0, 7) : '')
  const assignment = a => (a ? [a.profile, a.ring].filter(Boolean).join('/') : '')
  if (action === 'linux_assignment_changed')      return [details.hostname, `${assignment(details.before) || '—'} → ${assignment(details.after) || '—'}`].filter(Boolean).join(' · ')
  if (action === 'linux_apply_failed')            return [details.hostname, sha(details.revision), _truncate(details.error_summary, 120)].filter(Boolean).join(' · ')
  if (action === 'linux_apply_recovered')         return [details.hostname, sha(details.revision)].filter(Boolean).join(' · ')
  if (action === 'linux_recovery_key_escrowed')   return [details.label, sha(details.key_id)].filter(Boolean).join(' · ')
  if (action === 'linux_recovery_key_viewed')     return [_reasonShort(details.reason), details.label, details.outcome].filter(Boolean).join(' · ')
  if (action === 'linux_escrow_backup_confirmed') return sha(details.key_id)
  if (action === 'linux_settings_changed')        return Object.keys(details.changes || {}).join(', ')
  if (action === 'linux_ring_promoted')           return [`${sha(details.before) || '—'} → ${sha(details.after) || '—'}`, details.allow_rollback ? t('linux.audit.rollback') : ''].filter(Boolean).join(' · ')
  if (action === 'laps_viewed')                   return [_reasonShort(details.reason), details.outcome].filter(Boolean).join(' · ')
  if (action === 'laps_rotated')                  return details.username || ''
  if (action === 'intune_sync')   return t('audit.summary.intune', { ok: details.upserted ?? 0, errors: details.errors ?? 0 })
  if (action === 'agent_checkin') {
    let s = t('audit.summary.agent_checkin', { disks: details.disks ?? 0 })
    if (details.ip_netbird) s += ' · ' + details.ip_netbird
    if (details.new)        s += ' · ' + t('audit.summary.new')
    return s
  }
  if (action === 'setup_script')  return details.level || ''
  if (action === 'agent_console_open')     return [_reasonShort(details.reason), details.shell, details.session_id?.slice(0, 8)].filter(Boolean).join(' · ')
  if (action === 'agent_console_close')    return [_formatDuration(details.duration_seconds), details.reason].filter(Boolean).join(' · ')
  if (action === 'agent_console_takeover') return details.taken_session ? `prise de la session ${details.taken_session.slice(0, 8)}` : ''
  if (action === 'ssh_open')               return [_reasonShort(details.reason), details.host, details.ip].filter(Boolean).join(' · ')
  if (action === 'ssh_close')              return _formatDuration(details.duration_seconds)
  if (action === 'agent_ws_disconnect')    return [details.reason, _formatDuration(details.duration_seconds)].filter(Boolean).join(' · ')
  if (action === 'agent_bootstrap_exchange_refused') return [details.reason, details.bootstrap_label, details.serial].filter(Boolean).join(' · ')
  if (action === 'agent_token_bind_refused')         return [details.reason, details.token_label, details.serial].filter(Boolean).join(' · ')
  if (action === 'agent_token_bound')                return [details.token_label, details.serial].filter(Boolean).join(' · ')
  if (action === 'ssh_host_key_learned')             return [details.hostname, details.fingerprint].filter(Boolean).join(' · ')
  if (action === 'ssh_host_key_mismatch')            return [details.hostname, `attendue ${details.expected_fingerprint || '?'}`, `présentée ${details.presented_fingerprint || '?'}`].join(' · ')
  if (action === 'ssh_host_key_reset')               return details.hostname || ''
  if (action === 'ip_netbird_cleared')               return [details.hostname, details.ip_netbird].filter(Boolean).join(' · ')
  // Pont mail (cf. email-bridge/lib/poll-cursor.js) : mail abandonné, ou
  // boîte bloquée (panne systémique ; reprise SQL dans `details.log`, affiché
  // dans le panneau dépliable). Champs issus du mail et d'une erreur DB : le
  // résumé est échappé au rendu.
  if (action === 'mail_ingest_abandoned') {
    const date = details.date ? `mail du ${_utc(details.date)}` : ''
    return [date, details.internet_message_id, _truncate(details.error, 160)].filter(Boolean).join(' · ')
  }
  if (action === 'mail_ingest_blocked') {
    const since = details.since ? `bloquée depuis ${_utc(details.since)}` : ''
    const attempts = details.attempts ? `${details.attempts} tentatives` : ''
    return [since, attempts, details.internet_message_id, _truncate(details.error, 120)].filter(Boolean).join(' · ')
  }
  if (action === 'mail_ingest_second_skipped') {
    const lost = `${details.not_ingested_exact ? '' : '≥ '}${details.not_ingested ?? '?'} mails non ingérés`
    return [lost, details.cursor ? `seconde ${_utc(details.cursor)}` : ''].filter(Boolean).join(' · ')
  }
  return ''
}

function _renderRows(rows, append) {
  const body = document.getElementById('audit-body')
  if (!body) return
  if (!rows.length && !append) {
    body.innerHTML = `<div class="empty-state"><p>${t('audit.empty')}</p></div>`
    return
  }
  const html = rows.map((r, idx) => {
    let [badgeClass, icon] = _BADGE[r.action] || ['b-closed', 'ti-dots']
    if (r.action === 'intune_sync' && r.details?.errors > 0) badgeClass = 'b-prog'
    const level     = r.details?.level
    const levelColor = level === 'error' ? 'var(--red)' : level === 'warn' ? 'var(--amber)' : null
    const summary   = _summary(r.action, r.details)
    const hasLog    = !!r.details?.log
    const rowId     = `ar-${_offset}-${idx}`
    // Lien préfère entra_id (toujours présent dans users_cache) à email
    // (souvent vide tant que la sync Entra n'a pas tourné).
    const byUserId = r.by_user_entra_id || r.by_user_email
    const byUser = byUserId
      ? `<a href="#/users/${esc(byUserId)}" class="nav-link" onclick="event.stopPropagation()">${esc(r.by_user || '—')}</a>`
      : `<span style="color:var(--text-secondary)">${esc(r.by_user || '—')}</span>`
    let targetHtml = ''
    if (r.target) {
      // Pour agent_checkin, target = device_id (UUID) — on affiche le
      // hostname résolu côté API plutôt que l'UUID brut. Pour les autres
      // actions, target = hostname directement.
      const displayName = r.device_hostname || r.target
      const hostnameEl = r.device_id
        ? `<a href="#/postes/${esc(r.device_id)}" class="nav-link" onclick="event.stopPropagation()">${esc(displayName)}</a>`
        : `<span>${esc(displayName)}</span>`
      const assignedUserId = r.device_user_entra_id || r.device_user_email
      const assignedEl = assignedUserId && r.device_user_name
        ? ` <a href="#/users/${esc(assignedUserId)}" class="nav-link" style="color:var(--text-tertiary)" onclick="event.stopPropagation()">(${esc(r.device_user_name)})</a>`
        : r.device_user_name
          ? ` <span style="color:var(--text-tertiary)">(${esc(r.device_user_name)})</span>`
          : ''
      targetHtml = ` <span style="color:var(--text-tertiary)">→</span> ${hostnameEl}${assignedEl}`
    }
    return `
      <div class="audit-row">
        <div class="audit-row-main" onclick="auditToggleRow('${rowId}')">
          <span class="badge ${badgeClass}" style="min-width:110px;text-align:center"><i class="ti ${icon}"></i> ${esc(_ACTION_LABEL[r.action] || r.action)}</span>
          ${level && levelColor ? `<span style="font-size:10px;font-weight:600;color:${levelColor}">${level.toUpperCase()}</span>` : ''}
          <span class="audit-row-text">
            ${byUser}
            ${targetHtml}
            ${summary ? ` <span style="color:var(--text-tertiary)">· ${esc(summary)}</span>` : ''}
          </span>
          <span class="audit-row-time">${formatRelative(r.created_at)}</span>
          ${hasLog ? `<i class="ti ti-chevron-right audit-chevron" id="${rowId}-chevron"></i>` : ''}
        </div>
        ${hasLog ? `<div class="audit-row-detail hidden" id="${rowId}-detail">
          <pre>${esc(r.details.log)}</pre>
        </div>` : ''}
      </div>`
  }).join('')
  if (append) body.insertAdjacentHTML('beforeend', html)
  else        body.innerHTML = html
}

function auditToggleRow(rowId) {
  const detail  = document.getElementById(`${rowId}-detail`)
  const chevron = document.getElementById(`${rowId}-chevron`)
  if (!detail) return
  const isOpen = !detail.classList.contains('hidden')
  detail.classList.toggle('hidden', isOpen)
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)'
}

function auditToggleRefresh() {
  const btn = document.getElementById('audit-auto-refresh')
  if (_timer) {
    clearInterval(_timer)
    _timer = null
    if (btn) { btn.classList.remove('btn-primary'); btn.title = t('audit.btn.auto_refresh_title') }
  } else {
    _timer = setInterval(() => {
      if (!document.getElementById('audit-body')) { clearInterval(_timer); _timer = null; return }
      auditLoad()
    }, 30_000)
    if (btn) { btn.classList.add('btn-primary'); btn.title = t('audit.btn.auto_refresh_active') }
    auditLoad()
  }
}
