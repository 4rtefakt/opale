// Page focus ticket (mobile) — UN ticket, rien d'autre. En haut : le titre
// (toucher pour renommer), l'état lisible et la file « x sur n ». Puis quatre
// faits (demandeur, poste, assigné, prochaine étape), la description repliée,
// la conversation, et en bas une seule action évidente (« Terminé & suivant »)
// au-dessus du composer note / réponse par mail. Le reste (personnes, postes,
// tags, pièces jointes, lien) vit dans le menu ⋮.

import {
  shortName, initialsOf, ticketRef, statusLabel, prioLabel, nextLabel, dayLabel, dayKey,
  cleanLegacyHtml, queueNext, queuePosition, TAG_PALETTE, TAG_COLOR_KEYS,
} from '/views/ticket-shared.js'

let _tk = null
let _allTags = []  // cache local des tags du référentiel
let _aiBusy = false
let _container = null

// jsArg() fourni globalement par mobile-app.js (window.jsArg) — pour passer
// une string user-controlled en argument d'un onclick="fn('…')" inline.
const mJsArg = window.jsArg
// Couleur de fond par nom de couleur de tag (TAG_PALETTE porte { bg, fg }).
const M_TK_TAG_PALETTE = Object.fromEntries(Object.entries(TAG_PALETTE).map(([k, v]) => [k, v.bg]))
const M_TK_TAG_COLOR_KEYS = TAG_COLOR_KEYS

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

export async function renderTicket(el, id) {
  _container = el
  const pos = queuePosition(id)
  const backHash = pos?.from === 'today' ? '#/today' : '#/tickets'
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn ghost" onclick="window.location.hash='${backHash}'" title="${esc(t('tickets.focus.back'))}"><i class="ti ti-arrow-left"></i></button>
      <h1 id="m-tk-title" onclick="mEditTitle()" title="${esc(t('mobile.ticket.menu.edit_title'))}"
          style="font-size:16px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.25">…</h1>
      <button class="m-icon-btn" id="m-tk-menu-btn" onclick="mTicketMenu()" title="${esc(t('tickets.focus.details'))}"><i class="ti ti-dots-vertical"></i></button>
    </div>
    <div class="m-focus-bar" id="m-tk-bar"></div>
    <div id="m-tk-thread" class="m-scroll" style="padding-top:0;gap:0">
      <div class="m-loading-row"><div class="m-spinner"></div></div>
    </div>
    <div class="m-actionrow" id="m-tk-actions" style="display:none"></div>
    <div id="m-tk-reply-bar" class="m-reply-bar" style="display:none">
      <button class="m-send-btn mode" id="m-reply-mode-btn" onclick="mToggleReplyMode()" title="${esc(t('mobile.ticket.reply_mode_hint'))}"><i class="ti ti-note"></i></button>
      <textarea class="m-reply-input" id="m-reply-txt" rows="1" placeholder="${esc(t('mobile.ticket.reply_placeholder'))}"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
      <button class="m-send-btn ai" id="m-ai-btn" onclick="mAiSuggest()" title="${esc(t('mobile.ticket.ai.suggest'))}"><i class="ti ti-sparkles"></i></button>
      <button class="m-send-btn" id="m-send-btn" onclick="mSendReply(this)"><i class="ti ti-send"></i></button>
    </div>`

  Object.assign(window, {
    mSendReply, mToggleReplyMode, mEditDescription, mCopyLink, mTicketMenu, mCloseSheetThen,
    mChangePriority, mEditTitle, mOpenTags, mToggleTag, mPickTagColor, mCreateTag, mAssignSelf, mUnassign,
    mAiSuggest, mUseSuggestion, mDeleteSuggestion, mSendMsgByMail, mRetrySend, mOpenAssignee, mOpenPeople,
    mOpenDevices, mOpenAttachments, mStatusMenu, mSetStatus, mDoneNext, mFocusComposer,
  })

  try {
    const tk = await window.api.getTicket(id)
    if (tk.merged_into) { window.showToast(t('tickets.merge.redirected').replace('{target}', ticketRef(tk.merged_into)), 'info'); window.location.hash = `#/ticket/${tk.merged_into}`; return }
    _tk = tk
    if (!_tk.has_inbound_mail) _replyMode = 'note'
    renderTicketBody()
  } catch (err) {
    document.getElementById('m-tk-thread').innerHTML = mErrorBox(err?.status === 404 ? t('tickets.focus.not_found') : err.message, () => renderTicket(el, id))
  }
}

