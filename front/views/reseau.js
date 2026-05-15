// Vue /reseau — top consommateurs de bande passante.
//
// Confidentialité : le nom de l'utilisateur assigné est caché par défaut
// (affiché "•••") et révélé au clic explicite. La donnée est dans la
// réponse API (admin only), c'est uniquement un masque visuel — utile
// quand l'admin partage son écran lors d'un dépannage ou d'une réunion.
//
// Chaque chargement de la page déclenche un INSERT audit_logs côté
// serveur (action 'network_view_accessed', cf. api/routes/network.js).

let _rows           = []
let _period         = '24h'
let _sort           = 'total'
let _limit          = 20
let _query          = ''
let _revealedUsers  = new Set()  // device_id → user_name révélé
let _autoRefreshOn  = false
let _autoRefreshTimer = null
const AUTO_REFRESH_INTERVAL_MS = 30_000

export async function renderReseau(container) {
  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <span class="page-title">${t('reseau.title')}</span>
        <span id="reseau-count" style="font-size:12px;color:var(--text-tertiary)">—</span>
      </div>
      <div class="topbar-right">
        <button class="btn btn-sm" id="btn-reseau-refresh" onclick="reseauRefresh()" title="${t('reseau.refresh_title')}">
          <i class="ti ti-refresh"></i> ${t('reseau.refresh')}
        </button>
        <button class="btn btn-sm" id="btn-reseau-auto" onclick="reseauToggleAuto()" title="${t('reseau.auto_title')}">
          <i class="ti ti-clock"></i> ${t('reseau.auto')}
        </button>
        <button class="btn btn-sm" onclick="reseauExportCsv()">
          <i class="ti ti-download"></i> ${t('reseau.export_csv')}
        </button>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-bar">
        <i class="ti ti-search"></i>
        <input type="text" id="reseau-search" placeholder="${t('reseau.search')}" oninput="reseauOnSearch(this.value)">
      </div>
      <div class="filter-group">
        <span style="font-size:11px;color:var(--text-tertiary);margin-right:6px">${t('reseau.period')} :</span>
        <button class="filter-btn ${_period==='4h'?'active':''}" data-period="4h" onclick="reseauSetPeriod('4h',this)">4h</button>
        <button class="filter-btn ${_period==='24h'?'active':''}" data-period="24h" onclick="reseauSetPeriod('24h',this)">24h</button>
        <button class="filter-btn ${_period==='7d'?'active':''}" data-period="7d" onclick="reseauSetPeriod('7d',this)">7j</button>
      </div>
      <div class="toolbar-right" style="gap:8px;align-items:center">
        <span style="font-size:11px;color:var(--text-tertiary)">${t('reseau.top_n')} :</span>
        <select class="sort-select" onchange="reseauSetLimit(this.value)">
          <option value="10"  ${_limit===10?'selected':''}>10</option>
          <option value="20"  ${_limit===20?'selected':''}>20</option>
          <option value="50"  ${_limit===50?'selected':''}>50</option>
          <option value="100" ${_limit===100?'selected':''}>100</option>
        </select>
      </div>
    </div>

    <div class="table-wrap">
      <table id="reseau-table">
        <thead>
          <tr>
            <th>${t('reseau.col.hostname')}</th>
            <th>${t('reseau.col.user')}</th>
            <th>${t('reseau.col.adapter')}</th>
            <th style="width:80px">${t('reseau.col.trend')}</th>
            <th class="th-sortable" onclick="reseauSetSort('recv')" data-sort="recv">↓ ${t('reseau.col.recv')} <i class="ti ti-selector sort-icon"></i></th>
            <th class="th-sortable" onclick="reseauSetSort('sent')" data-sort="sent">↑ ${t('reseau.col.sent')} <i class="ti ti-selector sort-icon"></i></th>
            <th class="th-sortable" onclick="reseauSetSort('total')" data-sort="total">Σ ${t('reseau.col.total')} <i class="ti ti-selector sort-icon"></i></th>
            <th>${t('reseau.col.peak')}</th>
            <th>${t('reseau.col.status')}</th>
          </tr>
        </thead>
        <tbody id="reseau-tbody">
          <tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-tertiary)"><div class="loading-spinner" style="margin:0 auto"></div></td></tr>
        </tbody>
      </table>
    </div>`

  window.reseauRefresh      = reseauRefresh
  window.reseauToggleAuto   = reseauToggleAuto
  window.reseauOnSearch     = (v) => { _query = v.toLowerCase(); renderTable() }
  window.reseauSetPeriod    = setPeriod
  window.reseauSetLimit     = (v) => { _limit = parseInt(v, 10) || 20; reseauRefresh() }
  window.reseauSetSort      = (s) => { _sort = s; reseauRefresh() }
  window.reseauRevealUser   = (deviceId) => { _revealedUsers.add(deviceId); renderTable() }
  window.reseauHideUser     = (deviceId) => { _revealedUsers.delete(deviceId); renderTable() }
  window.reseauOpenDevice   = (deviceId) => { navigateTo('/postes/' + deviceId) }
  window.reseauExportCsv    = exportCsv

  // Auto-refresh OFF par défaut (cohérent avec /audit) — l'admin choisit.
  _autoRefreshOn = false

  await reseauRefresh()
}

async function reseauRefresh() {
  try {
    const data = await window.api.getTopNetwork({ period: _period, sort: _sort, limit: _limit })
    _rows = data.rows || []
    updateCount()
    renderTable()
    updateSortHeaders()
  } catch (err) {
    const tbody = document.getElementById('reseau-tbody')
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:1rem;color:var(--red)">${esc(err.message)}</td></tr>`
  }
}

