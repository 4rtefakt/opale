// Ask Opale mobile — recherche du parc en langage naturel.
//
// Même backend que la palette desktop (front/views/ask.js) : POST /api/ask
// renvoie { resource, spec, total, count, rows }. Lecture seule. On rend les
// résultats avec les cartes mobiles, chaque ligne navigue vers le détail.
//
// Le champ devices renvoyé par /ask ne contient PAS de status calculé
// (online/offline) — on n'affiche donc pas de pastille d'état, juste un libellé
// modèle · utilisateur et le dernier contact.

// Métadonnées de rendu par ressource : icône + titre/sous-titre + destination.
const RENDERERS = {
  devices: {
    icon: 'ti-device-laptop',
    title: r => r.hostname,
    sub:   r => [r.model || r.manufacturer, r.user_name].filter(Boolean).join(' · '),
    aside: r => r.last_seen ? formatRelative(r.last_seen) : '',
    href:  r => `#/poste/${r.id}`,
  },
  tickets: {
    icon: 'ti-ticket',
    title: r => r.title,
    sub:   r => [r.priority, r.device_hostname].filter(Boolean).join(' · '),
    pill:  r => ticketPill(r.status),
    href:  r => `#/ticket/${r.id}`,
  },
  compliance: {
    icon: 'ti-shield',
    title: r => r.hostname,
    sub:   r => [r.rule_id, r.user_name].filter(Boolean).join(' · '),
    pill:  r => compliancePill(r.status),
    href:  r => `#/poste/${r.device_id}`,
  },
}

function ticketPill(status) {
  if (status === 'resolved')    return { cls: 'm-pill-on',   txt: t('mobile.ask.ticket.resolved') }
  if (status === 'in_progress') return { cls: 'm-pill-warn', txt: t('mobile.ask.ticket.in_progress') }
  return { cls: 'm-pill-off', txt: t('mobile.ask.ticket.open') }
}

function compliancePill(status) {
  if (status === 'fail')           return { cls: 'm-pill-crit', txt: t('mobile.conformite.status.fail') }
  if (status === 'not_applicable') return { cls: 'm-pill-off',  txt: t('mobile.conformite.status.not_applicable') }
  return { cls: 'm-pill-on', txt: t('mobile.conformite.status.pass') }
}

const SUGGESTIONS = [
  'mobile.ask.sug.offline',
  'mobile.ask.sug.tickets',
  'mobile.ask.sug.bitlocker',
  'mobile.ask.sug.department',
]

let _running = false

export function renderAsk(el) {
  _running = false
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <div class="m-search" style="margin:0;flex:1">
        <i class="ti ti-sparkles" style="color:var(--blue-text)"></i>
        <input type="text" id="m-ask-q" placeholder="${t('mobile.ask.placeholder')}"
          autocomplete="off" autocorrect="off" autocapitalize="off" enterkeyhint="search"
          style="font-size:14px">
      </div>
    </div>
    <div class="m-scroll-list" id="m-ask-body" style="padding-top:12px"></div>`

  const input = document.getElementById('m-ask-q')
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); run(input.value) }
  })
  requestAnimationFrame(() => input.focus())

  renderEmpty()

  // Si désactivé/non configuré, on le dit d'emblée plutôt que d'attendre une
  // question pour échouer en 503.
  window.api.getAskCapabilities()
    .then(caps => {
      if (!caps.enabled || !caps.configured) renderConfigError()
    })
    .catch(() => { /* tolérant : la question elle-même remontera l'erreur */ })

  window.mAskSuggest = (key) => {
    const text = t(key)
    const inp = document.getElementById('m-ask-q')
    if (inp) inp.value = text
    run(text)
  }
}

function body() { return document.getElementById('m-ask-body') }

function renderEmpty() {
  const b = body()
  if (!b) return
  const chips = SUGGESTIONS.map(k =>
    `<button class="m-filter-pill" style="white-space:normal;text-align:left;height:auto;padding:10px 12px"
       onclick="mAskSuggest('${k}')">${esc(t(k))}</button>`
  ).join('')
  b.innerHTML = `
    <div style="text-align:center;color:var(--text-tertiary);padding:24px 20px 8px;font-size:13px">
      <i class="ti ti-sparkles" style="font-size:32px;display:block;margin-bottom:8px;color:var(--blue-text);opacity:.6"></i>
      ${esc(t('ask.hint'))}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">${chips}</div>`
}