function renderTicketBody() {
  const tk = _tk
  const me = window.appState?.user
  const nx = nextLabel(tk)
  const pos = queuePosition(tk.id)
  const resolved = tk.status === 'resolved'
  const closed   = tk.status === 'closed'
  const devCount = (tk.related_devices || []).length
  const peopleCount = (tk.related_users || []).length
  const attCount = (tk.attachments || []).length

  document.getElementById('m-tk-title').textContent = tk.title

  const pillCls = nx.cls === 'needs' ? 'm-pill-needs' : nx.cls === 'crit' ? 'm-pill-crit' : nx.cls === 'done' ? 'm-pill-on' : 'm-pill-off'
  const bar = document.getElementById('m-tk-bar')
  if (bar) bar.innerHTML = `
    <button class="m-pill ${pillCls}" onclick="mStatusMenu()">${esc(nx.label)} <i class="ti ti-chevron-down" style="font-size:11px"></i></button>
    <button class="m-pill ${tk.priority === 'critical' ? 'm-pill-crit' : tk.priority === 'high' ? 'm-pill-warn' : 'm-pill-off'}" onclick="mChangePriority()"><i class="ti ti-flag" style="font-size:11px"></i> ${esc(prioLabel(tk.priority))}</button>
    ${tk.has_inbound_mail ? `<span class="m-pill m-pill-info"><i class="ti ti-mail" style="font-size:11px"></i> ${esc(t('mobile.ticket.via_mail', { n: tk.inbound_mail_count || 0 }))}</span>` : ''}
    <span class="m-queue">${pos ? esc(t('tickets.focus.queue', { i: pos.index, n: pos.total })) : `#${ticketRef(tk.id)}`}</span>`

  // Conversation avec séparateurs de jour.
  let lastDay = ''
  const conv = (tk.messages || []).map(m => {
    const k = dayKey(m.created_at)
    const sep = k && k !== lastDay ? `<div class="m-day">${esc(dayLabel(m.created_at))}</div>` : ''
    lastDay = k || lastDay
    return sep + renderMsg(m)
  }).join('')

  const thread = document.getElementById('m-tk-thread')
  thread.innerHTML = `
    <div class="m-facts" style="padding:4px 0 8px">
      <button class="m-fact" onclick="mOpenPeople()">
        <span class="k">${esc(t('tickets.info.requester'))}${peopleCount > 1 ? ` +${peopleCount - 1}` : ''}</span>
        <span class="v ${tk.requester_name ? '' : 'empty'}"><i class="ti ti-user"></i>${esc(tk.requester_name || t('tickets.no_requester'))}</span>
      </button>
      <button class="m-fact" onclick="mOpenDevices()">
        <span class="k">${esc(t('tickets.info.device'))}${devCount > 1 ? ` +${devCount - 1}` : ''}</span>
        <span class="v ${tk.hostname ? '' : 'empty'}"><i class="ti ti-device-laptop"></i>${esc(tk.hostname || t('tickets.no_device'))}</span>
      </button>
      <button class="m-fact" onclick="${tk.assigned_to_entra_id ? 'mOpenAssignee()' : 'mAssignSelf(this)'}">
        <span class="k">${esc(t('tickets.info.assignee'))}</span>
        <span class="v ${tk.assigned_to_name ? '' : ''}" ${tk.assigned_to_name ? '' : 'style="color:var(--blue-text)"'}><i class="ti ti-user-check"></i>${esc(tk.assigned_to_name ? (tk.assigned_to_entra_id === me?.entraId ? t('today.why.you') : shortName(tk.assigned_to_name)) : t('tickets.assign_self'))}</span>
      </button>
      <button class="m-fact" onclick="mOpenTags()">
        <span class="k">${esc(t('tickets.info.tags'))}</span>
        <span class="v ${(tk.tags || []).length ? '' : 'empty'}">${(tk.tags || []).length
          ? tk.tags.slice(0, 3).map(g => `<span class="m-ticket-tag" style="background:${M_TK_TAG_PALETTE[g.color] || M_TK_TAG_PALETTE.slate}">${esc(g.name)}</span>`).join('')
          : `<i class="ti ti-tag"></i>${esc(t('mobile.ticket.tags.add_short'))}`}</span>
      </button>
    </div>
    <details class="m-details" style="margin-bottom:10px" ${tk.description && (tk.messages || []).length <= 1 ? 'open' : ''}>
      <summary><i class="ti ti-align-left"></i> ${esc(t('mobile.ticket.description'))}${tk.description ? '' : ` <span class="n">— ${esc(t('mobile.ticket.description_none'))}</span>`}
        <span class="m-icon-btn ghost sm" style="margin-left:auto" onclick="event.preventDefault();mEditDescription()"><i class="ti ti-pencil"></i></span><i class="ti ti-chevron-down chev" style="margin-left:0"></i></summary>
      <div class="body">${tk.description ? esc(cleanLegacyHtml(tk.description)) : `<span class="m-muted">${esc(t('mobile.ticket.description_empty'))}</span>`}</div>
    </details>
    ${attCount ? `<button class="m-row" style="border:0.5px solid var(--border);border-radius:var(--radius-sm);margin-bottom:10px;background:var(--bg-secondary)" onclick="mOpenAttachments()"><i class="ti ti-paperclip"></i><span class="main"><span class="ttl">${esc(t('mobile.ticket.menu.attachments'))}</span></span><span class="end">${attCount} <i class="ti ti-chevron-right chev"></i></span></button>` : ''}
    <div id="m-tk-msgs" style="display:flex;flex-direction:column;gap:2px;margin:0 -16px;padding-bottom:8px">
      ${conv || `<div class="m-empty" style="padding:20px"><span>${esc(t('tickets.msg.none'))}</span></div>`}
    </div>`

  // Une action évidente en bas : Terminé (& suivant) ; sur un résolu : rouvrir /
  // archiver ; sur une archive : désarchiver.
  const actions = document.getElementById('m-tk-actions')
  if (actions) {
    actions.style.display = 'flex'
    actions.innerHTML = closed
      ? `<button class="m-btn" onclick="mSetStatus('resolved', this)"><i class="ti ti-archive-off"></i> ${esc(t('tickets.unarchive'))}</button>`
      : resolved
        ? `<button class="m-btn" onclick="mSetStatus('open', this)"><i class="ti ti-refresh"></i> ${esc(t('tickets.reopen'))}</button>
           <button class="m-btn" onclick="mSetStatus('closed', this)"><i class="ti ti-archive"></i> ${esc(t('tickets.archive'))}</button>`
        : `${nx.key === 'needs' ? `<button class="m-btn needs" onclick="mFocusComposer('mail')"><i class="ti ti-mail-forward"></i> ${esc(t('today.act.reply'))}</button>` : ''}
           <button class="m-btn ${nx.key === 'needs' ? '' : 'primary'}" onclick="mDoneNext(this)" title="${esc(t('tickets.focus.done_hint'))}"><i class="ti ti-check"></i> ${esc(pos && pos.total > 1 ? t('tickets.focus.done_next') : t('tickets.focus.done'))}</button>`
  }

  const replyBar = document.getElementById('m-tk-reply-bar')
  if (replyBar) replyBar.style.display = closed ? 'none' : 'flex'
  paintReplyMode()

  // Le dernier message est ce qu'on lit en premier ; les faits sont un geste plus haut.
  thread.scrollTop = thread.scrollHeight
}

