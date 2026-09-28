// Vue « Point informatique » — revue périodique présentée à la hiérarchie.
//
// Deux modes :
//   #/point        → liste des points sauvegardés (+ nouveau)
//   #/point/<id>   → éditeur/visualiseur d'un point
//   #/point/new    → nouveau point
//
// Le point combine des PANNEAUX DE DONNÉES auto (figés dans `snapshot` au
// moment de la sauvegarde, assemblés depuis dashboard/email/rapports) et des
// SECTIONS rédigées à la main. Export : impression/PDF, Markdown, lien.

const t = window.t, esc = window.esc, api = window.api

const DEFAULT_SECTIONS = [
  { heading: 'Opale — développement', body: '' },
  { heading: 'Incidents réseau & prestataires', body: '' },
  { heading: 'Infrastructure & poste de travail', body: '' },
  { heading: 'Matériel', body: '' },
  { heading: 'Sujets en attente / décisions', body: '' },
]

// Libellés FR des étapes du pipeline mail (cf. /api/email/stats by_action).
const MAIL_LABELS = {
  pending_review:             'En attente d’arbitrage (à trier)',
  message_appended:           'Rattachés à un ticket existant',
  proposal_created:           'Propositions créées (auto)',
  proposal_created_no_match:  'Propositions créées (sans correspondance)',
  reply_appended_to_proposal: 'Réponses rattachées à une proposition',
  skipped_other:              'Écartés (hors-sujet / bruit)',
  skipped_error:              'Erreurs de traitement',
  in_queue:                   'En cours de traitement',
}

let _state = null

// ─── Entrée ────────────────────────────────────────────────────────────────
export async function renderPoint(container, id) {
  if (!id) return renderList(container)
  return renderEditor(container, id === 'new' ? null : id)
}

// ─── Liste ─────────────────────────────────────────────────────────────────
async function renderList(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">${t('point.title')}</h1>
      <div class="topbar-actions">
        <button class="btn btn-primary" onclick="navigateTo('/point/new')">
          <i class="ti ti-plus"></i> ${t('point.new')}
        </button>
      </div>
    </div>
    <div id="point-body" style="flex:1;overflow-y:auto;padding:20px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  const body = document.getElementById('point-body')
  let reviews
  try {
    reviews = await api.getReviews()
  } catch {
    body.innerHTML = `<div class="empty-state"><p>${t('error.generic')}</p></div>`
    return
  }
  if (!reviews.length) {
    body.innerHTML = `<div class="empty-state" style="padding:40px">
      <i class="ti ti-clipboard-text" style="font-size:32px"></i>
      <p>${t('point.empty')}</p></div>`
    return
  }
  body.innerHTML = `
    <table class="users-table">
      <thead><tr>
        <th>${t('point.col.title')}</th><th>${t('point.col.period')}</th>
        <th>${t('point.col.author')}</th><th>${t('point.col.updated')}</th><th></th>
      </tr></thead>
      <tbody>
        ${reviews.map(r => `
          <tr style="cursor:pointer" onclick="navigateTo('/point/${esc(r.id)}')">
            <td><strong>${esc(r.title)}</strong></td>
            <td>${fmtPeriod(r.period_start, r.period_end)}</td>
            <td>${esc(r.created_by_name || '—')}</td>
            <td>${fmtDate(r.updated_at)}</td>
            <td style="text-align:right">
              <button class="icon-btn icon-btn-danger" title="${t('point.del')}"
                onclick="event.stopPropagation();pointDelete('${esc(r.id)}')">
                <i class="ti ti-trash"></i></button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`

  window.pointDelete = async (id) => {
    if (!confirm(t('point.confirm_delete'))) return
    try { await api.deleteReview(id); renderList(container) }
    catch { window.showToast?.(t('error.generic'), 'error') }
  }
}

// ─── Éditeur ───────────────────────────────────────────────────────────────
async function renderEditor(container, id) {
  container.innerHTML = `<div class="empty-state" style="flex:1">
    <i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>`

  if (id) {
    let r
    try { r = await api.getReview(id) }
    catch { container.innerHTML = `<div class="empty-state"><p>${t('error.generic')}</p></div>`; return }
    _state = {
      id: r.id, title: r.title,
      period_start: r.period_start ? r.period_start.slice(0, 10) : '',
      period_end:   r.period_end   ? r.period_end.slice(0, 10)   : '',
      snapshot: r.snapshot || {},
      sections: Array.isArray(r.sections) && r.sections.length ? r.sections : structuredClone(DEFAULT_SECTIONS),
    }
  } else {
    const end = new Date()
    const start = new Date(Date.now() - 14 * 86400000)
    const iso = d => d.toISOString().slice(0, 10)
    _state = {
      id: null,
      title: `Point informatique — ${end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      period_start: iso(start), period_end: iso(end),
      snapshot: {}, sections: structuredClone(DEFAULT_SECTIONS),
    }
  }

  paintEditor(container)
  // Nouveau point : on tire les données live immédiatement.
  if (!id) await refreshSnapshot()
}

