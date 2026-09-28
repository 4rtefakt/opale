// Page focus : UN ticket, rien d'autre. Titre renommable, quatre cartes de
// propriétés, la conversation, un composer toujours visible avec une seule
// action évidente, « Terminé & suivant » pour enchaîner sans revenir à la
// liste. Tout le reste (personnes, postes, tags, pièces jointes, description,
// fusion) vit dans un tiroir « Détails » fermé par défaut.
//
// Même page pour un fil de mails pas encore ticket (#/tickets/mail/<id>) :
// les cartes deviennent « ce que deviendra le ticket », les actions sont
// Créer le ticket / Ajouter à un ticket / Ignorer, et répondre crée le ticket.

import {
  shortName, initialsOf, ticketRef, tagChip, whenHtml, fmtDateShort, fmtDateFull, dayLabel, dayKey,
  cleanLegacyHtml, statusLabel, prioLabel, nextLabel, queueNext, queuePosition, readQueue,
} from '/views/ticket-shared.js'

const jsArg = window.jsArg
let _tk = null
let _mode = 'mail'          // composer : 'mail' | 'note' (mémorisé)
let _allTags = []
let _container = null

// ═══════════════════════════════════════════════════════════════════════════
// Ticket
// ═══════════════════════════════════════════════════════════════════════════

export async function renderTicketFocus(container, id) {
  _container = container
  container.innerHTML = `<div class="focus"><div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div></div>`
  bindGlobals()
  try {
    const tk = await window.api.getTicket(id)
    if (tk.merged_into) { showToast(t('tickets.merge.redirected').replace('{target}', ticketRef(tk.merged_into)), 'info'); navigateTo(`/tickets/${tk.merged_into}`); return }
    _tk = tk
    if (!_tk.has_inbound_mail) _mode = 'note'
    render()
  } catch (err) {
    container.innerHTML = `<div class="focus"><div class="ticket-detail-empty"><i class="ti ti-mood-confuzed" style="font-size:32px"></i><span>${esc(err?.status === 404 ? t('tickets.focus.not_found') : t('error.generic'))}</span><a href="#/tickets">${esc(t('tickets.focus.back'))}</a></div></div>`
  }
}

function bindGlobals() {
  Object.assign(window, {
    fcEditTitle, fcSaveTitle, fcCancelTitle, fcStatusMenu, fcSetStatus, fcPriorityMenu, fcSetPriority,
    fcAssignMenu, fcAssignSelf, fcUnassign, fcRequesterMenu, fcDeviceMenu, fcOpenDetails, fcCloseDetails,
    fcSetMode, fcSend, fcComposerKey, fcAi, fcUseSuggestion, fcDeleteSuggestion, fcSendNoteByMail, fcRetrySend,
    fcDoneNext, fcNext, fcToggleMsg, fcCopyRef, fcCopyLink, fcEditDescription, fcSaveDescription,
    fcRemoveUser, fcRemoveDevice, fcAddTag, fcRemoveTag, fcUpload, fcDownload, fcRemoveAttachment, fcMerge,
    mfToTicket, mfAttach, mfDismiss, mfReplyCreate, mfSetPriority,
  })
}

async function reload() {
  if (!_tk) return
  _tk = await window.api.getTicket(_tk.id)
  render()
}

function isInbound(m, tk) {
  if (m.type !== 'comment') return false
  if ((tk.mail_authors || []).includes(m.author)) return true
  if (tk.requester_name && m.author === tk.requester_name) return true
  return /@/.test(m.author || '') || m.author === 'Email'
}

