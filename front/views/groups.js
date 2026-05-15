// Vue /groupes — gestion des groupes natifs.
//
// Layout : topbar + split [liste gauche | carte SVG + détail droit].
// La carte SVG utilise un algorithme de force simple (répulsion seule)
// pour positionner les groupes comme des bulles colorées, dimensionnées
// proportionnellement au nombre de membres.
// Cliquer une bulle ou une carte sélectionne le groupe et charge son
// détail (membres devices + users) dans le panneau de droite.

const PALETTE = {
  slate:  { bg: '#475569', light: '#f1f5f9', dark: '#e2e8f0' },
  blue:   { bg: '#2563eb', light: '#eff6ff', dark: '#dbeafe' },
  green:  { bg: '#059669', light: '#ecfdf5', dark: '#d1fae5' },
  amber:  { bg: '#d97706', light: '#fffbeb', dark: '#fef3c7' },
  red:    { bg: '#dc2626', light: '#fef2f2', dark: '#fee2e2' },
  violet: { bg: '#7c3aed', light: '#f5f3ff', dark: '#ede9fe' },
  pink:   { bg: '#db2777', light: '#fdf2f8', dark: '#fce7f3' },
  teal:   { bg: '#0d9488', light: '#f0fdfa', dark: '#ccfbf1' },
}
const COLOR_LABELS = {
  slate: 'Gris', blue: 'Bleu', green: 'Vert', amber: 'Ambre',
  red: 'Rouge', violet: 'Violet', pink: 'Rose', teal: 'Sarcelle',
}
const COLOR_KEYS = Object.keys(PALETTE)

let _groups   = []
let _selected = null   // group id sélectionné
let _detail   = null   // { devices, users } du groupe sélectionné

export async function renderGroupes(container) {
  container.innerHTML = `
    <div class="topbar">
      <h1 class="topbar-title">Groupes</h1>
      <div class="topbar-actions">
        <button class="btn" onclick="groupesImportFromEntra()">
          <i class="ti ti-cloud-download"></i> Importer depuis Entra
        </button>
        <button class="btn btn-primary" onclick="groupesOpenCreate()">
          <i class="ti ti-plus"></i> Nouveau groupe
        </button>
      </div>
    </div>
    <div style="flex:1;display:flex;overflow:hidden">
      <div id="grp-sidebar" style="width:272px;min-width:272px;border-right:0.5px solid var(--border);overflow-y:auto;padding:12px 8px"></div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div id="grp-map" style="flex:0 0 auto;height:340px;position:relative;border-bottom:0.5px solid var(--border)">
          <svg id="grp-svg" width="100%" height="100%" style="display:block"></svg>
          <div id="grp-map-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:13px;pointer-events:none;display:none">
            Aucun groupe — créez-en un pour commencer.
          </div>
        </div>
        <div id="grp-detail" style="flex:1;overflow-y:auto;padding:16px 20px"></div>
      </div>
    </div>`

  window.groupesOpenCreate      = groupesOpenCreate
  window.groupesOpenEdit        = groupesOpenEdit
  window.groupesConfirmDelete   = groupesConfirmDelete
  window.groupesSelectGroup     = groupesSelectGroup
  window.groupesAddDevice       = groupesAddDevice
  window.groupesAddUser         = groupesAddUser
  window.groupesRemoveMember    = groupesRemoveMember
  window.groupesImportFromEntra = groupesImportFromEntra
  window.groupesSyncFromEntra   = groupesSyncFromEntra
  window.groupesDetachFromEntra = groupesDetachFromEntra

  await loadGroups()
}

// ─── Chargement & rendu ──────────────────────────────────────────────────────

async function loadGroups(keepSelected = false) {
  try {
    _groups = await window.api.getGroups()
  } catch (e) {
    showError(e)
    return
  }
  if (!keepSelected) _selected = null
  renderSidebar()
  renderMap()
  if (_selected) {
    await loadDetail(_selected)
  } else {
    document.getElementById('grp-detail').innerHTML =
      `<p style="color:var(--text-tertiary);font-size:13px">Cliquez sur un groupe pour voir ses membres.</p>`
  }
}