function paintEditor(container) {
  const s = _state
  container.innerHTML = `
    <div class="topbar no-print">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="icon-btn" onclick="navigateTo('/point')" title="${t('point.back')}"><i class="ti ti-arrow-left"></i></button>
        <h1 class="topbar-title">${s.id ? t('point.edit') : t('point.new')}</h1>
      </div>
      <div class="topbar-actions">
        <button class="btn" onclick="pointRefresh()"><i class="ti ti-refresh"></i> ${t('point.refresh')}</button>
        <button class="btn" onclick="pointCopyMd()"><i class="ti ti-markdown"></i> ${t('point.copy_md')}</button>
        ${s.id ? `<button class="btn" onclick="pointCopyLink()"><i class="ti ti-link"></i> ${t('point.copy_link')}</button>` : ''}
        <button class="btn" onclick="pointPrint()"><i class="ti ti-printer"></i> ${t('point.print')}</button>
        <button class="btn btn-primary" onclick="pointSave()"><i class="ti ti-device-floppy"></i> ${t('point.save')}</button>
      </div>
    </div>
    <div class="no-print" style="flex-shrink:0;padding:14px 20px;border-bottom:0.5px solid var(--border)">
      <div style="max-width:900px;margin:0 auto">
        <input id="pt-title" class="form-input" style="font-size:18px;font-weight:600;width:100%;margin-bottom:8px"
          value="${esc(s.title)}" oninput="pointField('title', this.value)">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-tertiary)">${t('point.period')} :</span>
          <input type="date" class="form-input" value="${esc(s.period_start)}" onchange="pointPeriod('period_start', this.value)">
          <span style="color:var(--text-tertiary)">→</span>
          <input type="date" class="form-input" value="${esc(s.period_end)}" onchange="pointPeriod('period_end', this.value)">
        </div>
      </div>
    </div>
    <div id="point-doc" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px;max-width:900px;margin:0 auto;width:100%">
      <div id="pt-auto"></div>

      <div id="pt-sections"></div>
      <button class="btn no-print" style="align-self:flex-start" onclick="pointAddSection()">
        <i class="ti ti-plus"></i> ${t('point.add_section')}</button>
    </div>`

  // wireHandlers AVANT paintSections : ce dernier référence autoGrow et les
  // gabarits inline appellent les handlers window.* (sinon ReferenceError).
  wireHandlers(container)
  paintAuto()
  paintSections()
}

// autoGrow : ajuste la hauteur d'un textarea à son contenu. Défini au niveau
// module pour être disponible dès paintSections (et exposé en window pour les
// handlers inline oninput).
function autoGrow(ta) {
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}

// ─── Panneaux de données auto (depuis snapshot) ─────────────────────────────
function paintAuto() {
  const el = document.getElementById('pt-auto')
  const snap = _state.snapshot || {}
  if (!snap.generated_at) {
    el.innerHTML = `<div class="panel" style="padding:16px"><span style="color:var(--text-tertiary)">${t('point.no_data')}</span></div>`
    return
  }
  const k = snap.kpis || {}
  const ts = k.time_saved || {}
  const cnt = snap.counts || {}
  const inst = snap.instant || {}
  const mail = snap.email || {}
  const ba = mail.by_action || {}

  const kv = (label, val) => `<div class="pt-kv"><span>${label}</span><strong>${val}</strong></div>`

  el.innerHTML = `
    <div class="panel">
      <div class="panel-header">${t('point.auto.support')}
        <span class="panel-header-note no-print">${t('point.auto.frozen', { d: fmtDate(snap.generated_at) })}</span></div>
      <div class="pt-kv-grid">
        ${kv(t('point.kpi.tickets_created'), cnt.tickets_created ?? '—')}
        ${kv(t('point.kpi.proposals'), cnt.proposals_pending ?? '—')}
        ${kv(t('point.kpi.inbox'), cnt.inbox_pending ?? '—')}
        ${kv(t('point.kpi.alerts'), inst.alerts_active ?? '—')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">${t('point.auto.mail', { n: mail.days ?? snap.period_days ?? '?' })}
        <span class="panel-header-note">${t('point.auto.mail_total', { n: mail.total ?? 0 })}</span></div>
      <div class="pt-kv-grid">
        ${Object.entries(MAIL_LABELS).filter(([key]) => (ba[key] || 0) > 0 || key === 'pending_review' || key === 'skipped_other')
          .map(([key, label]) => kv(label, ba[key] ?? 0)).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">${t('point.auto.kpis')}
        <span class="panel-header-note">${t('point.auto.kpis_note', { n: snap.period_days ?? '?' })}</span></div>
      <div class="pt-kv-grid">
        ${kv(t('point.kpi.time_saved'), `${fmtHours(ts.minutes)} (${(ts.eur ?? 0).toLocaleString('fr-FR')} €)`)}
        ${kv(t('point.kpi.actions'), (k.actions_count ?? 0).toLocaleString('fr-FR'))}
        ${kv(t('point.kpi.parc') + ' *', `${k.parc?.active_7d ?? '—'} / ${k.parc?.total ?? '—'}`)}
        ${kv(t('point.kpi.security') + ' *', k.security_score == null ? '—' : k.security_score + ' %')}
      </div>
    </div>`
}

