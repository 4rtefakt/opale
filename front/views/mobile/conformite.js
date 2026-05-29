// Conformité mobile — dashboard des règles built-in.
//
// Mêmes endpoints que le desktop (front/views/conformite.js) :
//   - api.getCompliance()            : agrégat (summary parc + règles).
//   - api.getComplianceRule(ruleId)  : drill-down devices d'une règle.
//
// Vue d'ensemble : score parc + règles triées par sévérité décroissante puis
// taux d'échec. Drill-down : postes en échec (en haut) → fiche poste.

const SEV = {
  critical: { color: 'var(--red)',           key: 'mobile.conformite.sev.critical' },
  high:     { color: 'var(--red)',           key: 'mobile.conformite.sev.high'     },
  medium:   { color: 'var(--amber)',         key: 'mobile.conformite.sev.medium'   },
  low:      { color: 'var(--text-tertiary)', key: 'mobile.conformite.sev.low'      },
}
const SEV_WEIGHT = { critical: 3, high: 2, medium: 1, low: 0 }

export async function renderConformite(el, ruleId) {
  el.innerHTML = `
    <div class="m-header">
      ${ruleId
        ? `<button class="m-icon-btn" onclick="window.location.hash='#/conformite'"><i class="ti ti-arrow-left"></i></button>`
        : ''}
      <h1>${t('mobile.conformite.title')}</h1>
      <button class="m-icon-btn" onclick="mConfReload()"><i class="ti ti-refresh"></i></button>
    </div>
    <div class="m-scroll" id="m-conf-body">
      <div style="display:flex;justify-content:center;padding:20px"><div class="m-spinner"></div></div>
    </div>`

  window.mConfReload = () => renderConformite(el, ruleId)

  if (ruleId) await loadRuleDetail(ruleId)
  else        await loadAggregate()
}

// ─── Vue d'ensemble ───────────────────────────────────────────────────────
async function loadAggregate() {
  const b = document.getElementById('m-conf-body')
  if (!b) return
  try {
    const data = await window.api.getCompliance()
    renderAggregate(b, data)
  } catch (e) {
    b.innerHTML = errorBox(e)
  }
}

function renderAggregate(b, data) {
  const s = data.summary
  const totalEval = s.devices_full_compliant + s.devices_with_failures
  const scorePct  = s.score_pct
  const scoreColor = scorePct == null ? 'var(--text-tertiary)'
    : scorePct >= 90 ? 'var(--green)'
    : scorePct >= 70 ? 'var(--amber)'
    : 'var(--red)'

  const hero = `
    <div class="m-panel" style="padding:16px;display:flex;align-items:center;gap:16px">
      <div style="position:relative;flex-shrink:0">
        <div style="font-size:32px;font-weight:700;color:${scoreColor};line-height:1">
          ${scorePct == null ? '—' : scorePct + '<span style="font-size:16px">%</span>'}
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">${t('mobile.conformite.kpi.score')}</div>
      </div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;font-size:12px">
        <div style="display:flex;align-items:center;gap:6px;color:var(--green)">
          <i class="ti ti-shield-check"></i> ${s.devices_full_compliant} / ${totalEval || s.devices_total} ${t('mobile.conformite.kpi.compliant')}
        </div>
        <div style="display:flex;align-items:center;gap:6px;color:${s.devices_with_failures > 0 ? 'var(--red)' : 'var(--text-tertiary)'}">
          <i class="ti ti-shield-x"></i> ${s.devices_with_failures} ${t('mobile.conformite.kpi.failing')}${s.critical_failing > 0 ? ` · ${s.critical_failing} ${t('mobile.conformite.kpi.in_critical')}` : ''}
        </div>
        ${s.devices_unevaluated > 0 ? `
        <div style="display:flex;align-items:center;gap:6px;color:var(--text-tertiary)">
          <i class="ti ti-shield-question"></i> ${s.devices_unevaluated} ${t('mobile.conformite.kpi.unevaluated')}
        </div>` : ''}
      </div>
    </div>`

  const rules = [...data.rules].sort((a, b2) => {
    const sd = SEV_WEIGHT[b2.severity] - SEV_WEIGHT[a.severity]
    if (sd !== 0) return sd
    const ra = a.total ? a.fail / a.total : 0
    const rb = b2.total ? b2.fail / b2.total : 0
    return rb - ra
  })

  b.innerHTML = hero
    + `<div class="m-section">${t('mobile.conformite.rules')} (${rules.length})</div>`
    + rules.map(ruleRow).join('')
}

