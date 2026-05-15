// Vue Conformité — dashboard déclaratif des règles built-in.
//
// Modes :
//   - Aggregate (#/conformite)              : tableau global par règle + résumé parc.
//   - Drill-down (#/conformite/<rule_id>)   : liste des devices pour une règle.
//
// La fiche poste (#/postes/:id) affichera elle-même la section conformité
// (PR3), via l'endpoint /api/devices/:id/compliance.
//
// Libellés en dur en français : pas d'i18n pour cette v1 (la vue Rapports
// avait déjà des keys 'rapports.compliance.*' mais c'est un usage
// différent — pas de couplage). À internationaliser plus tard si besoin.

// Mapping sévérité → couleur CSS. Cohérent avec le reste de l'UI (rouge =
// critical, ambre = warn, gris = info).
const SEV_STYLE = {
  critical: { color: 'var(--red)',         bg: 'var(--red-bg)',         label: 'Critique' },
  high:     { color: 'var(--red)',         bg: 'var(--red-bg)',         label: 'Élevée'   },
  medium:   { color: 'var(--amber)',       bg: 'var(--amber-bg)',       label: 'Moyenne'  },
  low:      { color: 'var(--text-tertiary)', bg: 'var(--bg-secondary)', label: 'Faible'   },
}

const STATUS_LABEL = {
  pass:           'Conforme',
  fail:           'Non conforme',
  not_applicable: 'Non applicable',
}

export async function renderConformite(container, { ruleId } = {}) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">Conformité</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="window.conformiteReload()">
          <i class="ti ti-refresh"></i> Actualiser
        </button>
      </div>
    </div>
    <div id="conformite-body" style="flex:1;overflow-y:auto;padding:20px">
      <div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>
    </div>`

  window.conformiteReload = () => renderConformite(container, { ruleId })

  if (ruleId) {
    await loadRuleDetail(ruleId)
  } else {
    await loadAggregate()
  }
}

// ─── Aggregate global ────────────────────────────────────────────────────
async function loadAggregate() {
  const body = document.getElementById('conformite-body')
  if (!body) return
  try {
    const data = await window.api.getCompliance()
    renderAggregate(body, data)
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><p>Erreur de chargement : ${esc(e.message || 'inconnue')}</p></div>`
  }
}

