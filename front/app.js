import { initI18n, setLocale, getLocale, t } from '/i18n.js'
window.setLocale = setLocale
window.getLocale = getLocale
import '/auth.js'
import '/api.js'

window.t = t

// ─── Utilitaires globaux ───
// Échappe les 5 caractères dangereux pour insertion HTML (body, attributs,
// y compris dans un attribut onclick="fn('${esc(x)}')" — l'échappement de
// l'apostrophe ferme la classe de bugs où une valeur user-controlled
// casserait l'argument JS).
window.esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

// jsArg : pour passer une string en argument à un onclick="fn(…)" inline.
// JSON.stringify("foo'bar") → "foo'bar" mais inséré dans onclick="fn(\"foo'bar\")"
// les guillemets cassent l'attribut. On remplace les `"` par l'entité HTML
// `&quot;` qui est valide dans un attribut et redevient `"` à l'évaluation JS.
// À utiliser quand l'argument vient d'une source non-contrôlée (nom de
// groupe Entra, nom de package, hostname renommable, message d'alerte, etc.).
// `esc()` n'est PAS suffisant : il échappe pour innerHTML, pas pour onclick attr.
window.jsArg = (v) => JSON.stringify(String(v ?? '')).replace(/"/g, '&quot;')

window.navigateTo = (hash) => { window.location.hash = hash }

// ─── Modules activés ───
// Mapping route front → module backend. Si le module est désactivé, l'entrée
// de menu disparaît au boot (applyModuleVisibility) et le router redirige
// toute tentative d'accès direct vers le dashboard.
const ROUTE_MODULE = {
  dashboard:  'core',
  alertes:    'monitoring',
  tickets:    'tickets',
  postes:     'inventory',
  conformite: 'monitoring',
  reseau:     'monitoring',
  stock:      'inventory',
  users:      'core',
  groupes:    'groups',
  packages:   'inventory',
  scripts:    'inventory',
  onboarding: 'onboarding',
  rapports:   'monitoring',
  audit:      'core',
  parametres: 'core'
}

window.OPALE = window.OPALE || { modules: {} }
window.OPALE.moduleEnabled = (name) => window.OPALE.modules[name] !== false
window.OPALE.routeEnabled  = (route) => {
  const mod = ROUTE_MODULE[route]
  return mod ? window.OPALE.moduleEnabled(mod) : true
}

// Retire du DOM tout élément [data-module="X"] dont le module est désactivé.
// Appelé au boot après auth, avant le premier render du router. Couvre
// nav-items, nav-sections, boutons et widgets décorés du même attribut.
function applyModuleVisibility() {
  document.querySelectorAll('[data-module]').forEach(el => {
    const mod = el.getAttribute('data-module')
    if (!window.OPALE.moduleEnabled(mod)) el.remove()
  })
}

window.showToast = (msg, type = 'info') => {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = `toast toast-${type}`
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.className = 'toast hidden' }, 3500)
}

window.showModal = (html) => {
  document.getElementById('modal-content').innerHTML = html
  document.getElementById('modal-overlay').classList.remove('hidden')
}
window.closeModal = () => {
  document.getElementById('modal-overlay').classList.add('hidden')
}

// ─── Search ───
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    const input = document.getElementById('omni-input')
    if (input) { input.focus(); input.select() }
    else { navigateTo('/dashboard'); setTimeout(() => document.getElementById('omni-input')?.focus(), 200) }
  }
  if (e.key === 'Escape') {
    closeModal()
    document.getElementById('omni-input')?.blur()
  }
})

// ─── Formatage ───
window.formatWithDate = (iso) => {
  if (!iso) return 'jamais'
  const rel = window.formatRelative(iso)
  const d   = new Date(iso)
  const abs = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) +
              ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  return `${rel} · ${abs}`
}

window.formatRelative = (iso) => {
  if (!iso) return 'jamais'
  const diff = Date.now() - new Date(iso).getTime()
  const min  = Math.floor(diff / 60_000)
  const h    = Math.floor(diff / 3_600_000)
  const d    = Math.floor(diff / 86_400_000)
  if (min < 2)  return 'à l\'instant'
  if (min < 60) return `il y a ${min} min`
  if (h < 24)   return `il y a ${h}h`
  if (d === 1)  return 'hier'
  if (d < 30)   return `il y a ${d} jours`
  const years  = Math.floor(d / 365)
  const months = Math.floor((d % 365) / 30)
  const days   = d % 30
  const parts  = []
  if (years)  parts.push(`${years} an${years > 1 ? 's' : ''}`)
  if (months) parts.push(`${months} mois`)
  if (days)   parts.push(`${days} jour${days > 1 ? 's' : ''}`)
  return `il y a ${parts.join(', ').replace(/,([^,]*)$/, ' et$1')}`
}