function ruleRow(r) {
  const sev = SEV[r.severity] || SEV.medium
  const evalTotal = r.pass + r.fail
  const okPct = evalTotal ? Math.round(100 * r.pass / evalTotal) : 100
  const barColor = r.fail > 0
    ? (r.severity === 'critical' || r.severity === 'high' ? 'var(--red)' : 'var(--amber)')
    : 'var(--green)'

  return `
    <div class="m-device-card" style="flex-direction:column;align-items:stretch;gap:8px;border-left:3px solid ${sev.color}"
         onclick="window.location.hash='#/conformite/${esc(r.id)}'">
      <div style="display:flex;align-items:center;gap:8px">
        <i class="ti ti-shield" style="color:${sev.color};flex-shrink:0"></i>
        <span style="flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.label)}</span>
        <span class="m-pill" style="background:${sev.color}22;color:${sev.color}">${t(sev.key)}</span>
        <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px;flex-shrink:0"></i>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden">
          <div style="width:${okPct}%;height:100%;background:${barColor}"></div>
        </div>
        <span style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">
          ${r.pass}/${evalTotal} ✓${r.fail > 0 ? ` · <span style="color:${sev.color}">${r.fail} ${t('mobile.conformite.fail_short')}</span>` : ''}${r.not_applicable > 0 ? ` · ${r.not_applicable} N/A` : ''}
        </span>
      </div>
    </div>`
}

// ─── Drill-down par règle ─────────────────────────────────────────────────
async function loadRuleDetail(ruleId) {
  const b = document.getElementById('m-conf-body')
  if (!b) return
  try {
    const data = await window.api.getComplianceRule(ruleId)
    renderRuleDetail(b, data)
  } catch (e) {
    if (e.status === 404) {
      b.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;padding:50px 24px;gap:10px;text-align:center">
          <i class="ti ti-shield-question" style="font-size:40px;color:var(--text-tertiary)"></i>
          <div style="font-size:14px;color:var(--text-secondary)">${t('mobile.conformite.unknown_rule')}</div>
        </div>`
    } else {
      b.innerHTML = errorBox(e)
    }
  }
}

function renderRuleDetail(b, data) {
  const r   = data.rule
  const sev = SEV[r.severity] || SEV.medium
  const groups = {
    fail:           data.devices.filter(d => d.status === 'fail'),
    not_applicable: data.devices.filter(d => d.status === 'not_applicable'),
    pass:           data.devices.filter(d => d.status === 'pass'),
  }

  b.innerHTML = `
    <div class="m-panel" style="padding:14px;display:flex;align-items:center;gap:12px">
      <i class="ti ti-shield" style="font-size:24px;color:${sev.color};flex-shrink:0"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600">${esc(r.label)}</div>
        <div style="font-size:11px;color:var(--text-tertiary);font-family:monospace">${esc(r.id)}</div>
      </div>
      <span class="m-pill" style="background:${sev.color}22;color:${sev.color}">${t(sev.key)}</span>
    </div>
    ${section(groups.fail,           'fail',           'ti-shield-x',        'var(--red)')}
    ${section(groups.not_applicable, 'not_applicable', 'ti-shield-question', 'var(--text-tertiary)')}
    ${section(groups.pass,           'pass',           'ti-shield-check',    'var(--green)')}`
}

function section(rows, status, icon, color) {
  if (!rows.length) return ''
  return `
    <div class="m-section" style="color:${color}">
      <i class="ti ${icon}"></i> ${t('mobile.conformite.status.' + status)} (${rows.length})
    </div>
    ${rows.map(d => deviceRow(d, color, status)).join('')}`
}

function deviceRow(d, color, status) {
  const valueHint = status === 'fail' && d.value && Object.keys(d.value).length
    ? `<div style="font-size:10px;color:var(--text-tertiary);font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(JSON.stringify(d.value))}</div>`
    : ''
  return `
    <div class="m-device-card" onclick="window.location.hash='#/poste/${esc(d.device_id)}'">
      <i class="ti ti-device-laptop" style="color:${color};flex-shrink:0;font-size:18px"></i>
      <div class="m-device-info">
        <div class="m-device-name">${esc(d.hostname)}</div>
        ${d.user_name ? `<div class="m-device-sub">${esc(d.user_name)}</div>` : ''}
        ${valueHint}
      </div>
      <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:12px;flex-shrink:0"></i>
    </div>`
}

function errorBox(e) {
  return `<div style="text-align:center;color:var(--red);padding:30px;font-size:13px">${t('mobile.conformite.error')} : ${esc(e.message || '')}</div>`
}
