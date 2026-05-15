let _tk = null
let _allTags = []  // cache local des tags du référentiel

const M_TK_TAG_PALETTE = {
  slate:  '#475569', blue:   '#2563eb', green:  '#059669', amber:  '#d97706',
  red:    '#dc2626', violet: '#7c3aed', pink:   '#db2777', teal:   '#0d9488',
}
const M_TK_TAG_COLOR_KEYS = Object.keys(M_TK_TAG_PALETTE)

function shortName(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] || ''
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.'
}

export async function renderTicket(el, id) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1 id="m-tk-title" style="flex:1;margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">…</h1>
      <span id="m-tk-badge"></span>
      <button class="m-icon-btn" id="m-tk-menu-btn" onclick="mTicketMenu()" title="Actions">
        <i class="ti ti-dots-vertical"></i>
      </button>
    </div>
    <div id="m-tk-thread" class="m-scroll" style="flex:1">
      <div style="display:flex;justify-content:center;padding:40px"><div class="m-spinner"></div></div>
    </div>
    <div id="m-tk-reply-bar" class="m-reply-bar" style="display:none">
      <textarea class="m-reply-input" id="m-reply-txt" rows="1" placeholder="Répondre…"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
      <button class="m-send-btn" onclick="mSendReply()">
        <i class="ti ti-send"></i>
      </button>
    </div>`

  try {
    _tk = await window.api.getTicket(id)
    renderTicketBody()
  } catch (err) {
    document.getElementById('m-tk-thread').innerHTML =
      `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message)}</div>`
  }

  window.mSendReply       = mSendReply
  window.mTicketMenu      = mTicketMenu
  window.mCloseSheetThen  = mCloseSheetThen   // requis par les onclick="mCloseSheetThen(...)" du menu
  window.mChangePriority  = mChangePriority
  window.mEditTitle       = mEditTitle
  window.mOpenTags        = mOpenTags
  window.mToggleTag       = mToggleTag
  window.mPickTagColor    = mPickTagColor
  window.mCreateTag       = mCreateTag
  window.mAssignSelf      = mAssignSelf
  window.mUnassign        = mUnassign
}

function renderTicketBody() {
  const tk = _tk

  document.getElementById('m-tk-title').textContent = tk.title

  const pillCls = tk.status === 'resolved' ? 'm-pill-on' : tk.status === 'in_progress' ? 'm-pill-warn' : 'm-pill-off'
  const pillTxt = statusLabel(tk.status)
  document.getElementById('m-tk-badge').outerHTML =
    `<span id="m-tk-badge" class="m-pill ${pillCls}">${pillTxt}</span>`

  const resolved = tk.status === 'resolved'

  const thread = document.getElementById('m-tk-thread')
  thread.innerHTML = `
    <!-- Méta -->
    <div style="padding:12px 16px;border-bottom:0.5px solid var(--border);display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${tk.hostname ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px"><i class="ti ti-device-laptop" style="font-size:11px"></i> ${esc(tk.hostname)}</span>` : ''}
        <span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;color:${prioColor(tk.priority)}">${prioLabel(tk.priority)}</span>
        ${tk.is_auto ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;color:var(--blue)">Auto</span>` : ''}
        ${tk.requester_name ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px"><i class="ti ti-user" style="font-size:11px;opacity:0.7"></i> ${esc(shortName(tk.requester_name))}</span>` : ''}
        ${tk.assigned_to_name ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px"><i class="ti ti-user-check" style="font-size:11px;opacity:0.7"></i> ${esc(shortName(tk.assigned_to_name))}</span>` : ''}
      </div>
      ${(tk.tags || []).length ? `
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        ${tk.tags.map(g => `<span style="font-size:11px;background:${M_TK_TAG_PALETTE[g.color] || M_TK_TAG_PALETTE.slate};color:#fff;padding:1px 8px;border-radius:8px">${esc(g.name)}</span>`).join('')}
      </div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;color:var(--text-tertiary)">${formatRelative(tk.created_at)}${tk.created_by_name ? ' · ' + esc(tk.created_by_name) : ''}</span>
        ${!resolved
          ? `<div style="display:flex;gap:6px">
              ${tk.status === 'open'        ? `<button class="m-pill m-pill-warn" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('in_progress')">En cours</button>` : ''}
              ${tk.status === 'in_progress' ? `<button class="m-pill m-pill-off"  style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('open')">Ouvrir</button>` : ''}
              <button class="m-pill m-pill-on" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('resolved')">Résoudre</button>
             </div>`
          : `<button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('open')">Rouvrir</button>`
        }
      </div>
    </div>

    <!-- Description -->
    ${tk.description ? `
    <div style="padding:12px 16px;background:var(--bg-secondary);border-bottom:0.5px solid var(--border)">
      <div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap">${esc(tk.description)}</div>
    </div>` : ''}

    <!-- Messages -->
    <div id="m-tk-msgs" style="display:flex;flex-direction:column;gap:0;padding-bottom:8px">
      ${(tk.messages || []).map(m => renderMsg(m)).join('')}
    </div>
  `

  window.mSetStatus = mSetStatus

  // Barre de réponse
  const replyBar = document.getElementById('m-tk-reply-bar')
  if (replyBar) replyBar.style.display = resolved ? 'none' : 'flex'

  // Scroll en bas
  thread.scrollTop = thread.scrollHeight
}

function renderMsg(m) {
  if (m.type === 'system' || m.type === 'resolution') {
    return `
    <div style="text-align:center;padding:8px 16px">
      <span style="font-size:11px;color:var(--text-tertiary);background:var(--bg-secondary);padding:3px 10px;border-radius:20px">
        ${esc(m.content)} · ${formatRelative(m.created_at)}
      </span>
    </div>`
  }
  const av   = (m.author || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  const isMe = m.author === window.appState?.user?.displayName
  return `
  <div class="m-msg ${isMe ? 'm-msg-me' : ''}">
    ${!isMe ? `<div class="m-av" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${esc(av)}</div>` : ''}
    <div class="m-msg-bubble ${isMe ? 'm-msg-bubble-me' : ''}">
      ${!isMe ? `<div class="m-msg-author">${esc(m.author)}</div>` : ''}
      <div class="m-msg-content">${esc(m.content)}</div>
      <div class="m-msg-time">${formatRelative(m.created_at)}</div>
    </div>
  </div>`
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function mSendReply() {
  const input   = document.getElementById('m-reply-txt')
  const content = input?.value?.trim()
  if (!content) return
  input.value = ''
  input.style.height = 'auto'
  try {
    await window.api.addMessage(_tk.id, { content })
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
  } catch { window.showToast('Erreur', 'error') }
}

async function mSetStatus(status) {
  try {
    await window.api.updateTicket(_tk.id, { status })
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    const labels = { resolved: 'Ticket résolu ✓', open: 'Ticket rouvert', in_progress: 'En cours' }
    window.showToast(labels[status] || 'Mis à jour', status === 'resolved' ? 'success' : 'info')
  } catch { window.showToast('Erreur', 'error') }
}

function mTicketMenu() {
  const tk = _tk
  const me = window.appState?.user
  const isAssignedToMe = me?.entraId && tk.assigned_to_entra_id === me.entraId

  window.mShowSheet(`
    <div class="m-sheet-title">${esc(tk.title)}</div>
    <div style="display:flex;flex-direction:column;gap:2px;padding:0 4px">

      ${tk.status === 'open' ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('in_progress'))">
        <i class="ti ti-player-play" style="color:var(--amber)"></i> ${t('mobile.ticket.menu.set_in_progress')}
      </button>` : ''}
      ${tk.status === 'in_progress' ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('open'))">
        <i class="ti ti-player-stop" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.set_open')}
      </button>` : ''}
      ${tk.status !== 'resolved' ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('resolved'))">
        <i class="ti ti-check" style="color:var(--green)"></i> ${t('mobile.ticket.menu.resolve')}
      </button>` : `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('open'))">
        <i class="ti ti-refresh" style="color:var(--blue)"></i> ${t('mobile.ticket.menu.reopen')}
      </button>`}

      <div style="height:1px;background:var(--border);margin:6px 0"></div>

      <button class="m-menu-row" onclick="mChangePriority()">
        <i class="ti ti-flag" style="color:${prioColor(tk.priority)}"></i> ${t('mobile.ticket.menu.priority')} — ${prioLabel(tk.priority)}
      </button>

      <button class="m-menu-row" onclick="mEditTitle()">
        <i class="ti ti-pencil" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.edit_title')}
      </button>

      <button class="m-menu-row" onclick="mOpenTags()">
        <i class="ti ti-tag" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.tags')}
        ${(tk.tags || []).length ? `<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">${tk.tags.length}</span>` : ''}
      </button>

      ${me?.entraId ? (isAssignedToMe ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(mUnassign)">
        <i class="ti ti-user-off" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.unassign')}
      </button>` : `
      <button class="m-menu-row" onclick="mCloseSheetThen(mAssignSelf)">
        <i class="ti ti-user-check" style="color:var(--blue)"></i> ${t('mobile.ticket.menu.assign_self')}
      </button>`) : ''}

    </div>`)
}