function setPeriod(p, btn) {
  _period = p
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  reseauRefresh()
}

function reseauToggleAuto() {
  _autoRefreshOn = !_autoRefreshOn
  const btn = document.getElementById('btn-reseau-auto')
  if (btn) {
    btn.classList.toggle('btn-primary', _autoRefreshOn)
    btn.title = _autoRefreshOn ? t('reseau.auto_active_title') : t('reseau.auto_title')
  }
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null }
  if (_autoRefreshOn) {
    _autoRefreshTimer = setInterval(() => reseauRefresh(), AUTO_REFRESH_INTERVAL_MS)
  }
}

function updateCount() {
  const el = document.getElementById('reseau-count')
  if (!el) return
  el.textContent = t('reseau.count', { n: _rows.length, period: periodLabel(_period) })
}

function updateSortHeaders() {
  document.querySelectorAll('#reseau-table .th-sortable').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === _sort)
  })
}

function periodLabel(p) {
  return p === '4h' ? '4h' : p === '7d' ? '7 jours' : '24h'
}

function getFiltered() {
  if (!_query) return _rows
  const q = _query
  return _rows.filter(r =>
    (r.hostname || '').toLowerCase().includes(q) ||
    (r.adapter  || '').toLowerCase().includes(q) ||
    (_revealedUsers.has(r.device_id) && (r.user_name || '').toLowerCase().includes(q))
  )
}

function renderTable() {
  const tbody = document.getElementById('reseau-tbody')
  if (!tbody) return
  const rows = getFiltered()
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state" style="padding:2rem"><i class="ti ti-network"></i><p>${t('reseau.empty')}</p></div></td></tr>`
    return
  }
  tbody.innerHTML = rows.map(rowHtml).join('')
}

function rowHtml(r) {
  const revealed = _revealedUsers.has(r.device_id)
  const userCell = r.user_name
    ? (revealed
        ? `<span>${esc(r.user_name)}</span>
           <button class="btn btn-sm" style="margin-left:6px;padding:1px 6px;font-size:10px" onclick="event.stopPropagation();reseauHideUser('${esc(r.device_id)}')" title="${esc(t('reseau.hide_user'))}"><i class="ti ti-eye-off" style="font-size:11px"></i></button>`
        : `<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="event.stopPropagation();reseauRevealUser('${esc(r.device_id)}')" title="${esc(t('reseau.reveal_user'))}">••• <i class="ti ti-eye" style="font-size:11px"></i></button>`)
    : `<span style="color:var(--text-tertiary)">—</span>`

  const statusPill = r.online
    ? `<span class="status-pill pill-on"><span class="pill-dot"></span>${t('status.online')}</span>`
    : `<span class="status-pill pill-off"><span class="pill-dot"></span>${t('status.offline')}</span>`

  const peakCls = r.peak_mbps >= 500 ? 'c-warn' : r.peak_mbps >= 100 ? '' : 'c-info'

  // Couleur sémantique sur Total — seuils paramétrés par période.
  const totalCls = totalCellClass(r.total_bytes, _period)
  // Sparkline 24 buckets : courbe simplifiée par poste, lecture instantanée
  // pic vs trafic soutenu. Couleur dérivée du status (offline = gris).
  const sparkColor = r.online ? 'var(--blue)' : 'var(--text-tertiary)'
  const spark = sparklineSvg(r.series_mbps || [], 70, 18, sparkColor)
  // Indicateur de tendance ↑↓ vs période précédente (si data disponible).
  const trendBadge = renderTrendBadge(r.trend)

  return `
    <tr onclick="reseauOpenDevice('${esc(r.device_id)}')" style="cursor:pointer">
      <td>
        <div class="hostname"><a href="#/postes/${esc(r.device_id)}" class="nav-link" onclick="event.stopPropagation()">${esc(r.hostname)}</a></div>
      </td>
      <td>${userCell}</td>
      <td style="color:var(--text-secondary);font-size:11px">${esc(r.adapter || '—')}</td>
      <td style="vertical-align:middle">${spark}</td>
      <td style="color:var(--green);font-variant-numeric:tabular-nums">${fmtBytes(r.recv_bytes)}</td>
      <td style="color:var(--blue);font-variant-numeric:tabular-nums">${fmtBytes(r.sent_bytes)}</td>
      <td class="${totalCls}" style="font-weight:500;font-variant-numeric:tabular-nums">${fmtBytes(r.total_bytes)}${trendBadge}</td>
      <td class="${peakCls}" style="font-variant-numeric:tabular-nums">${fmtMbps(r.peak_mbps)}</td>
      <td>${statusPill}</td>
    </tr>`
}