// ─── Sections éditables ─────────────────────────────────────────────────────
function paintSections() {
  const el = document.getElementById('pt-sections')
  el.innerHTML = _state.sections.map((sec, i) => `
    <div class="panel pt-section" style="padding:12px 16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <input class="form-input pt-heading" style="font-weight:600;flex:1;border:none;background:transparent;padding:2px 0"
          value="${esc(sec.heading)}" oninput="pointSection(${i},'heading',this.value)">
        <button class="icon-btn no-print" onclick="pointMoveSection(${i},-1)" title="↑"><i class="ti ti-chevron-up"></i></button>
        <button class="icon-btn no-print" onclick="pointMoveSection(${i},1)" title="↓"><i class="ti ti-chevron-down"></i></button>
        <button class="icon-btn icon-btn-danger no-print" onclick="pointRemoveSection(${i})" title="${t('point.del')}"><i class="ti ti-x"></i></button>
      </div>
      <textarea class="form-input pt-body" rows="3" placeholder="${t('point.section_ph')}"
        oninput="pointSection(${i},'body',this.value);autoGrow(this)"
        style="width:100%;resize:vertical;min-height:60px">${esc(sec.body)}</textarea>
    </div>`).join('')
  // Auto-grow initial
  el.querySelectorAll('.pt-body').forEach(autoGrow)
}

// ─── Handlers (exposés en global, scope vue) ────────────────────────────────
function wireHandlers(container) {
  window.autoGrow = autoGrow
  window.pointField = (k, v) => { _state[k] = v }
  // Changer la période re-tire les données auto (fenêtre = période).
  window.pointPeriod = (k, v) => { _state[k] = v; refreshSnapshot() }
  window.pointSection = (i, k, v) => { _state.sections[i][k] = v }
  window.pointAddSection = () => { _state.sections.push({ heading: '', body: '' }); paintSections() }
  window.pointRemoveSection = (i) => { _state.sections.splice(i, 1); paintSections() }
  window.pointMoveSection = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= _state.sections.length) return
    const [s] = _state.sections.splice(i, 1)
    _state.sections.splice(j, 0, s)
    paintSections()
  }
  window.pointRefresh = refreshSnapshot
  window.pointSave = saveReview
  window.pointCopyMd = () => copyToClipboard(buildMarkdown(), t('point.copied_md'))
  window.pointCopyLink = () => copyToClipboard(location.origin + '/#/point/' + _state.id, t('point.copied_link'))
  window.pointPrint = printReview
}

async function refreshSnapshot() {
  const days = daysBetween(_state.period_start, _state.period_end) || 14
  window.showToast?.(t('point.loading_data'), 'info')
  try {
    const [dash, email, rap, pc, ic] = await Promise.all([
      api.getDashboard(), api.getEmailStats(days), api.getRapports(days),
      api.getProposalsCount().catch(() => ({})),
      api.getInboxCount().catch(() => ({})),
    ])
    _state.snapshot = {
      generated_at: new Date().toISOString(),
      period_days: days,
      email: { days: email.days, total: email.total, by_action: email.by_action || {} },
      instant: dash.kpis || {},
      kpis: rap.kpis || {},
      counts: {
        // Tickets CRÉÉS sur la période (tout moyen, tout état) — métrique de flux.
        tickets_created: rap.kpis?.tickets_created ?? 0,
        proposals_pending: pc.pending,
        inbox_pending: ic.pending,
      },
    }
    paintAuto()
  } catch {
    window.showToast?.(t('error.generic'), 'error')
  }
}