function renderSidebar() {
  const el = document.getElementById('grp-sidebar')
  if (!el) return
  if (_groups.length === 0) {
    el.innerHTML = `<p style="color:var(--text-tertiary);font-size:12px;padding:8px 4px">Aucun groupe.</p>`
    return
  }
  el.innerHTML = _groups.map(g => {
    const p = PALETTE[g.color] || PALETTE.slate
    const isActive = _selected === g.id
    return `
      <div class="grp-card${isActive ? ' grp-card-active' : ''}"
           onclick="groupesSelectGroup(${jsArg(g.id)})">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span style="width:10px;height:10px;border-radius:50%;background:${p.bg};flex-shrink:0"></span>
          <span style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <span style="font-size:11px;color:var(--text-tertiary)">${g.member_count} membre${g.member_count !== 1 ? 's' : ''}</span>
          <span style="flex:1"></span>
          <button class="icon-btn" title="Modifier" onclick="event.stopPropagation();groupesOpenEdit(${jsArg(g.id)})">
            <i class="ti ti-pencil" style="font-size:13px"></i>
          </button>
          <button class="icon-btn icon-btn-danger" title="Supprimer" onclick="event.stopPropagation();groupesConfirmDelete(${jsArg(g.id)},${jsArg(g.name)})">
            <i class="ti ti-trash" style="font-size:13px"></i>
          </button>
        </div>
      </div>`
  }).join('')
}

// ─── SVG bubble map ──────────────────────────────────────────────────────────

function renderMap() {
  const svg = document.getElementById('grp-svg')
  const empty = document.getElementById('grp-map-empty')
  if (!svg) return

  if (_groups.length === 0) {
    svg.innerHTML = ''
    if (empty) empty.style.display = 'flex'
    return
  }
  if (empty) empty.style.display = 'none'

  const W = svg.clientWidth  || svg.parentElement.clientWidth  || 600
  const H = svg.clientHeight || svg.parentElement.clientHeight || 340
  const cx = W / 2, cy = H / 2

  // Init positions en cercle
  const n = _groups.length
  const nodes = _groups.map((g, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    const spread = Math.min(cx, cy) * 0.55
    return {
      g,
      x: cx + spread * Math.cos(angle),
      y: cy + spread * Math.sin(angle),
      vx: 0, vy: 0,
      r: Math.max(38, Math.min(72, 22 + 7 * Math.sqrt(g.member_count || 0))),
    }
  })

  // Répulsion simple (80 itérations)
  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0
      // Répulsion inter-nœuds
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = nodes[i].x - nodes[j].x || 0.1
        const dy = nodes[i].y - nodes[j].y || 0.1
        const d2 = dx * dx + dy * dy
        const d  = Math.sqrt(d2)
        const minD = nodes[i].r + nodes[j].r + 24
        if (d < minD) {
          const f = (minD - d) * 0.5
          fx += (dx / d) * f
          fy += (dy / d) * f
        }
      }
      // Rappel vers le centre
      const dx = cx - nodes[i].x, dy = cy - nodes[i].y
      fx += dx * 0.02
      fy += dy * 0.02

      nodes[i].vx = (nodes[i].vx + fx) * 0.6
      nodes[i].vy = (nodes[i].vy + fy) * 0.6
      nodes[i].x += nodes[i].vx
      nodes[i].y += nodes[i].vy
    }
  }

  // Clamp dans le SVG
  for (const nd of nodes) {
    nd.x = Math.max(nd.r + 4, Math.min(W - nd.r - 4, nd.x))
    nd.y = Math.max(nd.r + 4, Math.min(H - nd.r - 4, nd.y))
  }

  // Rendu SVG
  svg.innerHTML = nodes.map(nd => {
    const p = PALETTE[nd.g.color] || PALETTE.slate
    const isActive = _selected === nd.g.id
    const stroke  = isActive ? p.bg : 'transparent'
    const opacity = _selected && !isActive ? 0.45 : 1
    const label   = nd.g.name.length > 14 ? nd.g.name.slice(0, 13) + '…' : nd.g.name
    // Détermine couleur texte selon luminosité
    const textColor = isActive ? p.bg : 'var(--text-primary)'
    return `
      <g style="cursor:pointer;opacity:${opacity};transition:opacity .2s"
         onclick="groupesSelectGroup(${jsArg(nd.g.id)})">
        <circle cx="${nd.x}" cy="${nd.y}" r="${nd.r}"
          fill="${p.light}" stroke="${stroke}" stroke-width="2.5"
          style="transition:all .2s"/>
        <text x="${nd.x}" y="${nd.y - 6}" text-anchor="middle"
          style="font-size:12px;font-weight:600;fill:${textColor};pointer-events:none;user-select:none">
          ${esc(label)}
        </text>
        <text x="${nd.x}" y="${nd.y + 11}" text-anchor="middle"
          style="font-size:11px;fill:${p.bg};pointer-events:none;user-select:none">
          ${nd.g.member_count} membre${nd.g.member_count !== 1 ? 's' : ''}
        </text>
      </g>`
  }).join('')
}

