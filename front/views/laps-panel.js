// Panneau « Compte de récupération » (LAPS Windows / admin local Linux) et
// modal de motif des accès sensibles, partagés par la fiche poste (poste.js)
// et la fiche du poste Linux (linux-device.js). Le champ `laps` a la même
// forme sur GET /api/devices/:id et GET /api/linux/devices/:id.
//
// Les handlers inline du panneau (lapsViewPassword / lapsRequestRotation)
// sont exposés sur window par chaque vue, liés à son device courant.

export function lapsPanel(d) {
  if (!window.appState?.user?.isAdmin || !d.laps) return ''
  const l = d.laps
  const lapsRow = (icon, label, value) => `
    <div style="display:flex;flex-direction:column;gap:1px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.04em">${label}</span>
      <span style="font-size:12px;font-weight:500;word-break:break-all">${value}</span>
    </div>`
  return `
    <div class="panel">
      <div class="panel-header">
        <i class="ti ti-key" style="margin-right:6px"></i>Compte de récupération
        <span class="badge" style="margin-left:auto;font-size:10px">Admin</span>
      </div>
      <div style="padding:4px 16px 0">
        ${lapsRow('ti-user-shield', 'Utilisateur', esc(l.username))}
        ${l.password_changed_at ? lapsRow('ti-calendar-time', 'Dernière rotation', esc(formatRelative(l.password_changed_at))) : ''}
        ${l.last_viewed_at ? lapsRow('ti-eye', 'Dernier accès', esc(formatRelative(l.last_viewed_at)) + (l.last_viewed_by_name ? ` <span style="color:var(--text-tertiary)">par ${esc(l.last_viewed_by_name)}</span>` : '')) : ''}
        ${l.rotation_requested_at ? lapsRow('ti-refresh', 'Rotation demandée', `<span class="badge badge-orange">${esc(formatRelative(l.rotation_requested_at))}</span>`) : ''}
      </div>
      <div style="display:flex;gap:8px;padding:10px 16px 12px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="lapsViewPassword()">
          <i class="ti ti-eye"></i> Voir le mot de passe
        </button>
        <button class="btn btn-sm" style="color:var(--orange)" onclick="lapsRequestRotation()">
          <i class="ti ti-refresh"></i> Demander rotation
        </button>
      </div>
    </div>`
}