function render() {
  const tk = _tk
  const me = window.appState?.user
  const nx = nextLabel(tk)
  const closed = tk.status === 'closed'
  const canMail = !!tk.has_inbound_mail
  const mode = canMail && _mode === 'mail' ? 'mail' : 'note'
  const pos = queuePosition(tk.id)
  const draft = document.getElementById('fc-input')?.value || ''

  const nextV = nx.cls === 'needs' ? 'needs' : nx.cls === 'crit' ? 'crit' : nx.cls === 'done' ? 'ok' : 'dim'
  let lastDay = ''
  const conv = (tk.messages || []).map(m => {
    const k = dayKey(m.created_at)
    const sep = k && k !== lastDay ? `<div class="conv-label">${esc(dayLabel(m.created_at))}</div>` : ''
    lastDay = k || lastDay
    return sep + msgHtml(m, tk)
  }).join('')

  _container.innerHTML = `
    <div class="focus">
      <div class="focus-top">
        <a href="${pos ? (pos.from === 'today' ? '#/today' : '#/tickets') : '#/tickets'}">← ${esc(pos?.from === 'today' ? t('nav.today') : t('tickets.title'))}</a>
        <span>/</span>
        <span class="ref" onclick="fcCopyRef()" title="${esc(t('tickets.ref.copy_hint'))}">#${ticketRef(tk.id)}</span>
        <span>${esc(tk.has_inbound_mail ? t('tickets.focus.via_mail') : tk.is_auto ? t('tickets.source.auto') : t('tickets.source.manual'))} · ${esc(t('tickets.focus.opened'))} ${whenHtml(tk.created_at)}${tk.created_by_name ? ` · ${esc(tk.created_by_name)}` : ''}</span>
        <span class="right">
          ${pos ? `<span class="focus-queue">${esc(t('tickets.focus.queue', { i: pos.index, n: pos.total }))}</span>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="fcCopyLink()" title="${esc(t('tickets.link.copy'))}"><i class="ti ti-link"></i></button>
          <button class="btn btn-sm" onclick="fcOpenDetails()"><i class="ti ti-layout-sidebar-right"></i> ${esc(t('tickets.focus.details'))}</button>
          ${closed
            ? `<button class="btn btn-sm" onclick="fcSetStatus('resolved')"><i class="ti ti-archive-off"></i> ${esc(t('tickets.unarchive'))}</button>`
            : tk.status === 'resolved'
              ? `<button class="btn btn-sm" onclick="fcSetStatus('open')"><i class="ti ti-refresh"></i> ${esc(t('tickets.reopen'))}</button><button class="btn btn-sm" onclick="fcSetStatus('closed')"><i class="ti ti-archive"></i> ${esc(t('tickets.archive'))}</button>`
              : `<button class="btn btn-sm btn-primary" onclick="fcDoneNext()" title="${esc(t('tickets.focus.done_hint'))}"><i class="ti ti-check"></i> ${esc(pos && pos.total > 1 ? t('tickets.focus.done_next') : t('tickets.focus.done'))}</button>`}
        </span>
      </div>
      <div class="focus-head">
        <div id="fc-titlerow">
          <h1 class="focus-title" id="fc-title" onclick="fcEditTitle()" title="${esc(t('tickets.title.edit_hint'))}">${esc(tk.title)}<span class="focus-title-hint"><i class="ti ti-pencil"></i></span></h1>
        </div>
        <div class="props">
          <button class="prop" onclick="fcStatusMenu()"><div class="k">${esc(t('tickets.focus.prop.next'))}</div><div class="v ${nextV}"><span class="dotv"></span>${esc(nx.label)} <i class="ti ti-chevron-down" style="font-size:11px;opacity:.6"></i></div><div class="s">${esc(statusLabel(tk.status))}${tk.resolved_at && tk.status === 'resolved' ? ` · ${fmtDateShort(tk.resolved_at)}` : ''}</div></button>
          <button class="prop" onclick="fcPriorityMenu()"><div class="k">${esc(t('tickets.new.priority'))}</div><div class="v ${tk.priority === 'critical' ? 'crit' : tk.priority === 'high' ? 'needs' : ''}">${esc(prioLabel(tk.priority))} <i class="ti ti-chevron-down" style="font-size:11px;opacity:.6"></i></div><div class="s">${esc(t('tickets.focus.prio_hint'))}</div></button>
          <button class="prop" onclick="${tk.assigned_to_entra_id ? 'fcAssignMenu()' : 'fcAssignSelf()'}"><div class="k">${esc(t('tickets.info.assignee'))}</div>
            ${tk.assigned_to_name ? `<div class="v"><span class="av" style="background:var(--blue)">${esc(initialsOf(tk.assigned_to_name))}</span>${tk.assigned_to_entra_id === me?.entraId ? esc(t('today.why.you')) : esc(tk.assigned_to_name)}</div><div class="s">${esc(t('tickets.focus.assign_change'))}</div>` : `<div class="v pri">${esc(t('tickets.assign_self'))}</div><div class="s">${esc(t('tickets.unassigned'))}</div>`}
          </button>
          <button class="prop" onclick="fcRequesterMenu()"><div class="k">${esc(t('tickets.info.requester'))}</div>
            ${tk.requester_name ? `<div class="v"><span class="av">${esc(initialsOf(tk.requester_name))}</span>${esc(tk.requester_name)}</div><div class="s">${esc([tk.requester_email, tk.hostname].filter(Boolean).join(' · ') || t('tickets.no_device'))}</div>` : `<div class="v dim">${esc(t('tickets.no_requester'))}</div><div class="s">${esc(tk.hostname || t('tickets.focus.link_person'))}</div>`}
          </button>
        </div>
        ${tk.description ? `<div class="mail-note" style="align-items:flex-start"><i class="ti ti-align-left"></i><div style="white-space:pre-wrap;flex:1;min-width:0">${esc(cleanLegacyHtml(tk.description))}</div><button class="btn btn-sm btn-ghost" onclick="fcEditDescription()"><i class="ti ti-pencil"></i></button></div>` : ''}
      </div>
      <div class="focus-body" id="fc-body">
        <div class="focus-conv">
          ${conv || `<div style="text-align:center;color:var(--text-tertiary);font-size:13px;padding:20px">${esc(t('tickets.msg.none'))}</div>`}
        </div>
      </div>
      ${!closed ? `
      <div class="focus-composer">
        <div class="focus-composer-inner">
          <div class="composer-modes">
            <button class="composer-mode ${mode === 'mail' ? 'active' : ''}" onclick="fcSetMode('mail')" ${canMail ? '' : `disabled title="${esc(t('tickets.send_by_mail.no_inbound'))}"`}><i class="ti ti-mail-forward"></i> ${esc(t('tickets.focus.reply_to', { who: shortName(tk.requester_name) || (tk.requester_email || t('tickets.focus.requester_generic')) }))}</button>
            <button class="composer-mode ${mode === 'note' ? 'active' : ''}" onclick="fcSetMode('note')"><i class="ti ti-lock"></i> ${esc(t('tickets.composer.note'))}</button>
            <span class="composer-hint">${esc(mode === 'mail' ? t('tickets.composer.mail_hint') : t('tickets.composer.note_hint'))}</span>
          </div>
          <textarea class="composer-input" id="fc-input" placeholder="${esc(mode === 'mail' ? t('tickets.composer.mail_placeholder') : t('tickets.composer.note_placeholder'))}" onkeydown="fcComposerKey(event)">${esc(draft)}</textarea>
          <div class="composer-actions">
            <button class="btn btn-sm" id="fc-ai" onclick="fcAi()"><i class="ti ti-sparkles"></i> ${esc(t('tickets.ai.suggest'))}</button>
            <span style="flex:1"></span>
            <span style="font-size:12px;color:var(--text-tertiary)">⌘/Ctrl ↵</span>
            <button class="btn ${mode === 'mail' ? 'btn-primary' : ''}" id="fc-send" onclick="fcSend()"><i class="ti ${mode === 'mail' ? 'ti-send' : 'ti-note'}"></i> ${esc(mode === 'mail' ? t('tickets.composer.send_mail') : t('tickets.composer.send_note'))}</button>
          </div>
        </div>
      </div>` : ''}
    </div>
    <div class="details-drawer" id="fc-details"></div>`
  const body = document.getElementById('fc-body')
  if (body) body.scrollTop = body.scrollHeight
}

const COLLAPSE = 1400
function msgHtml(m, tk) {
  const when = whenHtml(m.created_at)
  if (m.type === 'system') return `<div class="cmsg sys"><span class="av sys"><i class="ti ti-info-circle" style="font-size:14px"></i></span><div class="bd"><div class="txt">${esc(m.content)} · ${when}</div></div></div>`
  if (m.type === 'ai_suggestion') return `<div class="cmsg ai"><span class="av ai"><i class="ti ti-sparkles" style="font-size:14px"></i></span><div class="bd"><div class="meta"><b>${esc(t('tickets.ai.badge'))}</b> ${esc(t('tickets.focus.ai_draft'))} · ${when}</div><div class="txt">${esc(m.content)}</div><div class="acts"><button class="btn btn-sm" data-content="${esc(m.content)}" onclick="fcUseSuggestion(this)"><i class="ti ti-corner-up-left"></i> ${esc(t('tickets.ai.use'))}</button><button class="btn btn-sm btn-ghost" onclick="fcDeleteSuggestion('${m.id}')"><i class="ti ti-x"></i></button></div></div></div>`
  const inbound = isInbound(m, tk)
  const isMe = m.author === window.appState?.user?.displayName
  let cls = '', badge = '', acts = ''
  if (m.type === 'internal_note') {
    cls = 'note'; badge = `<span class="msg-badge msg-badge-internal"><i class="ti ti-lock"></i> ${esc(t('tickets.msg.internal'))}</span>`
    if (tk.has_inbound_mail) acts = `<button class="btn btn-sm" onclick="fcSendNoteByMail('${m.id}')"><i class="ti ti-mail-forward"></i> ${esc(t('tickets.msg.send_by_mail'))}</button>`
  } else if (m.type === 'resolution') { badge = `<span class="msg-badge msg-badge-sent">${esc(t('tickets.status.resolved'))}</span>` }
  else if (inbound) badge = `<span class="msg-badge msg-badge-in"><i class="ti ti-mail-down"></i> ${esc(t('tickets.msg.received_by_mail'))}</span>`
  else if (m.outbound_failed_at) { badge = `<span class="msg-badge msg-badge-failed" title="${esc(m.outbound_error || '')}"><i class="ti ti-mail-x"></i> ${esc(t('tickets.msg.send_failed'))}</span>`; acts = `<button class="btn btn-sm" onclick="fcRetrySend('${m.id}')"><i class="ti ti-refresh"></i> ${esc(t('tickets.msg.retry_send'))}</button>` }
  else if (!m.email_sent_at) badge = `<span class="msg-badge msg-badge-sending"><i class="ti ti-mail-fast"></i> ${esc(t('tickets.msg.sending'))}</span>`
  else badge = `<span class="msg-badge msg-badge-sent"><i class="ti ti-mail-check"></i> ${esc(t('tickets.msg.sent_by_mail'))}</span>`
  const long = (m.content || '').length > COLLAPSE
  const cid = `fc-m-${m.id}`
  return `<div class="cmsg ${cls}" id="msg-${m.id}">
    <span class="av ${inbound ? 'req' : ''}">${esc(initialsOf(m.author))}</span>
    <div class="bd">
      <div class="meta"><b>${esc(isMe ? t('today.why.you') : m.author)}</b>${badge}<span>${when}</span></div>
      <div class="txt ${long ? 'collapsed' : ''}" id="${cid}">${esc(m.content)}</div>
      ${long ? `<span class="more" onclick="fcToggleMsg(this,'${cid}')">${esc(t('tickets.msg.show_more'))}</span>` : ''}
      ${acts ? `<div class="acts">${acts}</div>` : ''}
    </div>
  </div>`
}
function fcToggleMsg(link, id) { const el = document.getElementById(id); if (!el) return; const c = el.classList.toggle('collapsed'); link.textContent = c ? t('tickets.msg.show_more') : t('tickets.msg.show_less') }

// ── Titre / description ─────────────────────────────────────────────────────

function fcEditTitle() {
  const row = document.getElementById('fc-titlerow')
  if (!row || document.getElementById('fc-title-input')) return
  row.innerHTML = `<input class="focus-title-input" id="fc-title-input" value="${esc(_tk.title)}" maxlength="200" onkeydown="if(event.key==='Enter'){event.preventDefault();fcSaveTitle()}else if(event.key==='Escape'){fcCancelTitle()}" onblur="fcSaveTitle()">`
  const i = document.getElementById('fc-title-input'); i.focus(); i.select()
}
function fcCancelTitle() { render() }
async function fcSaveTitle() {
  const input = document.getElementById('fc-title-input')
  if (!input) return
  const title = input.value.trim()
  if (!title || title === _tk.title) { render(); return }
  try { await window.api.updateTicket(_tk.id, { title }); await reload(); showToast(t('tickets.toast.renamed'), 'success') }
  catch (err) { showToast(err?.body?.error || t('error.generic'), 'error'); render() }
}
function fcEditDescription() {
  showModal(`
    <div class="modal-title">${t('tickets.description.edit_title')}</div>
    <textarea class="form-textarea" id="fc-desc" style="min-height:200px">${esc(cleanLegacyHtml(_tk.description || ''))}</textarea>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button><button class="btn btn-primary" onclick="fcSaveDescription()">${t('btn.save')}</button></div>`)
  setTimeout(() => document.getElementById('fc-desc')?.focus(), 50)
}
async function fcSaveDescription() {
  try { await window.api.updateTicket(_tk.id, { description: document.getElementById('fc-desc')?.value ?? '' }); closeModal(); await reload(); showToast(t('tickets.toast.description_saved'), 'success') }
  catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
}
async function fcCopyRef() { try { await navigator.clipboard.writeText(`[Opale #${ticketRef(_tk.id)}]`); showToast(t('tickets.ref.copied'), 'success') } catch { showToast(t('error.generic'), 'error') } }
async function fcCopyLink() { try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}#/tickets/${_tk.id}`); showToast(t('tickets.link.copied'), 'success') } catch { showToast(t('error.generic'), 'error') } }

// ── Propriétés (menus simples, une décision à la fois) ──────────────────────

function menu(title, rows, footer = '') {
  showModal(`<div class="modal-title">${esc(title)}</div><div style="display:flex;flex-direction:column;gap:6px">${rows}</div><div class="modal-footer">${footer}<button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
}
function fcStatusMenu() {
  const cur = _tk.status
  const opt = (v, icon, label, sub) => `<button class="btn ${v === cur ? 'btn-primary' : ''}" style="justify-content:flex-start;padding:9px 12px" onclick="fcSetStatus('${v}')"><i class="ti ${icon}"></i> <span style="text-align:left"><div>${esc(label)}</div>${sub ? `<div style="font-size:11px;opacity:.75">${esc(sub)}</div>` : ''}</span></button>`
  menu(t('tickets.status.picker_title'),
    opt('open', 'ti-circle', t('tickets.status.open'), t('tickets.focus.st.open_sub')) +
    opt('in_progress', 'ti-player-play', t('tickets.status.in_progress'), t('tickets.focus.st.progress_sub')) +
    opt('resolved', 'ti-check', t('tickets.status.resolved'), t('tickets.focus.st.resolved_sub')) +
    opt('closed', 'ti-archive', t('tickets.status.closed'), t('tickets.focus.st.closed_sub')))
}
async function fcSetStatus(status) {
  closeModal()
  if (status === _tk.status) return
  try { await window.api.updateTicket(_tk.id, { status }); await reload(); showToast(t('tickets.toast.status_set', { s: statusLabel(status) }), 'success') }
  catch { showToast(t('error.generic'), 'error') }
}
function fcPriorityMenu() {
  const cur = _tk.priority
  menu(t('tickets.priority.picker_title'), [['critical', 'var(--red)'], ['high', 'var(--amber)'], ['normal', '#0d9488'], ['low', 'var(--text-tertiary)']].map(([v, c]) =>
    `<button class="btn ${v === cur ? 'btn-primary' : ''}" style="justify-content:flex-start;border-left:4px solid ${c}" onclick="fcSetPriority('${v}')">${esc(prioLabel(v))}</button>`).join(''))
}
async function fcSetPriority(priority) {
  closeModal()
  try { await window.api.updateTicket(_tk.id, { priority }); await reload(); showToast(t('tickets.toast.priority_changed'), 'success') } catch { showToast(t('error.generic'), 'error') }
}
async function fcAssignSelf() {
  const me = window.appState?.user
  if (!me?.entraId) return
  try { await window.api.updateTicket(_tk.id, { assigned_to_entra_id: me.entraId, assigned_to_name: me.displayName }); await reload(); showToast(t('tickets.toast.assigned_self'), 'success') } catch { showToast(t('error.generic'), 'error') }
}
async function fcUnassign() { closeModal(); try { await window.api.updateTicket(_tk.id, { assigned_to_entra_id: null, assigned_to_name: null }); await reload() } catch { showToast(t('error.generic'), 'error') } }
function fcAssignMenu() {
  userPicker(t('tickets.assignee.picker_title'), async (u) => {
    try { await window.api.updateTicket(_tk.id, { assigned_to_entra_id: u.entra_id, assigned_to_name: u.display_name }); await reload() } catch { showToast(t('error.generic'), 'error') }
  }, `<button class="btn" onclick="fcAssignSelf();closeModal()">${esc(t('tickets.assign_self'))}</button>${_tk.assigned_to_entra_id ? `<button class="btn" onclick="fcUnassign()">${esc(t('tickets.unassign'))}</button>` : ''}`)
}
function fcRequesterMenu() {
  userPicker(t('tickets.requester.picker_title'), async (u) => {
    try { await window.api.updateTicket(_tk.id, { user_id: u.entra_id }); await reload() } catch { showToast(t('error.generic'), 'error') }
  }, `${window.OPALE.moduleEnabled('inventory') ? `<button class="btn" onclick="closeModal();fcDeviceMenu()"><i class="ti ti-device-laptop"></i> ${esc(t('tickets.device.pick'))}</button>` : ''}<button class="btn" onclick="closeModal();fcOpenDetails()">${esc(t('tickets.focus.more_people'))}</button>`)
}
function userPicker(title, onPick, extra = '') {
  showModal(`
    <div class="modal-title">${esc(title)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${extra}</div>
    <input class="form-input" id="fc-uq" placeholder="${esc(t('tickets.assignee.search'))}" autocomplete="off">
    <div class="pick-list" id="fc-ur" style="margin-top:8px"></div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
  const input = document.getElementById('fc-uq'); const list = document.getElementById('fc-ur')
  setTimeout(() => input?.focus(), 50)
  let timer
  input.addEventListener('input', () => {
    clearTimeout(timer); const q = input.value.trim()
    if (q.length < 2) { list.innerHTML = ''; return }
    timer = setTimeout(async () => {
      const users = await window.api.searchUsers(q).catch(() => [])
      list.innerHTML = users.length ? users.map(u => `<div class="pick-row" onclick="window.__fcPick(${jsArg(u.entra_id)},${jsArg(u.display_name)})"><div class="t">${esc(u.display_name)}</div>${u.email ? `<div class="s">${esc(u.email)}</div>` : ''}</div>`).join('') : `<div class="pick-row"><div class="s">${t('tickets.assignee.no_match')}</div></div>`
    }, 200)
  })
  window.__fcPick = (entra_id, display_name) => { closeModal(); onPick({ entra_id, display_name }) }
}
async function fcDeviceMenu() {
  showModal(`<div class="modal-title">${t('tickets.device.picker_title')}</div><input class="form-input" id="fc-dq" placeholder="${esc(t('tickets.device.search'))}" autocomplete="off"><div class="pick-list" id="fc-dr" style="margin-top:8px"></div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
  const input = document.getElementById('fc-dq'); const list = document.getElementById('fc-dr')
  setTimeout(() => input?.focus(), 50)
  let devices = []
  try { devices = (await window.api.getDevices({ limit: 200 }))?.devices || [] } catch {}
  const paint = () => {
    const q = input.value.trim().toLowerCase()
    const f = (q ? devices.filter(d => (d.hostname || '').toLowerCase().includes(q) || (d.user_name || '').toLowerCase().includes(q)) : devices).slice(0, 40)
    list.innerHTML = f.length ? f.map(d => `<div class="pick-row" onclick="window.__fcPickDev('${d.id}')"><div class="t">${esc(d.hostname || '?')}</div><div class="s">${esc(d.user_name || '')}${d.model ? ' · ' + esc(d.model) : ''}</div></div>`).join('') : `<div class="pick-row"><div class="s">${t('tickets.assignee.no_match')}</div></div>`
  }
  paint(); input.addEventListener('input', paint)
  window.__fcPickDev = async (id) => { closeModal(); try { await window.api.updateTicket(_tk.id, { device_id: id }); await reload() } catch { showToast(t('error.generic'), 'error') } }
}

// ── Composer ────────────────────────────────────────────────────────────────

function fcSetMode(m) { if (m === 'mail' && !_tk.has_inbound_mail) return; _mode = m; render(); document.getElementById('fc-input')?.focus() }
function fcComposerKey(e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); fcSend() } }
async function fcSend() {
  const input = document.getElementById('fc-input'); const content = input?.value?.trim()
  if (!content) { input?.focus(); return }
  const mail = _mode === 'mail' && _tk.has_inbound_mail
  const btn = document.getElementById('fc-send'); if (btn) btn.disabled = true
  try {
    const msg = await window.api.addMessage(_tk.id, { content })
    if (mail) await window.api.sendMessageByMail(_tk.id, msg.id)
    input.value = ''
    await reload()
    showToast(mail ? t('tickets.toast.mail_queued') : t('tickets.toast.note_added'), 'success')
  } catch (err) { if (btn) btn.disabled = false; showToast(err?.body?.error || t('error.generic'), 'error') }
}
async function fcAi() {
  const btn = document.getElementById('fc-ai'); if (btn) { btn.disabled = true; btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> ${esc(t('tickets.ai.generating'))}` }
  try { await window.api.aiSuggest(_tk.id); await reload() }
  catch (err) { showToast(err?.body?.error || t('tickets.ai.failed'), 'error'); if (btn) { btn.disabled = false; btn.innerHTML = `<i class="ti ti-sparkles"></i> ${esc(t('tickets.ai.suggest'))}` } }
}
function fcUseSuggestion(btn) { const i = document.getElementById('fc-input'); if (!i) return; i.value = btn.dataset.content || ''; i.focus() }
async function fcDeleteSuggestion(msgId) { try { await window.api.deleteTicketMessage(_tk.id, msgId); await reload() } catch { showToast(t('error.generic'), 'error') } }
async function fcSendNoteByMail(msgId) { if (!confirm(t('tickets.send_by_mail.confirm'))) return; try { await window.api.sendMessageByMail(_tk.id, msgId); await reload() } catch (err) { showToast(err?.status === 409 ? t('tickets.send_by_mail.no_inbound') : t('error.generic'), 'error') } }
async function fcRetrySend(msgId) { try { await window.api.retrySendMessage(_tk.id, msgId); await reload(); showToast(t('tickets.msg.retry_queued'), 'success') } catch { showToast(t('error.generic'), 'error') } }

// « Terminé » : résout, puis passe au suivant de la file s'il y en a un.
async function fcDoneNext() {
  try {
    await window.api.updateTicket(_tk.id, { status: 'resolved' })
    showToast(t('tickets.toast.resolved'), 'success')
    fcNext()
  } catch { showToast(t('error.generic'), 'error') }
}
function fcNext() {
  const next = queueNext(_tk.id)
  const q = readQueue()
  if (next) navigateTo(`/tickets/${next}`)
  else navigateTo(q?.from === 'today' ? '/today' : '/tickets')
}

// ── Tiroir Détails ──────────────────────────────────────────────────────────

async function fcOpenDetails() {
  const d = document.getElementById('fc-details'); if (!d) return
  if (!_allTags.length) { try { _allTags = await window.api.getTags() } catch {} }
  const tk = _tk
  d.innerHTML = `
    <div class="details-head"><span>${esc(t('tickets.focus.details'))}</span><span style="flex:1"></span><button class="btn btn-sm btn-ghost" onclick="fcCloseDetails()"><i class="ti ti-x"></i></button></div>
    <div class="details-body">
      <div class="info-section">
        <div class="info-section-title"><span>${t('tickets.info.related_users')}</span><button class="btn btn-sm btn-ghost" onclick="fcCloseDetails();fcRequesterMenu()"><i class="ti ti-plus"></i></button></div>
        ${(tk.related_users || []).length ? tk.related_users.map(u => `<div class="info-item"><div class="main"><a href="#/users/${esc(u.entra_id)}">${esc(u.display_name || u.entra_id)}</a>${u.role === 'requester' ? `<span class="badge badge-green" style="font-size:9px">${esc(t('tickets.role.requester'))}</span>` : ''}</div>${u.email ? `<span class="sub">${esc(u.email)}</span>` : ''}<button class="rm" onclick="fcRemoveUser(${jsArg(u.entra_id)})"><i class="ti ti-x"></i></button></div>`).join('') : `<span class="info-empty">${t('tickets.no_requester')}</span>`}
      </div>
      ${window.OPALE.moduleEnabled('inventory') ? `<div class="info-section">
        <div class="info-section-title"><span>${t('tickets.info.related_devices')}</span><button class="btn btn-sm btn-ghost" onclick="fcCloseDetails();fcDeviceMenu()"><i class="ti ti-plus"></i></button></div>
        ${(tk.related_devices || []).length ? tk.related_devices.map(dv => `<div class="info-item"><div class="main"><a href="#/postes/${esc(dv.id)}">${esc(dv.hostname || dv.id)}</a></div><button class="rm" onclick="fcRemoveDevice('${dv.id}')"><i class="ti ti-x"></i></button></div>`).join('') : `<span class="info-empty">${t('tickets.no_device')}</span>`}
      </div>` : ''}
      <div class="info-section">
        <div class="info-section-title"><span>${t('tickets.info.tags')}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">${(tk.tags || []).map(g => tagChip(g, { onRemove: `fcRemoveTag('${g.id}')` })).join('') || `<span class="info-empty">${t('tickets.no_tags')}</span>`}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${_allTags.filter(g => !(tk.tags || []).some(x => x.id === g.id)).map(g => `<span style="cursor:pointer;opacity:.7" onclick="fcAddTag('${g.id}')">${tagChip(g, { compact: true })}</span>`).join('')}</div>
      </div>
      <div class="info-section">
        <div class="info-section-title"><span>${t('tickets.info.attachments')}</span><button class="btn btn-sm btn-ghost" onclick="document.getElementById('fc-att').click()"><i class="ti ti-paperclip"></i></button></div>
        <input type="file" id="fc-att" style="display:none" onchange="fcUpload(this)">
        ${(tk.attachments || []).length ? tk.attachments.map(a => `<div class="info-item"><div class="main" style="cursor:pointer" data-fn="${esc(a.filename)}" onclick="fcDownload('${a.id}', this.dataset.fn)"><i class="ti ti-paperclip" style="color:var(--text-tertiary)"></i><a>${esc(a.filename)}</a></div><button class="rm" onclick="fcRemoveAttachment('${a.id}')"><i class="ti ti-x"></i></button></div>`).join('') : `<span class="info-empty">${t('tickets.attachments.none')}</span>`}
      </div>
      <div class="info-section">
        <div class="info-section-title"><span>${t('tickets.description')}</span><button class="btn btn-sm btn-ghost" onclick="fcEditDescription()"><i class="ti ti-pencil"></i></button></div>
        <div style="font-size:12.5px;white-space:pre-wrap;color:var(--text-secondary)">${esc(cleanLegacyHtml(tk.description || '')) || `<span class="info-empty">${t('tickets.description.add')}</span>`}</div>
      </div>
      <div class="info-section">
        <div class="info-section-title"><span>${t('tickets.info.details')}</span></div>
        <div class="info-row"><span class="label">${t('tickets.info.ref')}</span><span class="value" style="font-family:var(--font-mono)">#${ticketRef(tk.id)}</span></div>
        <div class="info-row"><span class="label">${t('tickets.info.created')}</span><span class="value">${whenHtml(tk.created_at)}</span></div>
        ${tk.created_by_name ? `<div class="info-row"><span class="label">${t('tickets.info.by')}</span><span class="value">${esc(tk.created_by_name)}</span></div>` : ''}
        ${tk.updated_at ? `<div class="info-row"><span class="label">${t('tickets.info.updated')}</span><span class="value">${whenHtml(tk.updated_at)}</span></div>` : ''}
        ${tk.has_inbound_mail ? `<div class="info-row"><span class="label">${t('tickets.info.mails')}</span><span class="value">${tk.inbound_mail_count || 0} ↓ · ${tk.outbound_mail_count || 0} ↑</span></div>` : ''}
      </div>
      <div class="info-section">
        <button class="btn btn-sm" onclick="fcMerge()"><i class="ti ti-arrows-join"></i> ${esc(t('tickets.merge.action'))}</button>
      </div>
    </div>`
  d.classList.add('open')
  setTimeout(() => document.addEventListener('click', detailsOutside, true), 0)
}
function detailsOutside(e) {
  const d = document.getElementById('fc-details')
  if (!d || !d.classList.contains('open')) { document.removeEventListener('click', detailsOutside, true); return }
  if (d.contains(e.target) || e.target.closest('#modal-overlay')) return
  fcCloseDetails()
}
function fcCloseDetails() { document.getElementById('fc-details')?.classList.remove('open'); document.removeEventListener('click', detailsOutside, true) }
async function fcRemoveUser(id) { if (!confirm(t('tickets.related_users.confirm_remove'))) return; try { await window.api.removeTicketUser(_tk.id, id); await reload(); fcOpenDetails() } catch { showToast(t('error.generic'), 'error') } }
async function fcRemoveDevice(id) { if (!confirm(t('tickets.related_devices.confirm_remove'))) return; try { await window.api.removeTicketDevice(_tk.id, id); await reload(); fcOpenDetails() } catch { showToast(t('error.generic'), 'error') } }
async function fcAddTag(id) { try { await window.api.addTicketTag(_tk.id, id); await reload(); fcOpenDetails() } catch { showToast(t('error.generic'), 'error') } }
async function fcRemoveTag(id) { try { await window.api.removeTicketTag(_tk.id, id); await reload(); fcOpenDetails() } catch { showToast(t('error.generic'), 'error') } }
async function fcUpload(input) { const f = input?.files?.[0]; if (!f) return; try { await window.api.uploadAttachment(_tk.id, f); input.value = ''; await reload(); fcOpenDetails(); showToast(t('tickets.attachments.uploaded'), 'success') } catch (err) { showToast(err?.status === 413 ? t('tickets.attachments.too_large') : (err?.body?.error || t('error.generic')), 'error') } }
async function fcDownload(id, fn) { try { await window.api.downloadAttachment(_tk.id, id, fn) } catch { showToast(t('error.generic'), 'error') } }
async function fcRemoveAttachment(id) { if (!confirm(t('tickets.attachments.confirm_remove'))) return; try { await window.api.deleteAttachment(_tk.id, id); await reload(); fcOpenDetails() } catch { showToast(t('error.generic'), 'error') } }
function fcMerge() {
  fcCloseDetails()
  ticketPicker(t('tickets.merge.modal_title'), t('tickets.merge.modal_help'), _tk.id, async (target) => {
    if (!confirm(t('tickets.merge.confirm').replace('{source}', _tk.title).replace('{target}', target.title))) return
    try { await window.api.mergeTicket(_tk.id, target.id); showToast(t('tickets.merge.success'), 'success'); navigateTo(`/tickets/${target.id}`) }
    catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
  })
}
function ticketPicker(title, help, excludeId, onPick) {
  showModal(`<div class="modal-title">${esc(title)}</div><div class="modal-sub">${esc(help)}</div><input class="form-input" id="fc-tq" placeholder="${esc(t('tickets.merge.search'))}" autocomplete="off"><div class="pick-list" id="fc-tr" style="margin-top:8px"></div><div class="modal-footer"><button class="btn" onclick="closeModal()">${t('btn.cancel')}</button></div>`)
  const input = document.getElementById('fc-tq'); const list = document.getElementById('fc-tr')
  setTimeout(() => input?.focus(), 50)
  const search = async () => {
    const q = input.value.trim(); const params = { limit: 30 }; if (q) params.q = q
    let tickets = []
    try { const [live, arch] = await Promise.all([window.api.getTickets(params), q ? window.api.getTickets({ ...params, status: 'closed', limit: 10 }).catch(() => []) : Promise.resolve([])]); tickets = [...live, ...arch] } catch {}
    tickets = tickets.filter(tk => tk.id !== excludeId && tk.status !== 'merged')
    window.__fcTickets = tickets
    list.innerHTML = tickets.length ? tickets.map((tk, i) => `<div class="pick-row" onclick="window.__fcPickTicket(${i})"><div class="t">${esc(tk.title)}</div><div class="s">#${ticketRef(tk.id)} · ${statusLabel(tk.status)}${tk.requester_name ? ' · ' + esc(tk.requester_name) : ''}</div></div>`).join('') : `<div class="pick-row"><div class="s">${t('tickets.merge.no_match')}</div></div>`
  }
  let timer; input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250) }); search()
  window.__fcPickTicket = (i) => { closeModal(); onPick(window.__fcTickets[i]) }
}

// ═══════════════════════════════════════════════════════════════════════════
// Fil de mails pas encore ticket
// ═══════════════════════════════════════════════════════════════════════════

let _mail = null   // { mapping, items, priority }

export async function renderMailFocus(container, mappingId) {
  _container = container
  container.innerHTML = `<div class="focus"><div class="ticket-detail-empty"><i class="ti ti-loader-2" style="font-size:24px;animation:spin 1s linear infinite"></i></div></div>`
  bindGlobals()
  let items = [], mapping = null
  try {
    const inbox = await window.api.getInbox({ limit: 500 })
    mapping = inbox.find(m => m.id === mappingId) || null
    items = await window.api.getInboxThread(mappingId)
  } catch {}
  if (!mapping) {
    container.innerHTML = `<div class="focus"><div class="ticket-detail-empty"><i class="ti ti-mail-check" style="font-size:32px"></i><span>${esc(t('tickets.mailfocus.gone'))}</span><a href="#/tickets?folder=inbox">${esc(t('tickets.folder.inbox'))}</a></div></div>`
    return
  }
  _mail = { mapping, items, priority: 'normal' }
  renderMail()
  // Corps complets en arrière-plan.
  await Promise.all(items.map(async it => {
    try {
      const b = await window.api.getInboxBody(it.id)
      const el = document.getElementById(`mf-body-${it.id}`)
      if (el) { el.textContent = b.body_text || it.body_preview || t('tickets.inbox.empty_body'); el.classList.remove('loading'); if (b.source === 'preview') el.insertAdjacentHTML('beforeend', `<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);font-style:italic">${esc(t('tickets.inbox.preview_only'))}</div>`) }
    } catch { document.getElementById(`mf-body-${it.id}`)?.classList.remove('loading') }
  }))
}

function cleanSubject(s) { return String(s || '').replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim() || t('tickets.inbox.no_subject') }

function renderMail() {
  const { mapping: m, items, priority } = _mail
  const n = Math.max(items.length, m.thread_count || 1)
  const draft = document.getElementById('fc-input')?.value || ''
  _container.innerHTML = `
    <div class="focus">
      <div class="focus-top">
        <a href="#/tickets?folder=inbox">← ${esc(t('tickets.folder.inbox'))}</a><span>/</span>
        <span>${esc(t('tickets.mailfocus.kicker', { n, who: m.from_name || m.from_address || '?' }))}</span>
        <span class="right">
          <button class="btn btn-sm btn-ghost" onclick="mfDismiss(${n > 1 ? 'true' : 'false'})" title="${esc(t('tickets.inbox.dismiss'))}"><i class="ti ti-eye-off"></i> ${esc(n > 1 ? t('tickets.inbox.dismiss_thread') : t('tickets.inbox.dismiss'))}</button>
          <button class="btn btn-sm" onclick="mfAttach()"><i class="ti ti-arrows-join"></i> ${esc(t('tickets.inbox.attach'))}</button>
          <button class="btn btn-sm btn-primary" id="mf-create" onclick="mfToTicket()"><i class="ti ti-ticket"></i> ${esc(n > 1 ? t('tickets.inbox.to_ticket_n', { n }) : t('tickets.inbox.to_ticket'))}</button>
        </span>
      </div>
      <div class="focus-head">
        <h1 class="focus-title" style="cursor:default">${esc(cleanSubject(m.subject))}</h1>
        <div class="props">
          <div class="prop static"><div class="k">${esc(t('tickets.focus.prop.next'))}</div><div class="v needs"><span class="dotv"></span>${esc(t('tickets.mailfocus.decide'))}</div><div class="s">${esc(t('tickets.mailfocus.decide_sub'))}</div></div>
          <button class="prop" onclick="mfSetPriority()"><div class="k">${esc(t('tickets.new.priority'))}</div><div class="v ${priority === 'critical' ? 'crit' : priority === 'high' ? 'needs' : ''}">${esc(prioLabel(priority))} <i class="ti ti-chevron-down" style="font-size:11px;opacity:.6"></i></div><div class="s">${esc(t('tickets.mailfocus.carried'))}</div></button>
          <div class="prop static"><div class="k">${esc(t('tickets.info.assignee'))}</div><div class="v dim">${esc(t('tickets.unassigned'))}</div><div class="s">${esc(t('tickets.mailfocus.assign_after'))}</div></div>
          <div class="prop static"><div class="k">${esc(t('tickets.info.requester'))}</div>
            ${m.suggested_user_name ? `<div class="v"><span class="av">${esc(initialsOf(m.suggested_user_name))}</span>${esc(m.suggested_user_name)}</div><div class="s">${esc([m.from_address, m.suggested_device_hostname].filter(Boolean).join(' · '))}</div>` : `<div class="v dim">${esc(m.from_name || m.from_address || '?')}</div><div class="s">${esc(t('tickets.inbox.external'))}</div>`}
          </div>
        </div>
        ${n > 1 ? `<div class="mail-note"><i class="ti ti-messages"></i><span>${esc(t('tickets.inbox.thread_hint', { n }))}</span></div>` : ''}
      </div>
      <div class="focus-body" id="fc-body">
        <div class="focus-conv">
          ${items.map(it => `
            <div class="mailcard ${it.direction === 'outbound' ? 'out' : ''}">
              <div class="mh"><span class="av ${it.direction === 'outbound' ? '' : 'req'}" style="width:24px;height:24px;border-radius:12px;background:${it.direction === 'outbound' ? 'var(--blue)' : 'var(--green)'};color:#fff;font-size:10px;font-weight:600;display:inline-flex;align-items:center;justify-content:center">${esc(initialsOf(it.from_name || it.from_address))}</span><b>${esc(it.from_name || it.from_address || '?')}</b>${it.from_name && it.from_address ? `<span class="addr">&lt;${esc(it.from_address)}&gt;</span>` : ''}${it.action === 'skipped_other' ? `<span class="badge badge-gray">${esc(t('tickets.inbox.was_dismissed'))}</span>` : ''}${it.has_attachments ? `<span class="badge badge-gray"><i class="ti ti-paperclip"></i></span>` : ''}<span class="when" title="${esc(fmtDateFull(it.received_at))}">${esc(fmtDateShort(it.received_at))}</span></div>
              <div class="mb loading" id="mf-body-${it.id}">${esc(it.body_preview || '')}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="focus-composer">
        <div class="focus-composer-inner">
          <div class="composer-modes"><span class="composer-mode active"><i class="ti ti-mail-forward"></i> ${esc(t('tickets.focus.reply_to', { who: shortName(m.suggested_user_name || m.from_name) || m.from_address || '?' }))}</span><span class="composer-hint">${esc(t('tickets.mailfocus.reply_hint'))}</span></div>
          <textarea class="composer-input" id="fc-input" placeholder="${esc(t('tickets.composer.mail_placeholder'))}" onkeydown="if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();mfReplyCreate()}">${esc(draft)}</textarea>
          <div class="composer-actions"><span style="flex:1"></span><span style="font-size:12px;color:var(--text-tertiary)">⌘/Ctrl ↵</span><button class="btn btn-primary" id="mf-reply" onclick="mfReplyCreate()"><i class="ti ti-send"></i> ${esc(t('tickets.mailfocus.reply_create'))}</button></div>
        </div>
      </div>
    </div>`
}

function mfSetPriority() {
  menu(t('tickets.priority.picker_title'), [['critical', 'var(--red)'], ['high', 'var(--amber)'], ['normal', '#0d9488'], ['low', 'var(--text-tertiary)']].map(([v, c]) =>
    `<button class="btn ${v === _mail.priority ? 'btn-primary' : ''}" style="justify-content:flex-start;border-left:4px solid ${c}" onclick="closeModal();window.__mfPrio('${v}')">${esc(prioLabel(v))}</button>`).join(''))
  window.__mfPrio = (v) => { _mail.priority = v; renderMail() }
}
async function createFromMail() {
  const { ticket, absorbed } = await window.api.inboxToTicket(_mail.mapping.id)
  if (_mail.priority !== 'normal') { try { await window.api.updateTicket(ticket.id, { priority: _mail.priority }) } catch {} }
  showToast(absorbed > 1 ? t('tickets.inbox.ticket_created_n', { n: absorbed }) : t('tickets.inbox.ticket_created'), 'success')
  return ticket
}
async function mfToTicket() {
  const b = document.getElementById('mf-create'); if (b) b.disabled = true
  try { const tk = await createFromMail(); navigateTo(`/tickets/${tk.id}`) }
  catch (err) { if (b) b.disabled = false; showToast(err?.body?.error || t('error.generic'), 'error') }
}
// Répondre crée le ticket ET envoie la réponse dans le même fil.
async function mfReplyCreate() {
  const input = document.getElementById('fc-input'); const content = input?.value?.trim()
  if (!content) { input?.focus(); return }
  const b = document.getElementById('mf-reply'); if (b) b.disabled = true
  try {
    const tk = await createFromMail()
    const msg = await window.api.addMessage(tk.id, { content })
    await window.api.sendMessageByMail(tk.id, msg.id)
    showToast(t('tickets.toast.mail_queued'), 'success')
    navigateTo(`/tickets/${tk.id}`)
  } catch (err) { if (b) b.disabled = false; showToast(err?.body?.error || t('error.generic'), 'error') }
}
function mfAttach() {
  ticketPicker(t('tickets.inbox.attach_title'), t('tickets.inbox.attach_help'), null, async (target) => {
    try {
      const out = await window.api.inboxAttach(_mail.mapping.id, target.id)
      showToast(t('tickets.inbox.attached', { n: out.appended }), 'success')
      navigateTo(`/tickets/${target.id}`)
    } catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
  })
}
async function mfDismiss(whole) {
  if (!confirm(whole ? t('tickets.inbox.confirm_dismiss_thread') : t('tickets.inbox.confirm_dismiss'))) return
  try { await window.api.inboxDismiss(_mail.mapping.id, whole); navigateTo('/tickets?folder=inbox') }
  catch (err) { showToast(err?.body?.error || t('error.generic'), 'error') }
}
