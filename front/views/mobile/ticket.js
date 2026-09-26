let _tk = null
let _allTags = []  // cache local des tags du référentiel
let _aiBusy = false

// jsArg() fourni globalement par mobile-app.js (window.jsArg) — pour passer
// une string user-controlled en argument d'un onclick="fn('…')" inline.
const mJsArg = window.jsArg

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

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

export async function renderTicket(el, id) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="window.location.hash='#/tickets'">
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
      <textarea class="m-reply-input" id="m-reply-txt" rows="1" placeholder="${t('mobile.ticket.reply_placeholder')}"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
      <button class="m-send-btn" id="m-ai-btn" style="background:rgba(124,58,237,0.15);color:#7c3aed"
        onclick="mAiSuggest()" title="${esc(t('mobile.ticket.ai.suggest'))}">
        <i class="ti ti-sparkles"></i>
      </button>
      <button class="m-send-btn" onclick="mSendReply(this)">
        <i class="ti ti-send"></i>
      </button>
    </div>`

  try {
    _tk = await window.api.getTicket(id)
    renderTicketBody()
  } catch (err) {
    document.getElementById('m-tk-thread').innerHTML = mErrorBox(err.message, () => renderTicket(el, id))
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
  window.mAiSuggest       = mAiSuggest
  window.mUseSuggestion   = mUseSuggestion
  window.mDeleteSuggestion = mDeleteSuggestion
  window.mSendMsgByMail   = mSendMsgByMail
  window.mRetrySend       = mRetrySend
  window.mOpenAssignee    = mOpenAssignee
  window.mOpenPeople      = mOpenPeople
  window.mOpenDevices     = mOpenDevices
  window.mOpenAttachments = mOpenAttachments
}

function renderTicketBody() {
  const tk = _tk

  document.getElementById('m-tk-title').textContent = tk.title

  const pillCls = tk.status === 'resolved' ? 'm-pill-on' : tk.status === 'in_progress' ? 'm-pill-warn' : 'm-pill-off'
  const pillTxt = statusLabel(tk.status)
  document.getElementById('m-tk-badge').outerHTML =
    `<span id="m-tk-badge" class="m-pill ${pillCls}">${pillTxt}</span>`

  const resolved = tk.status === 'resolved'

  const devCount = (tk.related_devices || []).length
  const attCount = (tk.attachments || []).length
  const peopleCount = (tk.related_users || []).length

  const thread = document.getElementById('m-tk-thread')
  thread.innerHTML = `
    <!-- Méta -->
    <div style="padding:12px 16px;border-bottom:0.5px solid var(--border);display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${tk.hostname ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px"><i class="ti ti-device-laptop" style="font-size:11px"></i> ${esc(tk.hostname)}${devCount > 1 ? ` +${devCount - 1}` : ''}</span>` : ''}
        <span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;color:${prioColor(tk.priority)}">${prioLabel(tk.priority)}</span>
        ${tk.is_auto ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;color:var(--blue)">Auto</span>` : ''}
        <span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;cursor:pointer" onclick="mOpenPeople()">
          <i class="ti ti-user" style="font-size:11px;opacity:0.7"></i> ${tk.requester_name ? esc(shortName(tk.requester_name)) : t('mobile.ticket.people.no_requester')}${peopleCount > 1 ? ` +${peopleCount - 1}` : ''}
        </span>
        <span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;cursor:pointer" onclick="mOpenAssignee()">
          <i class="ti ti-user-check" style="font-size:11px;opacity:0.7"></i> ${tk.assigned_to_name ? esc(shortName(tk.assigned_to_name)) : t('mobile.ticket.assignee.none')}
        </span>
        ${attCount ? `<span style="font-size:12px;background:var(--bg-secondary);padding:2px 8px;border-radius:4px;cursor:pointer" onclick="mOpenAttachments()"><i class="ti ti-paperclip" style="font-size:11px;opacity:0.7"></i> ${attCount}</span>` : ''}
      </div>
      ${(tk.tags || []).length ? `
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        ${tk.tags.map(g => `<span style="font-size:11px;background:${M_TK_TAG_PALETTE[g.color] || M_TK_TAG_PALETTE.slate};color:#fff;padding:1px 8px;border-radius:8px">${esc(g.name)}</span>`).join('')}
      </div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;color:var(--text-tertiary)">${formatRelative(tk.created_at)}${tk.created_by_name ? ' · ' + esc(tk.created_by_name) : ''}</span>
        ${!resolved
          ? `<div style="display:flex;gap:6px">
              ${tk.status === 'open'        ? `<button class="m-pill m-pill-warn" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('in_progress',this)">En cours</button>` : ''}
              ${tk.status === 'in_progress' ? `<button class="m-pill m-pill-off"  style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('open',this)">Ouvrir</button>` : ''}
              <button class="m-pill m-pill-on" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('resolved',this)">Résoudre</button>
             </div>`
          : `<button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mSetStatus('open',this)">Rouvrir</button>`
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

  // Brouillon IA : bulle distincte (jamais envoyée par mail). Actions :
  // reprendre dans le composer pour éditer/envoyer, ou supprimer.
  if (m.type === 'ai_suggestion') {
    return `
    <div class="m-msg">
      <div class="m-av" style="width:28px;height:28px;font-size:11px;flex-shrink:0;background:rgba(124,58,237,0.15);color:#7c3aed">
        <i class="ti ti-sparkles" style="font-size:14px"></i>
      </div>
      <div class="m-msg-bubble" style="background:rgba(124,58,237,0.08);border:0.5px solid rgba(124,58,237,0.25)">
        <div class="m-msg-author" style="color:#7c3aed">${esc(m.author)} · ${t('mobile.ticket.ai.badge')}</div>
        <div class="m-msg-content">${esc(m.content)}</div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" data-content="${esc(m.content)}" onclick="mUseSuggestion(this)">
            <i class="ti ti-corner-up-left" style="font-size:11px"></i> ${t('mobile.ticket.ai.use')}
          </button>
          <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px;color:var(--text-tertiary)" onclick="mDeleteSuggestion('${esc(m.id)}',this)">
            <i class="ti ti-x" style="font-size:11px"></i> ${t('mobile.ticket.ai.discard')}
          </button>
        </div>
        <div class="m-msg-time">${formatRelative(m.created_at)}</div>
      </div>
    </div>`
  }

  const av   = (m.author || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  const isMe = m.author === window.appState?.user?.displayName

  // Badge d'état + action mail selon le type (note interne / commentaire
  // public) et l'état d'envoi. Aligné avec la sémantique desktop (Phase 1c).
  let badge = ''
  let action = ''
  if (m.type === 'internal_note') {
    badge = `<span class="m-msg-badge" style="background:var(--bg-tertiary);color:var(--text-secondary)"><i class="ti ti-note" style="font-size:10px"></i> ${t('mobile.ticket.msg.internal')}</span>`
    if (_tk?.has_inbound_mail) {
      action = `<button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mSendMsgByMail('${esc(m.id)}',this)"><i class="ti ti-mail-forward" style="font-size:11px"></i> ${t('mobile.ticket.msg.send_by_mail')}</button>`
    }
  } else if (m.type === 'comment' && m.outbound_failed_at) {
    badge = `<span class="m-msg-badge" style="background:rgba(239,68,68,.15);color:var(--red)" title="${esc(m.outbound_error || '')}"><i class="ti ti-mail-x" style="font-size:10px"></i> ${t('mobile.ticket.msg.send_failed')}</span>`
    action = `<button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mRetrySend('${esc(m.id)}',this)"><i class="ti ti-refresh" style="font-size:11px"></i> ${t('mobile.ticket.msg.retry_send')}</button>`
  } else if (m.type === 'comment' && !m.email_sent_at) {
    badge = `<span class="m-msg-badge" style="background:rgba(245,158,11,.15);color:var(--amber)"><i class="ti ti-mail-fast" style="font-size:10px"></i> ${t('mobile.ticket.msg.sending')}</span>`
  } else if (m.type === 'comment' && m.email_sent_at) {
    badge = `<span class="m-msg-badge" style="background:rgba(34,197,94,.15);color:var(--green)"><i class="ti ti-mail-check" style="font-size:10px"></i> ${t('mobile.ticket.msg.sent_by_mail')}</span>`
  }

  return `
  <div class="m-msg ${isMe ? 'm-msg-me' : ''}">
    ${!isMe ? `<div class="m-av" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${esc(av)}</div>` : ''}
    <div class="m-msg-bubble ${isMe ? 'm-msg-bubble-me' : ''}">
      ${!isMe ? `<div class="m-msg-author">${esc(m.author)}</div>` : ''}
      <div class="m-msg-content">${esc(m.content)}</div>
      ${badge || action ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px">${badge}${action}</div>` : ''}
      <div class="m-msg-time">${formatRelative(m.created_at)}</div>
    </div>
  </div>`
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function reload() {
  _tk = await window.api.getTicket(_tk.id)
  renderTicketBody()
}

async function mSendReply(btn) {
  const input   = document.getElementById('m-reply-txt')
  const content = input?.value?.trim()
  if (!content) return
  input.value = ''
  input.style.height = 'auto'
  await withBusy(btn, async () => {
    try {
      await window.api.addMessage(_tk.id, { content })
      await reload()
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

async function mSetStatus(status, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.updateTicket(_tk.id, { status })
      await reload()
      const labels = { resolved: 'Ticket résolu ✓', open: 'Ticket rouvert', in_progress: 'En cours' }
      window.showToast(labels[status] || 'Mis à jour', status === 'resolved' ? 'success' : 'info')
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

// ── Assistant IA ──────────────────────────────────────────────────────────────

async function mAiSuggest() {
  if (_aiBusy) return
  _aiBusy = true
  const btn = document.getElementById('m-ai-btn')
  if (btn) { btn.style.opacity = '0.5'; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:m-spin .7s linear infinite"></i>' }
  try {
    await window.api.aiSuggest(_tk.id)
    await reload()
  } catch (err) {
    window.showToast(err?.body?.error || t('mobile.ticket.ai.failed'), 'error')
  } finally {
    _aiBusy = false
    const b = document.getElementById('m-ai-btn')
    if (b) { b.style.opacity = '1'; b.innerHTML = '<i class="ti ti-sparkles"></i>' }
  }
}

function mUseSuggestion(btn) {
  const input = document.getElementById('m-reply-txt')
  if (!input) return
  input.value = btn.dataset.content || ''
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 100) + 'px'
  input.focus()
}

async function mDeleteSuggestion(msgId, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.deleteTicketMessage(_tk.id, msgId)
      await reload()
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

// ── Envoi par mail / retry ──────────────────────────────────────────────────

async function mSendMsgByMail(msgId, btn) {
  if (!confirm(t('mobile.ticket.msg.send_by_mail_confirm'))) return
  await withBusy(btn, async () => {
    try {
      await window.api.sendMessageByMail(_tk.id, msgId)
      await reload()
      window.showToast(t('mobile.ticket.msg.send_queued'), 'success')
    } catch (err) {
      if (err?.status === 409) window.showToast(t('mobile.ticket.msg.no_inbound'), 'error')
      else window.showToast(t('mobile.ticket.toast.error'), 'error')
    }
  })
}

async function mRetrySend(msgId, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.retrySendMessage(_tk.id, msgId)
      await reload()
      window.showToast(t('mobile.ticket.msg.send_queued'), 'success')
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

// ── Menu ────────────────────────────────────────────────────────────────────

function mTicketMenu() {
  const tk = _tk
  const attCount = (tk.attachments || []).length
  const peopleCount = (tk.related_users || []).length
  const devCount = (tk.related_devices || []).length

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

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenAssignee)">
        <i class="ti ti-user-check" style="color:var(--blue)"></i> ${t('mobile.ticket.menu.assignee')}
        <span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">${tk.assigned_to_name ? esc(shortName(tk.assigned_to_name)) : t('mobile.ticket.assignee.none')}</span>
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenPeople)">
        <i class="ti ti-users" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.people')}
        ${peopleCount ? `<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">${peopleCount}</span>` : ''}
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenDevices)">
        <i class="ti ti-device-laptop" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.devices')}
        ${devCount ? `<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">${devCount}</span>` : ''}
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenAttachments)">
        <i class="ti ti-paperclip" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.attachments')}
        ${attCount ? `<span style="margin-left:auto;font-size:11px;color:var(--text-tertiary)">${attCount}</span>` : ''}
      </button>

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

    </div>`)
}

// ── Assignation ──────────────────────────────────────────────────────────────

function mOpenAssignee() {
  const tk = _tk
  const me = window.appState?.user
  const isMe = me?.entraId && tk.assigned_to_entra_id === me.entraId

  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.ticket.assignee.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:13px">${tk.assigned_to_name ? `<i class="ti ti-user-check" style="font-size:11px;opacity:0.7"></i> ${esc(tk.assigned_to_name)}` : `<span style="color:var(--text-tertiary)">${t('mobile.ticket.assignee.none')}</span>`}</span>
        ${tk.assigned_to_entra_id ? `<button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px" onclick="mUnassign(this)">${t('mobile.ticket.assignee.unassign')}</button>` : ''}
        ${me?.entraId && !isMe ? `<button class="m-pill m-pill-on" style="border:none;cursor:pointer;font-size:11px" onclick="mAssignSelf(this)">${t('mobile.ticket.assignee.self')}</button>` : ''}
      </div>
      <div style="height:1px;background:var(--border)"></div>
      <div class="m-label">${t('mobile.ticket.assignee.search_label')}</div>
      <input class="m-input" id="m-tk-assignee-q" placeholder="${t('mobile.ticket.user_search_ph')}" autocomplete="off">
      <div id="m-tk-assignee-results" style="max-height:40vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
    </div>`)
  wireUserSearch('m-tk-assignee-q', 'm-tk-assignee-results', (u) => mAssignTo(u.entra_id, u.display_name))
}

async function mAssignSelf(btn) {
  const me = window.appState?.user
  if (!me?.entraId) return
  await withBusy(btn, async () => {
    try {
      await window.api.updateTicket(_tk.id, { assigned_to_entra_id: me.entraId, assigned_to_name: me.displayName })
      await reload()
      window.mCloseSheet()
      window.showToast(t('mobile.ticket.assign.toast.self'), 'success')
    } catch { window.showToast(t('mobile.ticket.assign.toast.error'), 'error') }
  })
}

async function mUnassign(btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.updateTicket(_tk.id, { assigned_to_entra_id: null, assigned_to_name: null })
      await reload()
      window.mCloseSheet()
      window.showToast(t('mobile.ticket.assign.toast.unassigned'), 'info')
    } catch { window.showToast(t('mobile.ticket.assign.toast.error'), 'error') }
  })
}

async function mAssignTo(entraId, name) {
  try {
    await window.api.updateTicket(_tk.id, { assigned_to_entra_id: entraId, assigned_to_name: name })
    await reload()
    window.mCloseSheet()
    window.showToast(t('mobile.ticket.assign.toast.self'), 'success')
  } catch { window.showToast(t('mobile.ticket.assign.toast.error'), 'error') }
}

// ── Demandeur & personnes liées ───────────────────────────────────────────────

function mOpenPeople() {
  const users = _tk.related_users || []
  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.ticket.people.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-direction:column;gap:4px">
        ${users.length ? users.map(u => {
          const isReq = u.role === 'requester'
          return `<div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${esc(u.display_name || u.entra_id)}
              ${isReq ? `<span style="font-size:10px;background:rgba(13,148,136,0.15);color:#0d9488;padding:1px 6px;border-radius:8px;margin-left:4px">${t('mobile.ticket.people.requester')}</span>` : ''}
            </div>
            <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px;color:var(--text-tertiary)" onclick="mRemoveUser('${esc(u.entra_id)}',this)"><i class="ti ti-x" style="font-size:12px"></i></button>
          </div>`
        }).join('') : `<div style="font-size:13px;color:var(--text-tertiary)">${t('mobile.ticket.people.empty')}</div>`}
      </div>
      <div style="height:1px;background:var(--border)"></div>
      <div style="display:flex;gap:6px">
        <button class="m-pill ${'m-pill-off'}" style="border:none;cursor:pointer;font-size:12px;padding:6px 10px" id="m-people-mode-req" onclick="mPeopleSetMode('requester')">${t('mobile.ticket.people.set_requester')}</button>
        <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:12px;padding:6px 10px" id="m-people-mode-inv" onclick="mPeopleSetMode('involved')">${t('mobile.ticket.people.add_involved')}</button>
      </div>
      <input class="m-input" id="m-tk-people-q" placeholder="${t('mobile.ticket.user_search_ph')}" autocomplete="off">
      <div id="m-tk-people-results" style="max-height:35vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
    </div>`)

  let mode = 'involved'
  const reqBtn = document.getElementById('m-people-mode-req')
  const invBtn = document.getElementById('m-people-mode-inv')
  const paint = () => {
    reqBtn.className = `m-pill ${mode === 'requester' ? 'm-pill-on' : 'm-pill-off'}`
    invBtn.className = `m-pill ${mode === 'involved' ? 'm-pill-on' : 'm-pill-off'}`
  }
  paint()
  window.mPeopleSetMode = (m) => { mode = m; paint() }
  window.mRemoveUser = mRemoveUser
  wireUserSearch('m-tk-people-q', 'm-tk-people-results', (u) => mAddPerson(u.entra_id, mode))
}