async function saveReview() {
  const body = {
    title: _state.title,
    period_start: _state.period_start || null,
    period_end: _state.period_end || null,
    snapshot: _state.snapshot,
    sections: _state.sections,
  }
  try {
    if (_state.id) {
      await api.updateReview(_state.id, body)
    } else {
      const created = await api.createReview(body)
      _state.id = created.id
      history.replaceState(null, '', '/#/point/' + created.id)
    }
    window.showToast?.(t('point.saved'), 'success')
    // Repeint pour faire apparaître le bouton « lien » sur un nouveau point.
    paintEditor(document.getElementById('view-point'))
  } catch {
    window.showToast?.(t('error.generic'), 'error')
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────
function buildMarkdown() {
  const s = _state, snap = s.snapshot || {}, k = snap.kpis || {}, ts = k.time_saved || {}
  const cnt = snap.counts || {}, inst = snap.instant || {}, mail = snap.email || {}, ba = mail.by_action || {}
  const L = []
  L.push(`# ${s.title}`)
  if (s.period_start || s.period_end) L.push(`*Période : ${fmtPeriod(s.period_start, s.period_end)}*`)
  L.push('')
  L.push('## Support & tickets')
  L.push(`- Tickets créés (${snap.period_days ?? '?'} j) : ${cnt.tickets_created ?? '—'}`)
  L.push(`- Propositions en attente : ${cnt.proposals_pending ?? '—'}`)
  L.push(`- Mails à trier : ${cnt.inbox_pending ?? '—'}`)
  L.push(`- Alertes actives : ${inst.alerts_active ?? '—'}`)
  L.push('')
  L.push(`## Pont mail (${mail.days ?? snap.period_days ?? '?'} j) — ${mail.total ?? 0} mails`)
  for (const [key, label] of Object.entries(MAIL_LABELS)) {
    if ((ba[key] || 0) > 0) L.push(`- ${label} : ${ba[key]}`)
  }
  L.push('')
  L.push(`## Indicateurs (sur ${snap.period_days ?? '?'} j)`)
  L.push(`- Temps économisé : ${fmtHours(ts.minutes)} (${(ts.eur ?? 0).toLocaleString('fr-FR')} €, projection ${(ts.annual_eur ?? 0).toLocaleString('fr-FR')} €/an)`)
  L.push(`- Actions automatisées : ${(k.actions_count ?? 0).toLocaleString('fr-FR')}`)
  L.push(`- Parc supervisé (actuel) : ${k.parc?.active_7d ?? '—'} / ${k.parc?.total ?? '—'}`)
  L.push(`- Score sécurité (actuel) : ${k.security_score == null ? '—' : k.security_score + ' %'}`)
  L.push('')
  for (const sec of s.sections) {
    if (!sec.heading && !sec.body) continue
    L.push(`## ${sec.heading || '—'}`)
    if (sec.body) L.push(sec.body)
    L.push('')
  }
  return L.join('\n')
}

function printReview() {
  const html = buildPrintHtml()
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'; iframe.style.bottom = '0'
  iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow.document
  doc.open(); doc.write(html); doc.close()
  iframe.contentWindow.focus()
  setTimeout(() => {
    iframe.contentWindow.print()
    setTimeout(() => iframe.remove(), 1000)
  }, 250)
}

function buildPrintHtml() {
  // Réutilise le Markdown converti en HTML minimal (titres + listes + paragraphes).
  const md = buildMarkdown()
  const bodyHtml = md.split('\n').map(line => {
    if (line.startsWith('# '))  return `<h1>${esc(line.slice(2))}</h1>`
    if (line.startsWith('## ')) return `<h2>${esc(line.slice(3))}</h2>`
    if (line.startsWith('*') && line.endsWith('*')) return `<p class="meta">${esc(line.slice(1, -1))}</p>`
    if (line.startsWith('- '))  return `<li>${esc(line.slice(2))}</li>`
    if (!line.trim()) return ''
    return `<p>${esc(line)}</p>`
  }).join('\n').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(_state.title)}</title>
    <style>
      body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:720px;margin:30px auto;padding:0 20px}
      h1{font-size:22px;margin:0 0 4px;border-bottom:2px solid #333;padding-bottom:8px}
      h2{font-size:15px;margin:22px 0 8px;color:#0b5}
      .meta{color:#777;margin:0 0 16px;font-style:italic}
      ul{margin:6px 0 6px 4px;padding-left:18px} li{margin:2px 0}
      p{margin:6px 0;white-space:pre-wrap}
      @media print{body{margin:0}}
    </style></head><body>${bodyHtml}</body></html>`
}

async function copyToClipboard(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text)
    window.showToast?.(okMsg, 'success')
  } catch {
    window.showToast?.(t('error.generic'), 'error')
  }
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function fmtHours(minutes) {
  if (minutes == null) return '—'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60), m = minutes % 60
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`
}
function daysBetween(a, b) {
  if (!a || !b) return null
  const d = Math.round((new Date(b) - new Date(a)) / 86400000)
  return d > 0 ? d : null
}
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function fmtPeriod(a, b) {
  if (!a && !b) return '—'
  return `${fmtDate(a)} → ${fmtDate(b)}`
}
