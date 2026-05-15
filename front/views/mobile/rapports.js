// Vue mobile Rapports — version condensée du desktop, focus sur les KPIs
// agrégés et la posture sécurité. Pas de chart Chart.js (trop coûteux mobile).

export async function renderRapports(el) {
  el.innerHTML = `
    <div class="m-header">
      <button class="m-icon-btn" onclick="history.back()">
        <i class="ti ti-arrow-left"></i>
      </button>
      <h1>${t('rapports.title')}</h1>
    </div>
    <div class="m-scroll" id="m-rapports-body">
      <div style="display:flex;justify-content:center;padding:40px"><div class="m-spinner"></div></div>
    </div>`

  try {
    const d = await window.api.getRapports()
    const body = document.getElementById('m-rapports-body')
    if (!body) return
    body.innerHTML = render(d)
  } catch (err) {
    const body = document.getElementById('m-rapports-body')
    if (body) body.innerHTML = `<div style="text-align:center;color:var(--red);padding:20px">${esc(err.message || t('error.generic'))}</div>`
  }
}

function render(d) {
  const k = d.kpis
  const totalParc = k.parc.total
  const score     = k.security_score

  return `
    <!-- Hero : temps épargné -->
    <div class="m-panel" style="background:linear-gradient(135deg,var(--green-bg) 0%,transparent 100%);border-color:rgba(29,158,117,0.4);padding:14px 16px">
      <div style="font-size:11px;color:var(--green-text);font-weight:500;margin-bottom:6px">
        <i class="ti ti-clock-hour-4"></i> ${t('rapports.kpi.time_saved')}
      </div>
      <div style="font-size:28px;font-weight:700;color:var(--green-text);line-height:1">
        ${formatHours(k.time_saved.minutes)}
      </div>
      <div style="font-size:12px;color:var(--green-text);margin-top:4px">
        ≈ ${k.time_saved.eur.toLocaleString('fr-FR')} € · ${k.actions_count.toLocaleString('fr-FR')} actions
      </div>
    </div>

    <!-- 3 stats rapides -->
    <div class="m-stat-row">
      <div class="m-stat-card">
        <div class="m-stat-val">${k.parc.active_7d}<span style="font-size:14px;font-weight:400;color:var(--text-tertiary)">/${totalParc}</span></div>
        <div class="m-stat-lbl">Parc actif</div>
      </div>
      <div class="m-stat-card">
        <div class="m-stat-val" style="color:${scoreColor(score)}">${score == null ? '—' : score + ' %'}</div>
        <div class="m-stat-lbl">Sécurité</div>
      </div>
      <div class="m-stat-card">
        <div class="m-stat-val">${k.actions_count}</div>
        <div class="m-stat-lbl">Actions 30j</div>
      </div>
    </div>

    <!-- Conformité (compacte) -->
    ${d.compliance?.length ? `
      <div class="m-section">${t('rapports.sec.security')}</div>
      <div class="m-panel">
        ${d.compliance.map(c => renderComplianceRow(c, totalParc)).join('')}
      </div>
    ` : ''}

    <!-- Top disques -->
    ${d.disk_top?.length ? `
      <div class="m-section">${t('rapports.disk.title')}</div>
      <div class="m-panel">
        ${d.disk_top.map(r => renderDiskRow(r)).join('')}
      </div>
    ` : ''}

    <!-- Batterie -->
    ${d.battery?.total ? `
      <div class="m-section">${t('rapports.battery.title')}</div>
      <div class="m-panel">
        ${renderBatteryRow(t('rapports.battery.good'),     d.battery.good,     'var(--green)', d.battery.total)}
        ${renderBatteryRow(t('rapports.battery.degraded'), d.battery.degraded, 'var(--amber)', d.battery.total)}
        ${renderBatteryRow(t('rapports.battery.critical'), d.battery.critical, 'var(--red)',   d.battery.total)}
      </div>
    ` : ''}
  `
}

function renderComplianceRow(c, total) {
  const denom = c.ok + c.ko
  const pct   = denom > 0 ? Math.round((c.ok / denom) * 100) : null
  const color = pct == null ? 'var(--text-tertiary)'
              : pct >= 80   ? 'var(--green)'
              : pct >= 60   ? 'var(--amber)'
              : 'var(--red)'

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:0.5px solid var(--border)">
      <span style="flex:1;font-size:12px;color:var(--text-secondary)">${t('rapports.compliance.row.' + c.key)}</span>
      <span style="font-size:12px;font-weight:600;color:${color};min-width:40px;text-align:right">
        ${pct == null ? '—' : pct + ' %'}
      </span>
      <span style="font-size:10px;color:var(--text-tertiary);min-width:60px;text-align:right">
        ${c.ok}/${denom || '—'}${c.na > 0 ? ` · ${c.na} N/R` : ''}
      </span>
    </div>`
}

function renderDiskRow(r) {
  const pct   = parseInt(r.disk_used_pct)
  const color = pct >= 90 ? 'var(--red)'
              : pct >= 75 ? 'var(--amber)'
              :             'var(--green)'
  return `
    <div onclick="navigateTo('/postes/${esc(r.id)}')" style="display:flex;flex-direction:column;gap:5px;padding:10px 14px;border-bottom:0.5px solid var(--border);cursor:pointer">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <code style="font-size:11px;color:var(--text-primary);font-weight:500">${esc(r.hostname || '?')}</code>
        <span style="font-size:12px;font-weight:600;color:${color}">${pct} %</span>
      </div>
      <div style="height:6px;background:var(--bg-tertiary);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:99px"></div>
      </div>
    </div>`
}

function renderBatteryRow(label, count, color, total) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:0.5px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
      <span style="flex:1;font-size:12px;color:var(--text-secondary)">${label}</span>
      <span style="font-size:12px;font-weight:600">${count}</span>
      <span style="font-size:10px;color:var(--text-tertiary);min-width:36px;text-align:right">${pct} %</span>
    </div>`
}

function scoreColor(score) {
  if (score == null)   return 'var(--text-tertiary)'
  if (score >= 80)     return 'var(--green)'
  if (score >= 60)     return 'var(--amber)'
  return 'var(--red)'
}

function formatHours(minutes) {
  if (minutes < 60) return `${minutes} min`
  const h = Math.round(minutes / 60)
  return `${h} h`
}