function renderAggregate(body, data) {
  const s = data.summary
  const totalEval = s.devices_full_compliant + s.devices_with_failures

  const summaryCards = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
      ${kpiCard(
        'Postes conformes',
        `${s.devices_full_compliant} / ${totalEval || s.devices_total}`,
        'ti-shield-check',
        'var(--green)',
        totalEval ? `${Math.round(100 * s.devices_full_compliant / totalEval)}%` : '—'
      )}
      ${kpiCard(
        'Avec échec',
        s.devices_with_failures,
        'ti-shield-x',
        s.devices_with_failures > 0 ? 'var(--red)' : 'var(--text-tertiary)',
        s.critical_failing > 0 ? `${s.critical_failing} en critique` : (s.high_failing > 0 ? `${s.high_failing} en élevé` : null)
      )}
      ${kpiCard(
        'Non évalués',
        s.devices_unevaluated,
        'ti-shield-question',
        'var(--text-tertiary)',
        s.devices_unevaluated > 0 ? 'jamais checkin' : null
      )}
      ${kpiCard(
        'Score parc',
        s.score_pct !== null && s.score_pct !== undefined ? `${s.score_pct} %` : '—',
        'ti-target',
        s.score_pct === null || s.score_pct === undefined ? 'var(--text-tertiary)'
          : s.score_pct >= 90 ? 'var(--green)'
          : s.score_pct >= 70 ? 'var(--amber)'
          : 'var(--red)',
        s.score_eval ? `${s.score_pass} ✓ / ${s.score_eval} évaluations` : null
      )}
    </div>`

  // Tri : sévérité décroissante (critical → low) puis taux d'échec décroissant.
  const sevWeight = { critical: 3, high: 2, medium: 1, low: 0 }
  const rules = [...data.rules].sort((a, b) => {
    const sd = sevWeight[b.severity] - sevWeight[a.severity]
    if (sd !== 0) return sd
    const ra = a.total ? a.fail / a.total : 0
    const rb = b.total ? b.fail / b.total : 0
    return rb - ra
  })

  const rulesPanel = `
    <div class="panel">
      <div class="panel-header">
        <i class="ti ti-list-check"></i> Règles de conformité
        <span class="badge" style="margin-left:4px">${rules.length}</span>
      </div>
      <div>
        ${rules.map(ruleRow).join('')}
      </div>
    </div>`

  body.innerHTML = summaryCards + rulesPanel
}

function ruleRow(r) {
  const sev = SEV_STYLE[r.severity] || SEV_STYLE.medium
  const evalTotal = r.pass + r.fail   // not_applicable exclu du dénominateur
  const okPct = evalTotal ? Math.round(100 * r.pass / evalTotal) : 100
  // Largeur barre : pass / (pass + fail) sur 100% ; le not_applicable est
  // affiché à côté en texte. On veut un signal visuel "ce qui devrait
  // passer passe-t-il ?".
  //
  // Pour les fails de toutes sévérités, on force red/amber (pas
  // text-tertiary qui est indistinguable du fond en dark theme — c'était
  // le cas pour les low fails). Le but de la barre est de signaler du
  // danger même quand la sévérité est `low`.
  const barColor = r.fail > 0
    ? (r.severity === 'critical' || r.severity === 'high' ? 'var(--red)' : 'var(--amber)')
    : 'var(--green)'

  return `
    <div class="alert-row" onclick="navigateTo('/conformite/${esc(r.id)}')"
         style="border-left:3px solid ${sev.color};cursor:pointer">
      <i class="ti ti-shield" style="color:${sev.color};flex-shrink:0"></i>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px">
          <span style="font-weight:500">${esc(r.label)}</span>
          <span class="badge" style="background:${sev.bg};color:${sev.color}">${sev.label}</span>
          ${r.not_applicable > 0
            ? `<span style="font-size:11px;color:var(--text-tertiary)">${r.not_applicable} N/A</span>`
            : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">
            <div style="width:${okPct}%;height:100%;background:${barColor}"></div>
          </div>
          <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">
            ${r.pass}/${evalTotal} ✓${r.fail > 0 ? ` · <span style="color:${sev.color}">${r.fail} échec${r.fail > 1 ? 's' : ''}</span>` : ''}
          </span>
        </div>
      </div>
      <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px"></i>
    </div>`
}

function kpiCard(label, value, icon, color, sublabel) {
  return `
    <div class="panel" style="padding:14px;display:flex;align-items:center;gap:12px">
      <div style="width:36px;height:36px;border-radius:8px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;color:${color}">
        <i class="ti ${icon}" style="font-size:18px"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.3px">${esc(label)}</div>
        <div style="font-size:18px;font-weight:600;color:var(--text-primary)">${esc(value)}</div>
        ${sublabel ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(sublabel)}</div>` : ''}
      </div>
    </div>`
}

// ─── Drill-down par règle ────────────────────────────────────────────────
async function loadRuleDetail(ruleId) {
  const body = document.getElementById('conformite-body')
  if (!body) return
  try {
    const data = await window.api.getComplianceRule(ruleId)
    renderRuleDetail(body, data)
  } catch (e) {
    if (e.status === 404) {
      body.innerHTML = `
        <div class="empty-state" style="height:100%;justify-content:center">
          <i class="ti ti-shield-question" style="font-size:32px"></i>
          <p>Règle inconnue</p>
          <button class="btn" onclick="navigateTo('/conformite')">Retour</button>
        </div>`
    } else {
      body.innerHTML = `<div class="empty-state"><p>Erreur de chargement : ${esc(e.message || 'inconnue')}</p></div>`
    }
  }
}

function renderRuleDetail(body, data) {
  const r = data.rule
  const sev = SEV_STYLE[r.severity] || SEV_STYLE.medium
  const devices = data.devices

  // Partition par status. fail en haut, puis n/a, puis pass.
  const groups = {
    fail:           devices.filter(d => d.status === 'fail'),
    not_applicable: devices.filter(d => d.status === 'not_applicable'),
    pass:           devices.filter(d => d.status === 'pass'),
  }

  body.innerHTML = `
    <div style="margin-bottom:16px">
      <button class="btn btn-sm" onclick="navigateTo('/conformite')">
        <i class="ti ti-arrow-left"></i> Toutes les règles
      </button>
    </div>
    <div class="panel" style="margin-bottom:20px;padding:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <i class="ti ti-shield" style="font-size:24px;color:${sev.color}"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:600">${esc(r.label)}</div>
          <div style="font-size:12px;color:var(--text-tertiary)">id : <code>${esc(r.id)}</code></div>
        </div>
        <span class="badge" style="background:${sev.bg};color:${sev.color}">Sévérité ${sev.label.toLowerCase()}</span>
      </div>
    </div>
    ${renderStatusSection(groups.fail,           'fail',           'ti-shield-x',        sev.color,             sev.bg)}
    ${renderStatusSection(groups.not_applicable, 'not_applicable', 'ti-shield-question', 'var(--text-tertiary)', 'var(--bg-secondary)')}
    ${renderStatusSection(groups.pass,           'pass',           'ti-shield-check',    'var(--green)',         'var(--green-bg)')}
  `
}

function renderStatusSection(rows, status, icon, color, bg) {
  if (!rows.length) return ''
  return `
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-header" style="color:${color}">
        <i class="ti ${icon}"></i> ${STATUS_LABEL[status]}
        <span class="badge" style="background:${bg};color:${color};margin-left:4px">${rows.length}</span>
      </div>
      <div>
        ${rows.map(d => deviceRow(d, color)).join('')}
      </div>
    </div>`
}

function deviceRow(d, color) {
  // value est un JSON arbitraire (ex: { protection_status: 'off' }, { age_days: 42, max: 7 }).
  // On le sérialise simplement en string pour l'instant — un affichage typé
  // par règle peut être ajouté plus tard si besoin.
  const valueHint = d.value && Object.keys(d.value).length
    ? `<span style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono, monospace)">${esc(JSON.stringify(d.value))}</span>`
    : ''
  return `
    <div class="alert-row" onclick="navigateTo('/postes/${esc(d.device_id)}')" style="cursor:pointer">
      <i class="ti ti-device-laptop" style="color:${color};flex-shrink:0"></i>
      <span style="font-size:13px;flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b>${esc(d.hostname)}</b>
        ${d.user_name ? `<span style="color:var(--text-tertiary)">· ${esc(d.user_name)}</span>` : ''}
        ${valueHint}
      </span>
      <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px"></i>
    </div>`
}