async function mAddPerson(entraId, mode) {
  try {
    if (mode === 'requester') {
      await window.api.updateTicket(_tk.id, { user_id: entraId })
    } else {
      await window.api.addTicketUser(_tk.id, { entra_id: entraId, role: 'involved' })
    }
    await reload()
    mOpenPeople()  // re-render la sheet avec la liste à jour
    window.showToast(t('mobile.ticket.people.toast_added'), 'success')
  } catch (err) {
    window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error')
  }
}

async function mRemoveUser(entraId, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.removeTicketUser(_tk.id, entraId)
      await reload()
      mOpenPeople()
    } catch (err) {
      window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error')
    }
  })
}

// ── Postes liés ────────────────────────────────────────────────────────────────

function mOpenDevices() {
  const devs = _tk.related_devices || []
  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.ticket.devices.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-direction:column;gap:4px">
        ${devs.length ? devs.map(d => `
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-device-laptop" style="font-size:12px;opacity:0.7"></i> ${esc(d.hostname || d.id)}</div>
            <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px;color:var(--text-tertiary)" onclick="mRemoveDevice('${esc(d.id)}',this)"><i class="ti ti-x" style="font-size:12px"></i></button>
          </div>`).join('') : `<div style="font-size:13px;color:var(--text-tertiary)">${t('mobile.ticket.devices.empty')}</div>`}
      </div>
      <div style="height:1px;background:var(--border)"></div>
      <div class="m-label">${t('mobile.ticket.devices.add')}</div>
      <input class="m-input" id="m-tk-dev-q" placeholder="${t('mobile.ticket.device_search_ph')}" autocomplete="off">
      <div id="m-tk-dev-results" style="max-height:35vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>
    </div>`)
  window.mRemoveDevice = mRemoveDevice
  wireDeviceSearch('m-tk-dev-q', 'm-tk-dev-results', (d) => mAddDevice(d.id))
}

async function mAddDevice(deviceId) {
  try {
    await window.api.addTicketDevice(_tk.id, { device_id: deviceId })
    await reload()
    mOpenDevices()
    window.showToast(t('mobile.ticket.devices.toast_added'), 'success')
  } catch (err) {
    window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error')
  }
}

async function mRemoveDevice(deviceId, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.removeTicketDevice(_tk.id, deviceId)
      await reload()
      mOpenDevices()
    } catch (err) {
      window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error')
    }
  })
}

// ── Pièces jointes ──────────────────────────────────────────────────────────────

function mOpenAttachments() {
  const atts = _tk.attachments || []
  window.mShowSheet(`
    <div class="m-sheet-title">${t('mobile.ticket.attachments.title')}</div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-direction:column;gap:6px">
        ${atts.length ? atts.map(a => `
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;min-width:0;font-size:13px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-fn="${esc(a.filename)}" onclick="mDownloadAttachment('${esc(a.id)}', this.dataset.fn)">
              <i class="ti ti-paperclip" style="font-size:12px;opacity:0.7"></i> ${esc(a.filename)}
              <span style="color:var(--text-tertiary);font-size:11px">· ${formatBytes(a.size_bytes)}</span>
            </div>
            <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px;color:var(--text-tertiary)" onclick="mRemoveAttachment('${esc(a.id)}',this)"><i class="ti ti-x" style="font-size:12px"></i></button>
          </div>`).join('') : `<div style="font-size:13px;color:var(--text-tertiary)">${t('mobile.ticket.attachments.empty')}</div>`}
      </div>
      <div style="height:1px;background:var(--border)"></div>
      <input type="file" id="m-tk-att-input" style="display:none" onchange="mUploadAttachment(this)">
      <button class="m-btn-primary" onclick="document.getElementById('m-tk-att-input').click()">
        <i class="ti ti-upload"></i> ${t('mobile.ticket.attachments.add')}
      </button>
      <div style="font-size:11px;color:var(--text-tertiary);text-align:center">${t('mobile.ticket.attachments.hint')}</div>
    </div>`)
  window.mDownloadAttachment = mDownloadAttachment
  window.mRemoveAttachment   = mRemoveAttachment
  window.mUploadAttachment   = mUploadAttachment
}

async function mUploadAttachment(inputEl) {
  const file = inputEl?.files?.[0]
  if (!file) return
  try {
    await window.api.uploadAttachment(_tk.id, file)
    inputEl.value = ''
    await reload()
    mOpenAttachments()
    window.showToast(t('mobile.ticket.attachments.uploaded'), 'success')
  } catch (err) {
    window.showToast(err?.status === 413 ? t('mobile.ticket.attachments.too_large') : (err?.body?.error || t('mobile.ticket.toast.error')), 'error')
  }
}

async function mDownloadAttachment(attId, filename) {
  try {
    await window.api.downloadAttachment(_tk.id, attId, filename)
  } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
}

async function mRemoveAttachment(attId, btn) {
  if (!confirm(t('mobile.ticket.attachments.confirm_remove'))) return
  await withBusy(btn, async () => {
    try {
      await window.api.deleteAttachment(_tk.id, attId)
      await reload()
      mOpenAttachments()
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

// ── Recherche utilisateur / device (réutilisable dans les sheets) ──────────────

function wireUserSearch(inputId, listId, onPick) {
  const input = document.getElementById(inputId)
  const list  = document.getElementById(listId)
  if (!input || !list) return
  setTimeout(() => input.focus(), 50)
  // onPick exposé globalement pour l'onclick inline (la closure capture onPick).
  window.__mPickUser = onPick
  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      const users = await window.api.searchUsers(q).catch(() => [])
      list.innerHTML = users.length
        ? users.map(u => `
            <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
              onclick="window.__mPickUser({ entra_id: '${esc(u.entra_id)}', display_name: ${mJsArg(u.display_name || '')} })">
              <div style="font-size:13px">${esc(u.display_name)}</div>
              ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(u.email)}</div>` : ''}
            </div>`).join('')
        : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('mobile.ticket.no_match')}</div>`
    }, 200)
  })
}

function wireDeviceSearch(inputId, listId, onPick) {
  const input = document.getElementById(inputId)
  const list  = document.getElementById(listId)
  if (!input || !list) return
  setTimeout(() => input.focus(), 50)
  window.__mPickDevice = onPick
  let devices = null
  let timer
  const paint = () => {
    const q = input.value.trim().toLowerCase()
    const filtered = q
      ? devices.filter(d => (d.hostname || '').toLowerCase().includes(q) ||
                            (d.user_name || '').toLowerCase().includes(q) ||
                            (d.model || '').toLowerCase().includes(q))
      : devices.slice(0, 50)
    list.innerHTML = filtered.length
      ? filtered.slice(0, 50).map(d => `
          <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
            onclick="window.__mPickDevice({ id: '${esc(d.id)}' })">
            <div style="font-size:13px">${esc(d.hostname || '?')}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${esc(d.user_name || '')}${d.model ? ' · ' + esc(d.model) : ''}</div>
          </div>`).join('')
      : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">${t('mobile.ticket.no_match')}</div>`
  }
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (!devices) {
        try { devices = (await window.api.getDevices({ limit: 200 }))?.devices || [] }
        catch { devices = [] }
      }
      paint()
    }, 200)
  })
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
          <button class="m-menu-row" onclick="mToggleTag('${esc(g.id)}', ${assigned ? 'true' : 'false'}, this)">
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
      <button class="m-btn-primary" onclick="mCreateTag(this)">
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