function renderConfigError() {
  const b = body()
  if (!b) return
  b.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;padding:50px 24px;gap:10px;text-align:center">
      <i class="ti ti-plug-off" style="font-size:40px;color:var(--amber);opacity:.7"></i>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.5">${esc(t('ask.config_hint'))}</div>
    </div>`
}

async function run(question) {
  const q = (question || '').trim()
  if (!q || _running) return
  _running = true
  const b = body()
  if (b) b.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:30px;color:var(--text-secondary);font-size:13px">
      <div class="m-spinner" style="width:18px;height:18px;border-width:2px"></div> ${esc(t('ask.searching'))}
    </div>`
  try {
    const data = await window.api.askOpale(q)
    renderResults(data)
  } catch (err) {
    renderError(err)
  } finally {
    _running = false
  }
}

function describeSpec(spec) {
  const parts = []
  for (const [k, v] of Object.entries(spec.filters || {})) parts.push(`${k}=${v}`)
  for (const [k, v] of Object.entries(spec.cross || {}))   parts.push(`${k}=${v}`)
  return `${spec.resource}${parts.length ? ' · ' + parts.join(' · ') : ''}`
}

function renderResults(data) {
  const b = body()
  if (!b) return
  const r = RENDERERS[data.resource]
  if (!r) {
    b.innerHTML = `<div style="text-align:center;color:var(--text-tertiary);padding:30px;font-size:13px">${esc(t('ask.unknown_resource'))}</div>`
    return
  }

  const specLine = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 2px 6px;font-size:11px;color:var(--text-tertiary)">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-arrow-guide"></i> ${esc(describeSpec(data.spec))}</span>
      <span style="flex-shrink:0">${data.total} ${esc(t('ask.results'))}</span>
    </div>`

  if (!data.rows.length) {
    b.innerHTML = specLine +
      `<div style="text-align:center;color:var(--text-tertiary);padding:30px;font-size:13px">${esc(t('ask.no_results'))}</div>`
    return
  }

  const rows = data.rows.map(row => {
    const pill  = r.pill ? r.pill(row) : null
    const aside = r.aside ? r.aside(row) : ''
    const sub   = r.sub(row)
    return `
      <div class="m-device-card" onclick="window.location.hash='${esc(r.href(row))}'">
        <i class="ti ${r.icon}" style="color:var(--text-secondary);font-size:18px;flex-shrink:0"></i>
        <div class="m-device-info">
          <div class="m-device-name">${esc(r.title(row) || '—')}</div>
          ${sub ? `<div class="m-device-sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="m-device-right">
          ${pill ? `<span class="m-pill ${pill.cls}">${esc(pill.txt)}</span>` : ''}
          ${aside ? `<span style="font-size:10px;color:var(--text-tertiary)">${esc(aside)}</span>` : ''}
        </div>
      </div>`
  }).join('')

  const more = data.total > data.count
    ? `<div style="text-align:center;font-size:11px;color:var(--text-tertiary);padding:10px">${esc(t('ask.more', { shown: data.count, total: data.total }))}</div>`
    : ''

  b.innerHTML = specLine + rows + more
}

function renderError(err) {
  const b = body()
  if (!b) return
  if (err.status === 503) { renderConfigError(); return }

  const details = err.body?.details
  const detailHtml = Array.isArray(details) && details.length
    ? `<ul style="text-align:left;font-size:12px;color:var(--text-tertiary);margin-top:10px;padding-left:18px;display:flex;flex-direction:column;gap:4px">${details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
    : ''
  b.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;padding:40px 24px;gap:8px;text-align:center">
      <i class="ti ti-alert-triangle" style="font-size:36px;color:var(--red);opacity:.7"></i>
      <div style="font-size:13px;color:var(--text-secondary)">${esc(err.message || t('ask.error'))}</div>
      ${detailHtml}
    </div>`
}