function isInbound(m) {
  if (m.type !== 'comment') return false
  const tk = _tk
  if ((tk?.mail_authors || []).includes(m.author)) return true
  if (tk?.requester_name && m.author === tk.requester_name) return true
  return /@/.test(m.author || '') || m.author === 'Email'
}

function renderMsg(m) {
  if (m.type === 'system' || m.type === 'resolution') {
    return `<div class="m-msg-sys"><span>${esc(m.content)} · ${esc(formatRelative(m.created_at))}</span></div>`
  }

  // Brouillon IA : bulle distincte (jamais envoyée par mail). Actions :
  // reprendre dans le composer pour éditer/envoyer, ou supprimer.
  if (m.type === 'ai_suggestion') {
    return `
    <div class="m-msg">
      <div class="m-av" style="width:28px;height:28px;font-size:11px;background:var(--purple-bg);color:var(--purple)"><i class="ti ti-sparkles" style="font-size:14px"></i></div>
      <div class="m-msg-bubble m-msg-bubble-ai">
        <div class="m-msg-author" style="color:var(--purple)">${esc(t('mobile.ticket.ai.badge'))} · ${esc(t('tickets.focus.ai_draft'))}</div>
        <div class="m-msg-content">${esc(m.content)}</div>
        <div class="m-msg-actions">
          <button class="m-pill m-pill-off" data-content="${esc(m.content)}" onclick="mUseSuggestion(this)"><i class="ti ti-corner-up-left" style="font-size:11px"></i> ${esc(t('mobile.ticket.ai.use'))}</button>
          <button class="m-pill m-pill-off" style="color:var(--text-tertiary)" onclick="mDeleteSuggestion('${esc(m.id)}',this)"><i class="ti ti-x" style="font-size:11px"></i> ${esc(t('mobile.ticket.ai.discard'))}</button>
        </div>
        <div class="m-msg-time">${esc(formatRelative(m.created_at))}</div>
      </div>
    </div>`
  }

  const isMe = m.author === window.appState?.user?.displayName
  const inbound = !isMe && isInbound(m)

  let badge = '', action = ''
  if (m.type === 'internal_note') {
    badge = `<span class="m-msg-badge" style="background:var(--amber-bg);color:var(--amber)"><i class="ti ti-lock" style="font-size:10px"></i> ${esc(t('mobile.ticket.msg.internal'))}</span>`
    if (_tk?.has_inbound_mail) action = `<button class="m-pill m-pill-off" onclick="mSendMsgByMail('${esc(m.id)}',this)"><i class="ti ti-mail-forward" style="font-size:11px"></i> ${esc(t('mobile.ticket.msg.send_by_mail'))}</button>`
  } else if (inbound) {
    badge = `<span class="m-msg-badge" style="background:var(--primary-bg);color:var(--blue-text)"><i class="ti ti-mail-down" style="font-size:10px"></i> ${esc(t('mobile.ticket.msg.received_by_mail'))}</span>`
  } else if (m.type === 'comment' && m.outbound_failed_at) {
    badge = `<span class="m-msg-badge" style="background:var(--red-bg);color:var(--red)" title="${esc(m.outbound_error || '')}"><i class="ti ti-mail-x" style="font-size:10px"></i> ${esc(t('mobile.ticket.msg.send_failed'))}</span>`
    action = `<button class="m-pill m-pill-off" onclick="mRetrySend('${esc(m.id)}',this)"><i class="ti ti-refresh" style="font-size:11px"></i> ${esc(t('mobile.ticket.msg.retry_send'))}</button>`
  } else if (m.type === 'comment' && !m.email_sent_at) {
    badge = `<span class="m-msg-badge" style="background:var(--amber-bg);color:var(--amber)"><i class="ti ti-mail-fast" style="font-size:10px"></i> ${esc(t('mobile.ticket.msg.sending'))}</span>`
  } else if (m.type === 'comment' && m.email_sent_at) {
    badge = `<span class="m-msg-badge" style="background:var(--green-bg);color:var(--green)"><i class="ti ti-mail-check" style="font-size:10px"></i> ${esc(t('mobile.ticket.msg.sent_by_mail'))}</span>`
  }

  return `
  <div class="m-msg ${isMe ? 'm-msg-me' : ''}">
    ${!isMe ? `<div class="m-av" style="width:28px;height:28px;font-size:11px${inbound ? ';background:var(--green)' : ''}">${esc(initialsOf(m.author))}</div>` : ''}
    <div class="m-msg-bubble ${isMe ? 'm-msg-bubble-me' : ''} ${inbound ? 'm-msg-bubble-in' : ''} ${m.type === 'internal_note' ? 'm-msg-bubble-note' : ''}">
      ${!isMe ? `<div class="m-msg-author">${esc(m.author)}</div>` : ''}
      <div class="m-msg-content">${esc(m.content)}</div>
      ${badge || action ? `<div class="m-msg-actions">${badge}${action}</div>` : ''}
      <div class="m-msg-time">${esc(formatRelative(m.created_at))}</div>
    </div>
  </div>`
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function reload() {
  _tk = await window.api.getTicket(_tk.id)
  renderTicketBody()
}

// Mode du composer : 'note' (interne, défaut) ou 'mail' (réponse au
// demandeur dans le fil mail). Mémorisé pour la session.
let _replyMode = 'note'
function paintReplyMode() {
  const canMail = !!_tk?.has_inbound_mail
  if (!canMail) _replyMode = 'note'
  const btn = document.getElementById('m-reply-mode-btn')
  const input = document.getElementById('m-reply-txt')
  const send = document.getElementById('m-send-btn')
  if (btn) {
    btn.style.display = canMail ? 'flex' : 'none'
    btn.classList.toggle('mail', _replyMode === 'mail')
    btn.innerHTML = _replyMode === 'mail' ? '<i class="ti ti-mail-forward"></i>' : '<i class="ti ti-lock"></i>'
  }
  if (input) input.placeholder = _replyMode === 'mail' ? t('mobile.ticket.reply_placeholder_mail') : t('mobile.ticket.reply_placeholder')
  if (send) send.innerHTML = _replyMode === 'mail' ? '<i class="ti ti-send"></i>' : '<i class="ti ti-note"></i>'
}
function mToggleReplyMode() {
  _replyMode = _replyMode === 'mail' ? 'note' : 'mail'
  paintReplyMode()
  window.showToast(_replyMode === 'mail' ? t('mobile.ticket.reply_mode_mail') : t('mobile.ticket.reply_mode_note'), 'info')
}
// « Répondre » : bascule le composer en mode mail et lui donne le focus.
function mFocusComposer(mode) {
  if (mode === 'mail' && _tk?.has_inbound_mail) _replyMode = 'mail'
  paintReplyMode()
  document.getElementById('m-reply-txt')?.focus()
}

async function mSendReply(btn) {
  const input   = document.getElementById('m-reply-txt')
  const content = input?.value?.trim()
  if (!content) return
  const mail = _replyMode === 'mail' && _tk?.has_inbound_mail
  await withBusy(btn, async () => {
    try {
      const msg = mail
        ? await window.api.addMessage(_tk.id, { content })
        : await window.api.addMessage(_tk.id, { content, type: 'internal_note' })
      if (mail) await window.api.sendMessageByMail(_tk.id, msg.id)
      input.value = ''
      input.style.height = 'auto'
      await reload()
      window.showToast(mail ? t('tickets.toast.mail_queued') : t('tickets.toast.note_added'), 'success')
    } catch (err) { window.showToast(err?.body?.error || t('mobile.ticket.toast.error'), 'error') }
  })
}

// « Terminé » : résout, puis passe au suivant de la file s'il y en a un, sinon
// revient d'où l'on vient (Aujourd'hui ou la liste).
async function mDoneNext(btn) {
  const pos = queuePosition(_tk.id)
  await withBusy(btn, async () => {
    try {
      await window.api.updateTicket(_tk.id, { status: 'resolved' })
      window.showToast(t('tickets.toast.resolved'), 'success')
      // Ticket hors file (ouvert depuis une fiche poste, un lien…) : on reste ici.
      const next = pos ? queueNext(_tk.id) : null
      if (next) window.location.hash = `#/ticket/${next}`
      else if (pos) window.location.hash = pos.from === 'today' ? '#/today' : '#/tickets'
      else await reload()
    } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
  })
}

function mStatusMenu() {
  const tk = _tk
  const opts = [
    ['open',        'ti-circle',      t('tickets.status.open'),        t('tickets.focus.st.open_sub')],
    ['in_progress', 'ti-player-play', t('tickets.status.in_progress'), t('tickets.focus.st.progress_sub')],
    ['resolved',    'ti-check',       t('tickets.status.resolved'),    t('tickets.focus.st.resolved_sub')],
    ['closed',      'ti-archive',     t('tickets.status.closed'),      t('tickets.focus.st.closed_sub')],
  ]
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t('tickets.status.change'))}</div>
    <div style="padding:6px 0 0">
      ${opts.map(([val, icon, lbl, sub]) => `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('${val}'))">
        <i class="ti ${icon}" style="color:${tk.status === val ? 'var(--blue-text)' : 'var(--text-tertiary)'}"></i>
        <span style="flex:1;min-width:0"><div>${esc(lbl)}</div><div style="font-size:11.5px;color:var(--text-tertiary)">${esc(sub)}</div></span>
        ${tk.status === val ? '<i class="ti ti-check" style="color:var(--blue-text)"></i>' : ''}
      </button>`).join('')}
    </div>`)
}

function mEditDescription() {
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t('mobile.ticket.description'))}</div>
    <div style="padding:12px 0 0;display:flex;flex-direction:column;gap:12px">
      <textarea class="m-input" id="m-edit-desc" rows="7" style="resize:none">${esc(cleanLegacyHtml(_tk.description || ''))}</textarea>
      <button class="m-btn-primary" onclick="mSaveDescription(this)">${esc(t('mobile.ticket.save'))}</button>
    </div>`)
  setTimeout(() => document.getElementById('m-edit-desc')?.focus(), 100)
  window.mSaveDescription = async (btn) => {
    const description = document.getElementById('m-edit-desc')?.value ?? ''
    await withBusy(btn, async () => {
      try {
        await window.api.updateTicket(_tk.id, { description })
        window.mCloseSheet()
        await reload()
        window.showToast(t('mobile.ticket.toast.saved'), 'success')
      } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
    })
  }
}