async function mToggleTag(tagId, isAssigned, btn) {
  await withBusy(btn, async () => {
    try {
      if (isAssigned) {
        await window.api.removeTicketTag(_tk.id, tagId)
      } else {
        await window.api.addTicketTag(_tk.id, tagId)
      }
      await reload()
      renderTagsSheet()  // re-render la sheet pour refléter le nouveau state
    } catch {
      window.showToast(t('mobile.ticket.tags.toast.error'), 'error')
    }
  })
}

async function mCreateTag(btn) {
  const name = document.getElementById('m-tk-newtag-name')?.value?.trim()
  if (!name) {
    window.showToast(t('mobile.ticket.tags.name_required'), 'error')
    return
  }
  const activeSwatch = document.querySelector('#m-tk-newtag-colors .m-tk-color-swatch.active')
  const color = activeSwatch?.dataset?.color || 'slate'
  await withBusy(btn, async () => {
    try {
      const newTag = await window.api.createTag({ name, color })
      _allTags.push(newTag)
      await window.api.addTicketTag(_tk.id, newTag.id)
      await reload()
      renderTagsSheet()  // re-render avec le nouveau tag
      window.showToast(t('mobile.ticket.tags.toast.created'), 'success')
    } catch (err) {
      window.showToast(err.message || t('mobile.ticket.tags.toast.error'), 'error')
    }
  })
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
  window.mSetPriority = mSetPriority
}

