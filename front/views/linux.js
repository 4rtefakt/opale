// File minimale ; les vues parc / détail arriveront avec PR 6.
export async function renderLinux(container) {
  let rows = []
  const selected = new Set()
  let refreshVersion = 0
  container.innerHTML = `
    <div class="topbar">
      <div class="topbar-left"><h1 class="page-title">${esc(t('nav.linux'))}</h1><span class="badge badge-orange" id="linux-count">${esc(t('linux.queue.pending', { n: '…' }))}</span></div>
      <div class="topbar-actions"><button class="btn" onclick="linuxRefresh()"><i class="ti ti-refresh"></i> ${esc(t('linux.queue.refresh'))}</button></div>
    </div>
    <div class="bulk-bar" id="linux-bulk">
      <span class="bulk-count" id="linux-selected"></span>
      <div class="bulk-actions">
        <button class="btn" onclick="linuxApprove()">${esc(t('linux.queue.approve_selected'))}</button>
        <button class="btn btn-danger" onclick="linuxReject()">${esc(t('linux.queue.reject_selected'))}</button>
      </div>
    </div>
    <div class="table-wrap" id="linux-table"></div>`
  const table = container.querySelector('#linux-table')

  function updateSelection() {
    container.querySelector('#linux-bulk').classList.toggle('show', selected.size > 0)
    container.querySelector('#linux-selected').textContent = t('linux.queue.selected', { n: selected.size })
    const all = container.querySelector('#linux-all')
    if (all) {
      all.checked = rows.length > 0 && selected.size === rows.length
      all.indeterminate = selected.size > 0 && selected.size < rows.length
    }
    table.querySelectorAll('[data-enrollment]').forEach(cb => {
      cb.checked = selected.has(cb.dataset.enrollment)
      cb.closest('tr').classList.toggle('selected', cb.checked)
    })
  }

  async function refresh() {
    const version = ++refreshVersion
    table.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2"></i> ${esc(t('linux.queue.loading'))}</div>`
    selected.clear()
    updateSelection()
    try {
      // La file est plafonnée à 500 côté serveur ; charger toute la sélection.
      const [data, count] = await Promise.all([
        window.api.getLinuxEnrollments({ status: 'pending', limit: 500 }),
        window.api.getLinuxEnrollmentsCount(),
      ])
      if (!table.isConnected || version !== refreshVersion) return
      rows = data.rows
      container.querySelector('#linux-count').textContent = t('linux.queue.pending', { n: count.pending })
      window.setLinuxBadge(count.pending)
      table.innerHTML = rows.length ? `
        <table><thead><tr>
          <th><input type="checkbox" id="linux-all" aria-label="${esc(t('linux.queue.select_all'))}" onchange="linuxSelectAll(this.checked)"></th>
          ${['code', 'serial', 'hostname_claimed', 'os', 'agent', 'first_seen', 'last_seen', 'conflict', 'actions'].map(k => `<th>${esc(t('linux.queue.' + k))}</th>`).join('')}
        </tr></thead><tbody>${rows.map(row => `
          <tr>
            <td><input type="checkbox" data-enrollment="${esc(row.id)}" aria-label="${esc(t('linux.queue.select', { code: row.code }))}" onchange="linuxSelect(${jsArg(row.id)},this.checked)"></td>
            <td><button class="btn btn-sm" style="font-family:var(--font-mono,monospace)" title="${esc(t('linux.queue.copy'))}" onclick="linuxCopy(${jsArg(row.code)})">${esc(row.code)} <i class="ti ti-copy"></i></button></td>
            <td>${esc(row.serial_claimed || '—')}</td><td>${esc(row.hostname_claimed || '—')}</td>
            <td>${esc(row.os_version || '—')}</td><td>${esc(row.agent_version || '—')}</td>
            <td>${esc(formatRelative(row.first_seen_at))}</td><td>${esc(formatRelative(row.last_seen_at))}</td>
            <td>${row.conflict ? `<span class="badge badge-orange">${esc(t('linux.queue.conflict.' + row.conflict.kind, { hostname: row.conflict.hostname || '—' }))}</span>` : ''}
                ${row.preregistration ? `<span class="badge badge-blue">${esc(t('linux.queue.preregistered'))}</span>` : ''}</td>
            <td><div style="display:flex;gap:6px"><button class="btn btn-sm btn-primary" onclick="linuxApprove(${jsArg(row.id)})">${esc(t('linux.queue.approve'))}</button>
                <button class="btn btn-sm" onclick="linuxReject(${jsArg(row.id)})">${esc(t('linux.queue.reject'))}</button></div></td>
          </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><i class="ti ti-check"></i><p>${esc(t('linux.queue.empty'))}</p></div>`
    } catch (err) {
      if (table.isConnected && version === refreshVersion) table.innerHTML = `<div class="empty-state"><p>${esc(err.message || t('error.generic'))}</p><button class="btn" onclick="linuxRefresh()">${esc(t('linux.queue.refresh'))}</button></div>`
    }
  }

  function openAction(id, approve) {
    const row = id ? rows.find(r => r.id === id) : null
    const ids = id ? [id] : [...selected]
    if (!ids.length || (id && !row)) return
    const bulk = !id
    const pre = row?.preregistration
    const conflict = row?.conflict
    let pickedUser = pre?.assigned_user || null
    const title = t('linux.queue.' + (approve ? (bulk ? 'approve_selected' : 'approve') : (bulk ? 'reject_selected' : 'reject')))
    showModal(`
      <form id="linux-action-form">
        <div class="modal-title">${esc(title)}${row ? ` · ${esc(row.code)}` : ''}</div>
        <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:12px">
          ${approve ? `
            <div class="form-row"><label class="form-label" for="linux-profile">${esc(t('linux.queue.profile'))}</label>
              <input class="form-input" id="linux-profile" required maxlength="64" pattern="^[a-z0-9][a-z0-9\\-]{0,63}$" value="${esc(pre?.profile || '')}" title="${esc(t('linux.queue.profile_hint'))}"></div>
            <div class="form-row"><label class="form-label" for="linux-ring">${esc(t('linux.queue.ring'))}</label>
              <select class="form-select" id="linux-ring"><option value="pilot">${esc(t('linux.queue.ring.pilot'))}</option><option value="stable" ${pre?.ring === 'stable' ? 'selected' : ''}>${esc(t('linux.queue.ring.stable'))}</option></select></div>
            ${bulk ? `<p class="modal-sub">${esc(t('linux.queue.bulk_conflicts'))}</p>` : `
              <div class="form-row"><label class="form-label" for="linux-hostname">${esc(t('linux.queue.hostname'))}</label>
                <input class="form-input" id="linux-hostname" maxlength="63" pattern="^[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?$" value="${esc(pre?.hostname || '')}"></div>
              <div class="form-row"><label class="form-label" for="linux-user">${esc(t('linux.queue.user'))}</label>
                <input class="form-input" id="linux-user" autocomplete="off" placeholder="${esc(t('tickets.requester.search'))}" value="${esc(pickedUser?.display_name || pickedUser?.email || '')}">
                <div id="linux-users" class="pick-list" style="display:none"></div></div>
              ${conflict ? `<p class="modal-sub">${esc(t('linux.queue.conflict.' + conflict.kind, { hostname: conflict.hostname || '—' }))}</p>` : ''}
              ${conflict?.kind === 'existing_device' ? `
                <label><input type="checkbox" role="switch" id="linux-convert"> ${esc(t('linux.queue.convert', { hostname: conflict.hostname || '—' }))}</label>
                ${conflict.has_active_token ? `<label><input type="checkbox" role="switch" id="linux-revoke"> ${esc(t('linux.queue.revoke_token'))}</label>` : ''}` : ''}
              ${conflict?.kind === 'reimage' ? `<label><input type="checkbox" role="switch" id="linux-supersede"> ${esc(t('linux.queue.supersede'))}</label>` : ''}
            `}
          ` : `
            <p>${esc(t('linux.queue.reject_confirm', { n: ids.length }))}</p>
            <div class="form-row"><label class="form-label" for="linux-reason">${esc(t('linux.queue.reason'))}</label><textarea class="form-textarea" id="linux-reason" maxlength="500"></textarea></div>
          `}
          <p id="linux-action-error" role="alert" style="color:var(--red);margin:0"></p>
          <div class="modal-footer"><button type="button" class="btn" onclick="closeModal()">${esc(t('btn.cancel'))}</button><button type="submit" class="btn ${approve ? 'btn-primary' : 'btn-danger'}">${esc(title)}</button></div>
        </fieldset>
      </form>`)
    const form = document.getElementById('linux-action-form')
    const fieldset = form.querySelector('fieldset')
    const error = form.querySelector('#linux-action-error')
    const userInput = form.querySelector('#linux-user')
    // Même recherche / pick-list que le demandeur des tickets ; invalider le
    // choix dès qu'on retape pour ne jamais envoyer un utilisateur invisible.
    if (userInput) {
      const list = form.querySelector('#linux-users')
      let timer, searchVersion = 0
      userInput.addEventListener('input', () => {
        clearTimeout(timer)
        const version = ++searchVersion
        pickedUser = null
        const q = userInput.value.trim()
        list.style.display = 'none'
        if (q.length < 2) return
        timer = setTimeout(async () => {
          try {
            const users = await window.api.searchUsers(q)
            if (!form.isConnected || version !== searchVersion) return
            list.innerHTML = users.map(u => `<button type="button" class="pick-row" onclick="linuxPickUser(${jsArg(u.entra_id)},${jsArg(u.display_name || u.email)})"><span class="t">${esc(u.display_name || u.email)}</span><span class="s">${esc(u.email || '')}</span></button>`).join('') || `<div class="pick-row">${esc(t('tickets.assignee.no_match'))}</div>`
            list.style.display = ''
          } catch (err) {
            if (form.isConnected && version === searchVersion) error.textContent = err.message
          }
        }, 200)
      })
      window.linuxPickUser = (entra_id, display_name) => {
        ++searchVersion
        pickedUser = { entra_id, display_name }
        userInput.value = display_name
        list.style.display = 'none'
        error.textContent = ''
      }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (fieldset.disabled) return
      const body = bulk ? { ids } : {}
      if (approve) {
        body.profile = form.querySelector('#linux-profile').value
        body.ring = form.querySelector('#linux-ring').value
        if (!bulk) {
          if (userInput.value.trim() && !pickedUser) {
            error.textContent = t('linux.queue.pick_user')
            return
          }
          const hostname = form.querySelector('#linux-hostname').value.trim()
          if (hostname) body.hostname = hostname
          body.assigned_user_id = pickedUser?.entra_id || null
          if (form.querySelector('#linux-convert')?.checked) body.convert_device_id = conflict.device_id
          if (form.querySelector('#linux-revoke')?.checked) body.revoke_active_token = true
          if (form.querySelector('#linux-supersede')?.checked) body.supersede = true
        }
      } else {
        const reason = form.querySelector('#linux-reason').value.trim()
        if (reason) body.reason = reason
      }
      fieldset.disabled = true
      error.textContent = ''
      try {
        const result = approve
          ? await (bulk ? window.api.approveLinuxEnrollmentsBulk(body) : window.api.approveLinuxEnrollment(id, body))
          : await (bulk ? window.api.rejectLinuxEnrollmentsBulk(body) : window.api.rejectLinuxEnrollment(id, body))
        const failures = bulk ? result.errors : []
        if (form.isConnected) {
          if (failures.length) {
            // Conserver les erreurs par ligne (dont CONFLICT) après le refresh.
            showModal(`<div class="modal-title">${esc(t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }))}</div>
              <div class="pick-list">${failures.map(e => `<div class="pick-row"><div class="t">${esc(rows.find(r => r.id === e.id)?.code || e.id)} · ${esc(e.code)}</div><div class="s">${esc(e.message || t('linux.queue.bulk_error'))}</div></div>`).join('')}</div>
              <div class="modal-footer"><button class="btn" onclick="closeModal()">${esc(t('linux.queue.close'))}</button></div>`)
          } else {
            closeModal()
            showToast(bulk ? t('linux.queue.bulk_result', { ok: result.ok, skipped: result.skipped }) : t(approve ? 'linux.queue.approved' : 'linux.queue.rejected'), 'success')
          }
        }
        if (table.isConnected) await refresh()
      } catch (err) {
        // ApiError.message contient le champ API `error`, notamment en 409.
        error.textContent = err.message || t('error.generic')
        fieldset.disabled = false
      }
    })
  }

  window.linuxRefresh = refresh
  window.linuxSelect = (id, checked) => { checked ? selected.add(id) : selected.delete(id); updateSelection() }
  window.linuxSelectAll = checked => { rows.forEach(r => checked ? selected.add(r.id) : selected.delete(r.id)); updateSelection() }
  window.linuxApprove = id => openAction(id, true)
  window.linuxReject = id => openAction(id, false)
  window.linuxCopy = async code => {
    try { await navigator.clipboard.writeText(code); showToast(t('linux.queue.copied'), 'success') }
    catch { showToast(t('linux.queue.copy_error'), 'error') }
  }
  await refresh()
}