// ─── Helpers sparkline + tendance ───────────────────────────────────────────

// Seuils de couleur sur la colonne Total, indicatifs (à ajuster si besoin
// après observation prod). Le ratio rouge/ambre par période est calé sur
// un usage bureautique typique : 24h normal ≈ 1-5 GB, anormal > 25 GB.
const TOTAL_THRESHOLDS = {
  '4h':  { warn:  2.5 * 1024 ** 3, crit:   5 * 1024 ** 3 },
  '24h': { warn:   10 * 1024 ** 3, crit:  25 * 1024 ** 3 },
  '7d':  { warn:   50 * 1024 ** 3, crit: 100 * 1024 ** 3 },
}

function totalCellClass(bytes, period) {
  const thr = TOTAL_THRESHOLDS[period] || TOTAL_THRESHOLDS['24h']
  if (bytes >= thr.crit) return 'c-danger'
  if (bytes >= thr.warn) return 'c-warn'
  return ''
}

// SVG sparkline minimal — polyline sur N points. `values` peut avoir
// moins de SPARKLINE_BUCKETS points (buckets vides côté SQL non remplis).
function sparklineSvg(values, width, height, color) {
  if (!values || values.length < 2) {
    // 1 ou 0 point : afficher juste un trait baseline pour ne pas
    // laisser un trou dans le tableau.
    return `<svg width="${width}" height="${height}" style="display:block"><line x1="0" y1="${height-1}" x2="${width}" y2="${height-1}" stroke="var(--border)" stroke-width="1"/></svg>`
  }
  const max = Math.max(...values, 0.001)
  // Padding vertical 1px pour ne pas coller au bord
  const yMax = height - 1
  const yMin = 1
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = yMax - (v / max) * (yMax - yMin)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return `<svg width="${width}" height="${height}" style="display:block;overflow:visible" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`
}

// Badge ↑/↓ inline à côté de la valeur Total. ≈ si variation < 10% pour
// ne pas crier au feu pour du bruit.
function renderTrendBadge(trend) {
  if (!trend || typeof trend.delta_pct !== 'number' || !Number.isFinite(trend.delta_pct)) return ''
  const pct = trend.delta_pct
  const abs = Math.abs(pct)
  if (abs < 10) {
    return `<span style="color:var(--text-tertiary);font-size:10px;margin-left:6px" title="${esc(t('reseau.trend_stable'))}">≈</span>`
  }
  const arrow = pct > 0 ? '↑' : '↓'
  // Couleur : seules les HAUSSES sont signalées en rouge (= dérive suspecte).
  // Une baisse ↓ n'est pas problématique en soi (le poste consomme moins).
  let color = 'var(--text-tertiary)'
  if (pct >  50)  color = 'var(--red)'
  else if (pct > 10) color = 'var(--amber)'
  return `<span style="color:${color};font-size:10px;margin-left:6px;font-variant-numeric:tabular-nums" title="${esc(t('reseau.trend_tooltip', { pct: Math.round(abs) }))}">${arrow}${Math.round(abs)}%</span>`
}

function fmtBytes(b) {
  if (b == null || b === 0) return '0'
  if (b < 1024)         return b + ' B'
  if (b < 1024 ** 2)    return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 ** 3)    return (b / 1024 ** 2).toFixed(1) + ' MB'
  return (b / 1024 ** 3).toFixed(2) + ' GB'
}

function fmtMbps(mbps) {
  if (mbps == null || mbps <= 0) return '0'
  if (mbps >= 1000) return (mbps / 1000).toFixed(2) + ' Gbps'
  if (mbps >= 1)    return mbps.toFixed(1) + ' Mbps'
  return (mbps * 1000).toFixed(0) + ' kbps'
}

function exportCsv() {
  const headers = ['hostname', 'adapter', 'user', 'recv_bytes', 'sent_bytes', 'total_bytes', 'peak_mbps', 'online', 'last_seen']
  const lines = [headers.join(',')]
  for (const r of getFiltered()) {
    // L'export contient le user_name même si caché côté UI : c'est un export
    // admin, et l'admin a déjà la donnée en main via la réponse API.
    const row = [
      JSON.stringify(r.hostname || ''),
      JSON.stringify(r.adapter || ''),
      JSON.stringify(r.user_name || ''),
      r.recv_bytes || 0,
      r.sent_bytes || 0,
      r.total_bytes || 0,
      (r.peak_mbps || 0).toFixed(2),
      r.online ? 'true' : 'false',
      r.last_seen ? new Date(r.last_seen).toISOString() : '',
    ].join(',')
    lines.push(row)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `opale-reseau-${_period}-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