async function mSetPriority(priority) {
  window.mCloseSheet()
  try {
    await window.api.updateTicket(_tk.id, { priority })
    await reload()
    window.showToast('Priorité mise à jour', 'success')
  } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
}

function mEditTitle() {
  window.mShowSheet(`
    <div class="m-sheet-title">Modifier le titre</div>
    <div style="padding:0 4px;display:flex;flex-direction:column;gap:12px">
      <input class="m-input" id="m-edit-title" value="${esc(_tk.title)}" autocomplete="off">
      <button class="m-btn-primary" onclick="mSaveTitle(this)">Enregistrer</button>
    </div>`)
  setTimeout(() => document.getElementById('m-edit-title')?.focus(), 100)
  window.mSaveTitle = async (btn) => {
    const title = document.getElementById('m-edit-title')?.value?.trim()
    if (!title || title === _tk.title) { window.mCloseSheet(); return }
    await withBusy(btn, async () => {
      try {
        await window.api.updateTicket(_tk.id, { title })
        window.mCloseSheet()
        await reload()
        window.showToast('Titre modifié', 'success')
      } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusLabel(s) {
  return s === 'resolved' ? 'Résolu' : s === 'in_progress' ? 'En cours' : s === 'proposed' ? 'Proposé' : 'Ouvert'
}
// Valeur inconnue échappée : priority est du texte libre côté API.
function prioLabel(p) {
  return p === 'low' ? 'Basse' : p === 'normal' ? 'Normale' : p === 'high' ? 'Haute' : p === 'critical' ? 'Critique' : esc(p || '—')
}
function prioColor(p) {
  return p === 'critical' ? 'var(--red)' : p === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
}