export async function lapsViewPassword(device) {
  if (!device) return
  // Motif obligatoire avant toute révélation (même modal que SSH / console) :
  // le serveur le journalise dans laps_viewed avant d'envoyer le secret.
  const reason = await promptRemoteReason('laps', device.hostname)
  if (!reason) return
  try {
    const cred = await window.api.revealAdminCredential(device.id, reason)
    let remaining = 30
    showModal(`
      <div class="modal-title"><i class="ti ti-key"></i> Compte de récupération</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-row">
          <label class="form-label">Utilisateur</label>
          <input class="form-input" id="laps-user-field" readonly>
        </div>
        <div class="form-row">
          <label class="form-label">Mot de passe</label>
          <div style="display:flex;gap:8px">
            <input class="form-input" id="laps-pwd-field" readonly type="password" style="font-family:monospace;letter-spacing:.1em;flex:1">
            <button class="btn btn-sm" onclick="window.lapsTogglePwd()" title="Afficher"><i class="ti ti-eye"></i></button>
            <button class="btn btn-sm btn-primary" onclick="window.lapsCopyPwd()"><i class="ti ti-copy"></i> Copier</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);text-align:center;background:var(--bg-secondary);border-radius:6px;padding:6px">
          Effacement automatique dans <span id="laps-countdown">${remaining}</span>s — pensez à rotater après usage
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Fermer</button>
      </div>`)
    // Injecter les valeurs via DOM (jamais dans l'HTML — sécurité)
    document.getElementById('laps-user-field').value = cred.username
    document.getElementById('laps-pwd-field').value  = cred.password
    window.lapsTogglePwd = () => {
      const f = document.getElementById('laps-pwd-field')
      if (f) f.type = f.type === 'password' ? 'text' : 'password'
    }
    window.lapsCopyPwd = () => {
      navigator.clipboard.writeText(cred.password)
        .then(() => showToast('Mot de passe copié', 'success'))
    }
    const iv = setInterval(() => {
      remaining--
      const el = document.getElementById('laps-countdown')
      if (el) el.textContent = remaining
      if (remaining <= 0 || !el) { clearInterval(iv); if (el) closeModal() }
    }, 1000)
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

// `reload` : recharge la fiche appelante une fois la rotation demandée.
export async function lapsRequestRotation(device, reload) {
  if (!device) return
  if (!confirm('Demander une rotation du mot de passe de récupération ?\nLa rotation sera effective au prochain checkin de l\'agent (max 15 min).')) return
  try {
    await window.api.rotateAdminCredential(device.id)
    showToast('Rotation demandée — effective au prochain checkin', 'success')
    await reload()
  } catch (err) {
    showToast(err.message || t('error.generic'), 'error')
  }
}

// Modal de saisie du motif d'ouverture d'une session distante (console
// SYSTEM ou SSH) ou de révélation d'un secret (mot de passe de récupération
// `laps`, clé de récupération LUKS `recovery`).
// Note obligatoire à chaque ouverture (≥ 5 caractères) — la catégorie est
// persistée en localStorage pour éviter de re-cliquer à chaque session,
// mais la note est toujours re-saisie pour forcer une vraie justification.
//
// Résout { category, note } si validé, null si annulé.
const REASON_LABELS = {
  console:  { title: 'remote.reason.title_console',  warn: 'remote.reason.warn_console',  ok: 'remote.reason.open' },
  ssh:      { title: 'remote.reason.title_ssh',      warn: 'remote.reason.warn_ssh',      ok: 'remote.reason.open' },
  laps:     { title: 'remote.reason.title_laps',     warn: 'remote.reason.warn_laps',     ok: 'remote.reason.reveal' },
  recovery: { title: 'remote.reason.title_recovery', warn: 'remote.reason.warn_recovery', ok: 'remote.reason.reveal' },
}
export function promptRemoteReason(kind, hostname) {
  return new Promise(resolve => {
    const STORAGE_KEY = 'remote-reason-last-category'
    const lastCat = localStorage.getItem(STORAGE_KEY) || 'troubleshoot'
    const labels = REASON_LABELS[kind] || REASON_LABELS.ssh
    const title = t(labels.title, { host: hostname })
    const warn = t(labels.warn)
    const categories = [
      { id: 'maintenance',  label: t('remote.reason.cat.maintenance') },
      { id: 'troubleshoot', label: t('remote.reason.cat.troubleshoot') },
      { id: 'audit',        label: t('remote.reason.cat.audit') },
      { id: 'incident',     label: t('remote.reason.cat.incident') },
      { id: 'other',        label: t('remote.reason.cat.other') },
    ]

    const modal = document.createElement('div')
    modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;
      display:flex;align-items:center;justify-content:center`
    modal.innerHTML = `
      <div style="background:var(--panel-bg,#1e2030);padding:22px;border-radius:8px;
        max-width:480px;width:100%;border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.4)">
        <h3 style="margin:0 0 8px;font-size:15px;font-weight:600">${esc(title)}</h3>
        <p style="margin:0 0 16px;color:var(--text-secondary,#aaa);font-size:12px;line-height:1.5">
          <i class="ti ti-shield-lock" style="vertical-align:-2px;margin-right:4px"></i>
          ${esc(warn)}
        </p>
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">${esc(t('remote.reason.category_label'))}</div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:14px">
          ${categories.map(c => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="radio" name="rr-cat" value="${c.id}" ${c.id === lastCat ? 'checked' : ''}>
              ${esc(c.label)}
            </label>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:6px">
          ${esc(t('remote.reason.note_label'))}
        </div>
        <textarea id="rr-note" rows="3" maxlength="500"
          placeholder="${esc(t('remote.reason.note_placeholder'))}"
          style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);
            background:var(--bg-primary);color:var(--text-primary);font-size:13px;font-family:inherit;
            box-sizing:border-box;resize:vertical;min-height:62px"></textarea>
        <div id="rr-err" style="color:var(--red);font-size:11px;margin-top:4px;display:none"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="btn btn-sm" id="rr-cancel">${esc(t('btn.cancel'))}</button>
          <button class="btn btn-primary btn-sm" id="rr-ok">${esc(t(labels.ok))}</button>
        </div>
      </div>`
    document.body.appendChild(modal)

    const ta = modal.querySelector('#rr-note')
    setTimeout(() => ta.focus(), 50)

    const cleanup = (val) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(val) }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(null) }
    document.addEventListener('keydown', onKey)

    modal.querySelector('#rr-cancel').onclick = () => cleanup(null)
    modal.querySelector('#rr-ok').onclick = () => {
      const category = modal.querySelector('input[name="rr-cat"]:checked')?.value || lastCat
      const note = ta.value.trim()
      if (note.length < 5) {
        const err = modal.querySelector('#rr-err')
        err.textContent = t('remote.reason.err_too_short')
        err.style.display = 'block'
        ta.focus()
        return
      }
      try { localStorage.setItem(STORAGE_KEY, category) } catch {}
      cleanup({ category, note })
    }
  })
}