async function mCopyLink() {
  const url = `${location.origin}/#/tickets/${_tk.id}`
  try { await navigator.clipboard.writeText(url); window.showToast(t('mobile.ticket.link_copied'), 'success') }
  catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
}

async function mSetStatus(status, btn) {
  await withBusy(btn, async () => {
    try {
      await window.api.updateTicket(_tk.id, { status })
      await reload()
      window.showToast(t('tickets.toast.status_set', { s: statusLabel(status) }), status === 'resolved' ? 'success' : 'info')
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
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
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
    <div style="padding:6px 0 0">
      <button class="m-menu-row" onclick="mCloseSheetThen(mStatusMenu)">
        <i class="ti ti-progress" style="color:var(--blue-text)"></i> ${t('tickets.status.change')}
        <span class="end">${esc(statusLabel(tk.status))}</span>
      </button>
      <div class="m-menu-sep"></div>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenAssignee)">
        <i class="ti ti-user-check" style="color:var(--blue-text)"></i> ${t('mobile.ticket.menu.assignee')}
        <span class="end">${tk.assigned_to_name ? esc(shortName(tk.assigned_to_name)) : t('mobile.ticket.assignee.none')}</span>
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenPeople)">
        <i class="ti ti-users" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.people')}
        ${peopleCount ? `<span class="end">${peopleCount}</span>` : ''}
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenDevices)">
        <i class="ti ti-device-laptop" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.devices')}
        ${devCount ? `<span class="end">${devCount}</span>` : ''}
      </button>

      <button class="m-menu-row" onclick="mCloseSheetThen(mOpenAttachments)">
        <i class="ti ti-paperclip" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.attachments')}
        ${attCount ? `<span class="end">${attCount}</span>` : ''}
      </button>

      <div class="m-menu-sep"></div>

      <button class="m-menu-row" onclick="mChangePriority()">
        <i class="ti ti-flag" style="color:${prioColor(tk.priority)}"></i> ${t('mobile.ticket.menu.priority')} — ${prioLabel(tk.priority)}
      </button>

      <button class="m-menu-row" onclick="mEditTitle()">
        <i class="ti ti-pencil" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.edit_title')}
      </button>
      <button class="m-menu-row" onclick="mCloseSheetThen(mEditDescription)">
        <i class="ti ti-align-left" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.edit_description')}
      </button>
      <button class="m-menu-row" onclick="mCloseSheetThen(mCopyLink)">
        <i class="ti ti-link" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.copy_link')}
      </button>
      ${tk.status === 'resolved' ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('closed'))">
        <i class="ti ti-archive" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.archive')}
      </button>` : ''}
      ${tk.status === 'closed' ? `
      <button class="m-menu-row" onclick="mCloseSheetThen(()=>mSetStatus('resolved'))">
        <i class="ti ti-archive-off" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.unarchive')}
      </button>` : ''}

      <button class="m-menu-row" onclick="mOpenTags()">
        <i class="ti ti-tag" style="color:var(--text-secondary)"></i> ${t('mobile.ticket.menu.tags')}
        ${(tk.tags || []).length ? `<span class="end">${tk.tags.length}</span>` : ''}
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
            <button class="m-pill m-pill-off" style="border:none;cursor:pointer;font-size:11px;color:var(--text-tertiary)" onclick="mRemoveUser(${mJsArg(u.entra_id)},this)"><i class="ti ti-x" style="font-size:12px"></i></button>
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
              onclick="window.__mPickUser({ entra_id: ${mJsArg(u.entra_id)}, display_name: ${mJsArg(u.display_name || '')} })">
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
    <div class="m-sheet-title">${esc(t('tickets.new.priority'))}</div>
    <div style="padding:6px 0 0">
      ${[['low','var(--text-tertiary)'],['normal','var(--text-secondary)'],['high','var(--amber)'],['critical','var(--red)']].map(([val, col]) => `
      <button class="m-menu-row ${_tk.priority === val ? 'active' : ''}" onclick="mSetPriority('${val}')">
        <i class="ti ti-flag" style="color:${col}"></i> ${esc(prioLabel(val))}
        ${_tk.priority === val ? '<i class="ti ti-check" style="margin-left:auto;color:var(--blue-text)"></i>' : ''}
      </button>`).join('')}
    </div>`)
  window.mSetPriority = mSetPriority
}

async function mSetPriority(priority) {
  window.mCloseSheet()
  try {
    await window.api.updateTicket(_tk.id, { priority })
    await reload()
    window.showToast(t('tickets.toast.priority_changed'), 'success')
  } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
}

function mEditTitle() {
  window.mShowSheet(`
    <div class="m-sheet-title">${esc(t('mobile.ticket.menu.edit_title'))}</div>
    <div style="padding:12px 0 0;display:flex;flex-direction:column;gap:12px">
      <input class="m-input" id="m-edit-title" value="${esc(_tk.title)}" maxlength="200" autocomplete="off">
      <button class="m-btn-primary" onclick="mSaveTitle(this)">${esc(t('btn.save'))}</button>
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
        window.showToast(t('tickets.toast.renamed'), 'success')
      } catch { window.showToast(t('mobile.ticket.toast.error'), 'error') }
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prioColor(p) {
  return p === 'critical' ? 'var(--red)' : p === 'high' ? 'var(--amber)' : 'var(--text-tertiary)'
}