// ─── Router ───
const VIEWS = [
  'dashboard','alertes','tickets','postes','conformite','stock',
  'users','groupes','scripts','onboarding','rapports','audit','parametres','packages','reseau'
]

function hideAllViews() {
  VIEWS.forEach(v => {
    const el = document.getElementById(`view-${v}`)
    if (el) { el.style.display = 'none'; el.innerHTML = '' }
  })
  document.getElementById('view-404').style.display = 'none'
}

function setActiveNav(route) {
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('href')
    item.classList.toggle('active', href === `#/${route}`)
  })
}

async function router() {
  const hash  = window.location.hash || '#/dashboard'
  const [pathPart] = hash.slice(1).split('?')
  const parts = pathPart.split('/').filter(Boolean)
  const route = parts[0] || 'dashboard'

  hideAllViews()
  setActiveNav(route)

  // Module désactivé : redirection silencieuse vers le dashboard pour ne pas
  // laisser l'utilisateur sur une vue qui n'existe plus dans la sidebar.
  if (!window.OPALE.routeEnabled(route)) {
    showToast(`Module "${ROUTE_MODULE[route]}" désactivé`, 'info')
    window.location.hash = '#/dashboard'
    return
  }

  if (!VIEWS.includes(route)) {
    document.getElementById('view-404').style.display = 'flex'
    return
  }

  const container = document.getElementById(`view-${route}`)
  container.style.display    = 'flex'
  container.style.flexDirection = 'column'
  container.style.height     = '100%'
  container.style.overflow   = 'hidden'

  if (route === 'alertes') {
    const { renderAlertes } = await import('/views/alertes.js')
    renderAlertes(container)
  } else if (route === 'dashboard') {
    const { renderDashboard } = await import('/views/dashboard.js')
    renderDashboard(container)
  } else if (route === 'postes') {
    const deviceId = parts[1]
    if (deviceId) {
      const { renderPosteDetail } = await import('/views/poste.js')
      renderPosteDetail(container, deviceId)
    } else {
      const { renderPostes } = await import('/views/postes.js')
      renderPostes(container)
    }
  } else if (route === 'tickets') {
    // `#/tickets/<id>` ouvre directement ce ticket (lien partageable).
    const ticketId = parts[1]
    const { renderTickets } = await import('/views/tickets.js')
    renderTickets(container, { ticketId })
  } else if (route === 'conformite') {
    const ruleId = parts[1]
    const { renderConformite } = await import('/views/conformite.js')
    renderConformite(container, { ruleId })
  } else if (route === 'stock') {
    const { renderStock } = await import('/views/stock.js')
    renderStock(container)
  } else if (route === 'scripts') {
    const { renderScripts } = await import('/views/scripts.js')
    renderScripts(container)
  } else if (route === 'onboarding') {
    const { renderOnboarding } = await import('/views/onboarding.js')
    renderOnboarding(container)
  } else if (route === 'audit') {
    const { renderAudit } = await import('/views/audit.js')
    renderAudit(container)
  } else if (route === 'parametres') {
    const { renderParametres } = await import('/views/parametres.js')
    renderParametres(container)
  } else if (route === 'users') {
    const userId = parts[1]
    if (userId) {
      const { renderUserDetail } = await import('/views/user.js')
      renderUserDetail(container, userId)
    } else {
      const { renderUsers } = await import('/views/users.js')
      renderUsers(container)
    }
  } else if (route === 'groupes') {
    const { renderGroupes } = await import('/views/groups.js')
    await renderGroupes(container)
  } else if (route === 'rapports') {
    const { renderRapports } = await import('/views/rapports.js')
    renderRapports(container)
  } else if (route === 'reseau') {
    const { renderReseau } = await import('/views/reseau.js')
    renderReseau(container)
  } else if (route === 'packages') {
    const { renderPackages } = await import('/views/packages.js')
    renderPackages(container)
  } else {
    // Vue non encore implémentée
    container.innerHTML = `
      <div class="empty-state" style="height:100%;justify-content:center">
        <i class="ti ti-tools" style="font-size:32px"></i>
        <p style="font-size:13px;color:var(--text-tertiary)">Vue en cours de développement</p>
      </div>`
  }
}