// ── Tags : assign / remove / create ──────────────────────────────────────────

async function mOpenTags() {
  // Charger le référentiel si pas déjà fait
  if (!_allTags.length) {
    try { _allTags = await window.api.getTags() }
    catch { window.showToast(t('mobile.ticket.tags.load_error'), 'error'); return }
  }
  renderTagsSheet()
}

function renderTagsSheet() {
  const currentIds = new Set((_tk.tags || []).map(g => g.id))
  const sorted = [..._allTags].sort((a, b) => a.name.localeCompare(b.name))

  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.ticket.tags.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:10px">
      ${sorted.length ? `
      <div style="display:flex;flex-direction:column;gap:4px;max-height:50vh;overflow-y:auto">
        ${sorted.map(g => {
          const assigned = currentIds.has(g.id)
          const color = M_TK_TAG_PALETTE[g.color] || M_TK_TAG_PALETTE.slate
          return `
          <button class="m-menu-row" onclick="mToggleTag('${esc(g.id)}', ${assigned ? 'true' : 'false'})">
            <span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${color};margin-right:4px"></span>
            <span style="flex:1;text-align:left">${esc(g.name)}</span>
            ${assigned ? `<i class="ti ti-check" style="color:var(--blue);font-size:18px"></i>` : ''}
          </button>`
        }).join('')}
      </div>` : `
      <div style="font-size:13px;color:var(--text-tertiary);padding:8px 0;text-align:center">${t('mobile.ticket.tags.empty')}</div>`}

      <div style="height:1px;background:var(--border);margin:4px 0"></div>

      <div style="font-size:12px;color:var(--text-secondary)">${t('mobile.ticket.tags.create')}</div>
      <input class="m-input" id="m-tk-newtag-name" placeholder="${t('mobile.ticket.tags.name_placeholder')}" autocomplete="off">
      <div>
        <div class="m-label" style="margin-bottom:6px">${t('mobile.ticket.tags.color')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap" id="m-tk-newtag-colors">
          ${M_TK_TAG_COLOR_KEYS.map((k, i) => `
            <button data-color="${k}" class="m-tk-color-swatch ${i === 0 ? 'active' : ''}"
              onclick="mPickTagColor('${k}', this)"
              style="width:30px;height:30px;border-radius:8px;background:${M_TK_TAG_PALETTE[k]};border:2px solid ${i === 0 ? '#fff' : 'transparent'};cursor:pointer"></button>
          `).join('')}
        </div>
      </div>
      <button class="m-btn-primary" onclick="mCreateTag()">
        <i class="ti ti-plus"></i> ${t('mobile.ticket.tags.create_btn')}
      </button>
    </div>`)
}

function mPickTagColor(color, btn) {
  btn.parentElement.querySelectorAll('.m-tk-color-swatch').forEach(b => {
    b.style.border = '2px solid transparent'
    b.classList.remove('active')
  })
  btn.style.border = '2px solid #fff'
  btn.classList.add('active')
  btn.dataset.selected = 'true'
}

async function mToggleTag(tagId, isAssigned) {
  try {
    if (isAssigned) {
      await window.api.removeTicketTag(_tk.id, tagId)
    } else {
      await window.api.addTicketTag(_tk.id, tagId)
    }
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    renderTagsSheet()  // re-render la sheet pour refléter le nouveau state
  } catch {
    window.showToast(t('mobile.ticket.tags.toast.error'), 'error')
  }
}

async function mCreateTag() {
  const name = document.getElementById('m-tk-newtag-name')?.value?.trim()
  if (!name) {
    window.showToast(t('mobile.ticket.tags.name_required'), 'error')
    return
  }
  const activeSwatch = document.querySelector('#m-tk-newtag-colors .m-tk-color-swatch.active')
  const color = activeSwatch?.dataset?.color || 'slate'
  try {
    const newTag = await window.api.createTag({ name, color })
    _allTags.push(newTag)
    await window.api.addTicketTag(_tk.id, newTag.id)
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    renderTagsSheet()  // re-render avec le nouveau tag
    window.showToast(t('mobile.ticket.tags.toast.created'), 'success')
  } catch (err) {
    window.showToast(err.message || t('mobile.ticket.tags.toast.error'), 'error')
  }
}

// ── Assignation ──────────────────────────────────────────────────────────────

async function mAssignSelf() {
  const me = window.appState?.user
  if (!me?.entraId) return
  try {
    await window.api.updateTicket(_tk.id, {
      assigned_to_entra_id: me.entraId,
      assigned_to_name:     me.displayName,
    })
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    window.showToast(t('mobile.ticket.assign.toast.self'), 'success')
  } catch {
    window.showToast(t('mobile.ticket.assign.toast.error'), 'error')
  }
}

async function mUnassign() {
  try {
    await window.api.updateTicket(_tk.id, {
      assigned_to_entra_id: null,
      assigned_to_name:     null,
    })
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    window.showToast(t('mobile.ticket.assign.toast.unassigned'), 'info')
  } catch {
    window.showToast(t('mobile.ticket.assign.toast.error'), 'error')
  }
}

function mCloseSheetThen(fn) {
  window.mCloseSheet()
  setTimeout(fn, 200)
}

function mChangePriority() {
  window.mShowSheet(`
    <div class="m-sheet-title">Changer la priorité</div>
    <div style="display:flex;flex-direction:column;gap:2px;padding:0 4px">
      ${[['low','Basse','var(--text-tertiary)'],['normal','Normale','var(--text-secondary)'],['high','Haute','var(--amber)'],['critical','Critique','var(--red)']].map(([val, lbl, col]) => `
      <button class="m-menu-row ${_tk.priority === val ? 'active' : ''}" onclick="mSetPriority('${val}')">
        <i class="ti ti-flag" style="color:${col}"></i> ${lbl}
        ${_tk.priority === val ? '<i class="ti ti-check" style="margin-left:auto;color:var(--blue)"></i>' : ''}
      </button>`).join('')}
    </div>`)
}

async function mSetPriority(priority) {
  window.mCloseSheet()
  try {
    await window.api.updateTicket(_tk.id, { priority })
    _tk = await window.api.getTicket(_tk.id)
    renderTicketBody()
    window.showToast('Priorité mise à jour', 'success')
  } catch { window.showToast('Erreur', 'error') }
}

function mEditTitle() {
  window.mShowSheet(`
    <div class="m-sheet-title">Modifier le titre</div>
    <div style="padding:0 4px;display:flex;flex-direction:column;gap:12px">
      <input class="m-input" id="m-edit-title" value="${esc(_tk.title)}" autocomplete="off">
      <button class="m-btn-primary" onclick="mSaveTitle()">Enregistrer</button>
    </div>`)
  setTimeout(() => document.getElementById('m-edit-title')?.focus(), 100)
  window.mSaveTitle = async () => {
    const title = document.getElementById('m-edit-title')?.value?.trim()
    if (!title || title === _tk.title) { window.mCloseSheet(); return }
    try {
      await window.api.updateTicket(_tk.id, { title })
      _tk = await window.api.getTicket(_tk.id)
      window.mCloseSheet()
      renderTicketBody()
      window.showToast('Titre modifié', 'success')
    } catch { window.showToast('Erreur', 'error') }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusLabel(s) {
  return s === 'resolved' ? 'Résolu' : s === 'in_progress' ? 'En cours' : s === 'proposed' ? 'Proposé' : 'Ouvert'
}
function prioLabel(p) {
  return p === 'low' ? 'Basse' : p === 'normal' ? 'Normale' : p === 'high' ? 'Haute' : p === 'critical' ? 'Critique' : (p || '—')
}
function prioColor(p) {
  return p === 'critical' ? 'var(--red)' : p === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
}