// ─── Sélection & détail ──────────────────────────────────────────────────────

async function groupesSelectGroup(id) {
  _selected = id
  renderSidebar()
  renderMap()
  await loadDetail(id)
}

async function loadDetail(id) {
  const panel = document.getElementById('grp-detail')
  if (!panel) return
  panel.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i></div>`
  try {
    _detail = await window.api.getGroup(id)
  } catch (e) {
    panel.innerHTML = `<p style="color:var(--red);font-size:13px">${esc(e.message)}</p>`
    return
  }
  renderDetail(panel)
}

function renderDetail(panel) {
  const g = _detail
  const p = PALETTE[g.color] || PALETTE.slate

  const deviceRows = g.devices.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:var(--text-tertiary);padding:12px">Aucun poste</td></tr>`
    : g.devices.map(d => `
        <tr>
          <td style="padding:6px 8px"><i class="ti ti-device-laptop" style="color:var(--text-tertiary)"></i></td>
          <td style="padding:6px 8px;font-weight:500">${esc(d.hostname || '—')}</td>
          <td style="padding:6px 8px;color:var(--text-secondary);font-size:12px">${esc(d.os || '—')}</td>
          <td style="padding:6px 8px;text-align:right">
            <button class="icon-btn icon-btn-danger" title="Retirer" onclick="groupesRemoveMember(${jsArg(g.id)},${jsArg(d.member_id)})">
              <i class="ti ti-x" style="font-size:12px"></i>
            </button>
          </td>
        </tr>`).join('')

  const userRows = g.users.length === 0
    ? `<tr><td colspan="3" style="text-align:center;color:var(--text-tertiary);padding:12px">Aucun utilisateur</td></tr>`
    : g.users.map(u => {
        const hasName = u.display_name || u.email
        return `
        <tr style="cursor:${hasName ? 'pointer' : 'default'}"
            ${hasName ? `onclick="navigateTo('/users/${esc(u.user_id)}')"` : ''}>
          <td style="padding:6px 8px"><i class="ti ti-user" style="color:var(--text-tertiary)"></i></td>
          <td style="padding:6px 8px">
            ${hasName
              ? `<div style="font-weight:500;font-size:13px">${esc(u.display_name || u.email)}</div>
                 <div style="font-size:11px;color:var(--text-secondary)">${esc(u.email || '')}</div>`
              : `<div style="font-size:12px;color:var(--text-tertiary);font-family:monospace">${esc(u.user_id)}</div>
                 <div style="font-size:11px;color:var(--text-tertiary)">Utilisateur non synchronisé</div>`
            }
          </td>
          <td style="padding:6px 8px;text-align:right" onclick="event.stopPropagation()">
            <button class="icon-btn icon-btn-danger" title="Retirer" onclick="groupesRemoveMember(${jsArg(g.id)},${jsArg(u.member_id)})">
              <i class="ti ti-x" style="font-size:12px"></i>
            </button>
          </td>
        </tr>`
      }).join('')

  const entraActions = g.source === 'entra' ? `
    <div style="display:flex;gap:6px;padding:8px 10px;background:var(--bg-secondary);border-radius:var(--radius-md);margin-bottom:14px;align-items:center;font-size:12px">
      <i class="ti ti-brand-azure" style="color:var(--blue);font-size:15px"></i>
      <span style="color:var(--text-secondary)">Synchronisé depuis Entra</span>
      <span style="flex:1"></span>
      <button class="btn btn-sm" onclick="groupesSyncFromEntra(${jsArg(g.id)})">
        <i class="ti ti-refresh"></i> Synchroniser
      </button>
      <button class="btn btn-sm" onclick="groupesDetachFromEntra(${jsArg(g.id)},${jsArg(g.name)})">
        <i class="ti ti-unlink"></i> Détacher
      </button>
    </div>` : ''

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span style="width:12px;height:12px;border-radius:50%;background:${p.bg};flex-shrink:0"></span>
      <h2 style="font-size:15px;font-weight:600;margin:0">${esc(g.name)}</h2>
      ${g.description ? `<span style="font-size:12px;color:var(--text-secondary)">${esc(g.description)}</span>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-sm" onclick="groupesOpenEdit(${jsArg(g.id)})">
        <i class="ti ti-pencil"></i> Modifier
      </button>
    </div>
    ${entraActions}

    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary)">Postes (${g.devices.length})</span>
        <button class="btn btn-sm" onclick="groupesAddDevice(${jsArg(g.id)})">
          <i class="ti ti-plus"></i> Ajouter un poste
        </button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${deviceRows}</tbody>
      </table>
    </div>

    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary)">Utilisateurs (${g.users.length})</span>
        <button class="btn btn-sm" onclick="groupesAddUser(${jsArg(g.id)})">
          <i class="ti ti-plus"></i> Ajouter un utilisateur
        </button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${userRows}</tbody>
      </table>
    </div>`
}

// ─── CRUD groupes ────────────────────────────────────────────────────────────

function groupesOpenCreate() {
  showModal(`
    <p class="modal-title">Nouveau groupe</p>
    ${groupForm()}
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="groupesSaveCreate()">Créer</button>
    </div>`)
  window.groupesSaveCreate = async () => {
    const name  = document.getElementById('grp-f-name').value.trim()
    const desc  = document.getElementById('grp-f-desc').value.trim()
    const color = document.getElementById('grp-f-color').value
    if (!name) { showFieldError('grp-f-name', 'Nom requis'); return }
    try {
      await window.api.createGroup({ name, description: desc || undefined, color })
      closeModal()
      showToast('Groupe créé', 'success')
      await loadGroups()
    } catch (e) {
      showModalError(e.message)
    }
  }
}

async function groupesOpenEdit(id) {
  const g = _groups.find(x => x.id === id) || _detail
  if (!g) return
  showModal(`
    <p class="modal-title">Modifier le groupe</p>
    ${groupForm({ name: g.name, description: g.description || '', color: g.color || 'slate' })}
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="groupesSaveEdit(${jsArg(id)})">Enregistrer</button>
    </div>`)
  window.groupesSaveEdit = async (gid) => {
    const name  = document.getElementById('grp-f-name').value.trim()
    const desc  = document.getElementById('grp-f-desc').value.trim()
    const color = document.getElementById('grp-f-color').value
    if (!name) { showFieldError('grp-f-name', 'Nom requis'); return }
    try {
      await window.api.updateGroup(gid, { name, description: desc || null, color })
      closeModal()
      showToast('Groupe mis à jour', 'success')
      const keepSel = _selected === gid
      await loadGroups(keepSel)
    } catch (e) {
      showModalError(e.message)
    }
  }
}

function groupesConfirmDelete(id, name) {
  showModal(`
    <p class="modal-title">Supprimer le groupe</p>
    <p style="font-size:13px;color:var(--text-secondary)">Supprimer <strong>${esc(name)}</strong> ? Cette action est irréversible. Les membres seront retirés du groupe mais les postes/utilisateurs ne seront pas supprimés.</p>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-danger" onclick="groupesDoDelete(${jsArg(id)})">Supprimer</button>
    </div>`)
  window.groupesDoDelete = async (gid) => {
    try {
      await window.api.deleteGroup(gid)
      closeModal()
      showToast('Groupe supprimé', 'success')
      if (_selected === gid) _selected = null
      await loadGroups()
    } catch (e) {
      showModalError(e.message)
    }
  }
}

// ─── Membres ─────────────────────────────────────────────────────────────────

async function groupesAddDevice(groupId) {
  let devices = []
  try { devices = await window.api.getDevices() } catch (_) {}
  const alreadyIn = new Set((_detail?.devices || []).map(d => d.device_id))
  const options = devices
    .filter(d => !alreadyIn.has(d.id))
    .map(d => `<option value="${esc(d.id)}">${esc(d.hostname)}</option>`)
    .join('')

  if (!options) {
    showModal(`
      <p class="modal-title">Ajouter un poste</p>
      <p style="font-size:13px;color:var(--text-secondary)">Tous les postes sont déjà dans ce groupe.</p>
      <div class="modal-footer"><button class="btn" onclick="closeModal()">Fermer</button></div>`)
    return
  }
  showModal(`
    <p class="modal-title">Ajouter un poste</p>
    <select class="form-input" id="grp-add-device" style="width:100%">
      <option value="">— Choisir un poste —</option>
      ${options}
    </select>
    <div id="grp-add-err" style="color:var(--red);font-size:12px;margin-top:6px;display:none"></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="groupesDoAddDevice(${jsArg(groupId)})">Ajouter</button>
    </div>`)
  window.groupesDoAddDevice = async (gid) => {
    const device_id = document.getElementById('grp-add-device').value
    if (!device_id) { showModalError('Sélectionnez un poste'); return }
    try {
      await window.api.addGroupMember(gid, { device_id })
      closeModal()
      showToast('Poste ajouté', 'success')
      await loadGroups(true)
    } catch (e) { showModalError(e.message) }
  }
}

async function groupesAddUser(groupId) {
  let users = []
  try { users = await window.api.getUsers() } catch (_) {}
  const alreadyIn = new Set((_detail?.users || []).map(u => u.user_id))
  const options = users
    .filter(u => !alreadyIn.has(u.entra_id))
    .map(u => `<option value="${esc(u.entra_id)}">${esc(u.display_name || u.entra_id)}</option>`)
    .join('')

  if (!options) {
    showModal(`
      <p class="modal-title">Ajouter un utilisateur</p>
      <p style="font-size:13px;color:var(--text-secondary)">Tous les utilisateurs sont déjà dans ce groupe.</p>
      <div class="modal-footer"><button class="btn" onclick="closeModal()">Fermer</button></div>`)
    return
  }
  showModal(`
    <p class="modal-title">Ajouter un utilisateur</p>
    <select class="form-input" id="grp-add-user" style="width:100%">
      <option value="">— Choisir un utilisateur —</option>
      ${options}
    </select>
    <div id="grp-add-err" style="color:var(--red);font-size:12px;margin-top:6px;display:none"></div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="groupesDoAddUser(${jsArg(groupId)})">Ajouter</button>
    </div>`)
  window.groupesDoAddUser = async (gid) => {
    const user_id = document.getElementById('grp-add-user').value
    if (!user_id) { showModalError('Sélectionnez un utilisateur'); return }
    try {
      await window.api.addGroupMember(gid, { user_id })
      closeModal()
      showToast('Utilisateur ajouté', 'success')
      await loadGroups(true)
    } catch (e) { showModalError(e.message) }
  }
}

async function groupesRemoveMember(groupId, memberId) {
  try {
    await window.api.removeGroupMember(groupId, memberId)
    showToast('Membre retiré', 'success')
    await loadGroups(true)
  } catch (e) {
    showToast(e.message, 'error')
  }
}

// ─── Entra import / sync / détachement ──────────────────────────────────────

function groupesImportFromEntra() {
  const colorOptions = COLOR_KEYS.map(k =>
    `<option value="${k}" ${k === 'slate' ? 'selected' : ''}>${COLOR_LABELS[k]}</option>`
  ).join('')

  showModal(`
    <p class="modal-title">Importer un groupe depuis Entra</p>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Groupe Entra *</label>
        <input class="form-input" id="grp-entra-q" placeholder="Rechercher un groupe…" autocomplete="off" style="width:100%">
        <div id="grp-entra-results" style="max-height:200px;overflow-y:auto;border:0.5px solid var(--border);border-radius:6px;margin-top:4px;display:none"></div>
        <input type="hidden" id="grp-entra-id">
        <div id="grp-entra-id-err" style="color:var(--red);font-size:12px;margin-top:3px;display:none"></div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Nom *</label>
        <input class="form-input" id="grp-entra-name" placeholder="Nom du groupe" style="width:100%">
        <div id="grp-entra-name-err" style="color:var(--red);font-size:12px;margin-top:3px;display:none"></div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Description</label>
        <input class="form-input" id="grp-entra-desc" placeholder="Optionnel" style="width:100%">
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Couleur</label>
        <select class="form-input" id="grp-entra-color" style="width:100%">${colorOptions}</select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="groupesDoImportFromEntra()">Importer</button>
    </div>`)

  const qInput   = document.getElementById('grp-entra-q')
  const results  = document.getElementById('grp-entra-results')
  const idInput  = document.getElementById('grp-entra-id')
  const nameInput = document.getElementById('grp-entra-name')
  setTimeout(() => qInput?.focus(), 50)

  let timer
  qInput.addEventListener('input', () => {
    clearTimeout(timer)
    idInput.value = ''
    const q = qInput.value.trim()
    if (q.length < 2) { results.style.display = 'none'; results.innerHTML = ''; return }
    timer = setTimeout(async () => {
      try {
        const groups = await window.api.searchGroups(q)
        results.style.display = groups.length ? 'block' : 'none'
        results.innerHTML = groups.length
          ? groups.map(g => `
              <div style="padding:8px 10px;cursor:pointer;border-bottom:0.5px solid var(--border)"
                   onmousedown="event.preventDefault();groupesPickEntraGroup(${jsArg(g.id)},${jsArg(g.displayName)},${jsArg(g.description||'')})">
                <div style="font-size:13px;font-weight:500">${esc(g.displayName)}</div>
                ${g.description ? `<div style="font-size:11px;color:var(--text-tertiary)">${esc(g.description)}</div>` : ''}
              </div>`).join('')
          : `<div style="padding:10px;color:var(--text-tertiary);font-size:12px">Aucun groupe trouvé</div>`
      } catch (e) {
        results.style.display = 'block'
        results.innerHTML = `<div style="padding:10px;color:var(--red);font-size:12px">${esc(e.message)}</div>`
      }
    }, 200)
  })

  window.groupesPickEntraGroup = (id, displayName, description) => {
    idInput.value   = id
    qInput.value    = displayName
    results.style.display = 'none'
    if (!nameInput.value) nameInput.value = displayName
    if (!document.getElementById('grp-entra-desc').value && description) {
      document.getElementById('grp-entra-desc').value = description
    }
  }

  window.groupesDoImportFromEntra = async () => {
    const entra_group_id = idInput.value.trim()
    const name           = nameInput.value.trim()
    const description    = document.getElementById('grp-entra-desc').value.trim() || undefined
    const color          = document.getElementById('grp-entra-color').value

    if (!entra_group_id) { showFieldError('grp-entra-id', 'Sélectionnez un groupe Entra'); return }
    if (!name)           { showFieldError('grp-entra-name', 'Nom requis'); return }

    try {
      const res = await window.api.importGroupFromEntra({ entra_group_id, name, description, color })
      closeModal()
      showToast(`Groupe importé — ${res.devices_imported} poste(s) importé(s)${res.unmatched ? `, ${res.unmatched} non trouvé(s)` : ''}`, 'success')
      await loadGroups()
    } catch (e) {
      showModalError(e.message)
    }
  }
}

async function groupesSyncFromEntra(groupId) {
  try {
    const res = await window.api.syncGroupFromEntra(groupId)
    showToast(`Synchronisé — ${res.devices_synced} poste(s), ${res.users_synced} utilisateur(s)${res.unmatched ? ` (${res.unmatched} postes non trouvés)` : ''}`, 'success')
    await loadGroups(true)
  } catch (e) {
    showToast(e.message, 'error')
  }
}

function groupesDetachFromEntra(groupId, name) {
  showModal(`
    <p class="modal-title">Détacher de Entra</p>
    <p style="font-size:13px;color:var(--text-secondary)">Détacher <strong>${esc(name)}</strong> de son groupe Entra source ? Le groupe deviendra natif et ne sera plus synchronisé automatiquement. Les membres actuels sont conservés.</p>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Annuler</button>
      <button class="btn btn-danger" onclick="groupesDoDetach(${jsArg(groupId)})">Détacher</button>
    </div>`)
  window.groupesDoDetach = async (gid) => {
    try {
      await window.api.detachGroupFromEntra(gid)
      closeModal()
      showToast('Groupe détaché de Entra', 'success')
      await loadGroups(true)
    } catch (e) {
      showModalError(e.message)
    }
  }
}

// ─── Helpers UI ──────────────────────────────────────────────────────────────

function groupForm({ name = '', description = '', color = 'slate' } = {}) {
  const colorOptions = COLOR_KEYS.map(k => {
    const p = PALETTE[k]
    return `<option value="${k}" ${k === color ? 'selected' : ''}>${COLOR_LABELS[k]}</option>`
  }).join('')
  return `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Nom *</label>
        <input class="form-input" id="grp-f-name" value="${esc(name)}" placeholder="Ex : Comptabilité" style="width:100%">
        <div id="grp-f-name-err" style="color:var(--red);font-size:12px;margin-top:3px;display:none"></div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Description</label>
        <input class="form-input" id="grp-f-desc" value="${esc(description)}" placeholder="Optionnel" style="width:100%">
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px">Couleur</label>
        <select class="form-input" id="grp-f-color" style="width:100%">${colorOptions}</select>
      </div>
    </div>`
}

function showFieldError(fieldId, msg) {
  const el = document.getElementById(`${fieldId}-err`)
  if (el) { el.textContent = msg; el.style.display = 'block' }
}

function showModalError(msg) {
  let el = document.getElementById('grp-modal-err')
  if (!el) {
    el = document.createElement('div')
    el.id = 'grp-modal-err'
    el.style.cssText = 'color:var(--red);font-size:12px;margin-top:8px'
    document.querySelector('#modal-content .modal-footer')?.before(el)
  }
  el.textContent = msg
}

function showError(e) {
  const body = document.getElementById('grp-detail')
  if (body) body.innerHTML = `<p style="color:var(--red);font-size:13px">Erreur : ${esc(e.message)}</p>`
}

function showToast(msg, type) { window.showToast(msg, type) }