// ─── Badge alertes ───
async function updateAlertBadge() {
  try {
    const data  = await window.api.getAlerts()
    const badge = document.getElementById('badge-alertes')
    const total = data.counts.critical + data.counts.warn
    if (!badge) return
    if (total > 0) {
      badge.textContent = total
      badge.style.display = ''
      badge.className = `nav-badge${data.counts.critical > 0 ? '' : ' nav-badge-warn'}`
    } else {
      badge.style.display = 'none'
    }
  } catch {}
}

// ─── Badge tickets (ouverts non assignés) ───
async function updateTicketsBadge() {
  try {
    const { open } = await window.api.getTicketsCount()
    const badge = document.getElementById('badge-tickets')
    if (!badge) return
    if (open > 0) {
      badge.textContent = open
      badge.style.display = ''
    } else {
      badge.style.display = 'none'
    }
  } catch {}
}

// ─── Badge propositions (à valider) ───
async function updateProposalsBadge() {
  try {
    const { pending } = await window.api.getProposalsCount()
    const badge = document.getElementById('badge-proposals')
    if (!badge) return
    if (pending > 0) {
      badge.textContent = pending
      badge.style.display = ''
    } else {
      badge.style.display = 'none'
    }
  } catch {}
}

// ─── Init ───
async function init() {
  await initI18n()

  // Redirection vers l'interface mobile sur petits écrans
  if (window.innerWidth < 768 && !window.location.pathname.endsWith('/mobile.html')) {
    window.location.replace('/mobile.html' + window.location.search + window.location.hash)
    return
  }

  await window.auth.init()

  const loading = document.getElementById('view-loading')
  const loginEl = document.getElementById('view-login')
  const appEl   = document.getElementById('app')

  if (!window.auth.ready()) {
    loading.style.display = 'none'
    loginEl.style.display = 'flex'
    document.getElementById('btn-login').addEventListener('click', () => window.auth.login())
    return
  }

  // Sync utilisateur
  try {
    const user = await window.api.syncMe()
    window.appState = { user }

    // Accès réservé aux admins
    if (!user.isAdmin) {
      loading.style.display = 'none'
      loginEl.style.display = 'flex'
      loginEl.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:16px;max-width:360px;text-align:center">
          <img src="/branding/icon.svg" style="height:48px;opacity:0.7" alt="">

          <h2 style="font-size:16px;font-weight:600;margin:0">Accès non autorisé</h2>
          <p style="font-size:13px;color:var(--text-secondary);margin:0">
            Votre compte <strong>${esc(user.email || '')}</strong> n'a pas accès au RMM.<br>
            Contactez l'administrateur pour obtenir les droits.
          </p>
          <button class="btn" onclick="window.auth.logout()">Se déconnecter</button>
        </div>`
      return
    }

    const u = window.auth.getUser()
    const initials = (u.displayName || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    document.getElementById('sidebar-avatar').textContent = initials
    document.getElementById('sidebar-name').textContent   = u.displayName || u.email
    if (user.jobTitle) document.getElementById('sidebar-role').textContent = user.jobTitle
  } catch (err) {
    console.error('sync-me échoué', err)
    window.appState = { user: null }
  }

  loading.style.display  = 'none'
  appEl.style.display    = 'grid'

  // Retire du DOM les entrées de menu des modules désactivés avant tout render
  applyModuleVisibility()

  // Badges sidebar — au démarrage puis toutes les 5 min
  const refreshBadges = () => {
    updateAlertBadge()
    updateTicketsBadge()
    updateProposalsBadge()
  }
  refreshBadges()
  setInterval(refreshBadges, 5 * 60 * 1000)

  window.addEventListener('hashchange', router)
  window.addEventListener('localechange', router)
  await router()
}

window.appState = { user: null }

window.toggleUserMenu = function() {
  const menu = document.getElementById('user-menu')
  menu.classList.toggle('hidden')
}

// Fermer le menu si on clique ailleurs
document.addEventListener('click', e => {
  const btn  = document.getElementById('sidebar-user-btn')
  const menu = document.getElementById('user-menu')
  if (menu && !menu.classList.contains('hidden') && !btn?.contains(e.target) && !menu.contains(e.target)) {
    menu.classList.add('hidden')
  }
})

init()
