import '/escape.js'  // window.esc / window.jsArg (voir escape.js)
import { initI18n, setLocale, getLocale, t } from '/i18n.js'
window.setLocale = setLocale
window.getLocale = getLocale
import '/auth.js'
import '/api.js'

window.t = t

// ─── Utilitaires globaux ───
// esc() (HTML) et jsArg() (argument de handler inline onclick="…") sont
// définis dans escape.js : esc() ne protège PAS une chaîne JS dans un handler.

window.navigateTo = (hash) => { window.location.hash = hash }

// ─── Modules activés ───
// Mapping route front → module backend. Si le module est désactivé, l'entrée
// de menu disparaît au boot (applyModuleVisibility) et le router redirige
// toute tentative d'accès direct vers le dashboard.
const ROUTE_MODULE = {
  today:      'core',
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
  point:      'monitoring',
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
  const box = document.getElementById('modal-content')
  box.className = ''          // une modale large (modal-wide) ne contamine pas la suivante
  box.innerHTML = html
  document.getElementById('modal-overlay').classList.remove('hidden')
}
window.closeModal = () => {
  document.getElementById('modal-overlay').classList.add('hidden')
}

// ─── Search ───
// Ouvre la palette Ask Opale (recherche en langage naturel), importée à la volée
// au 1er appel. Déclenchée par la barre globale (clic/focus) et par Cmd/Ctrl+K.
// No-op si le module `ask` est désactivé.
function openAsk() {
  if (!window.OPALE?.moduleEnabled('ask')) return
  import('/views/ask.js').then(m => m.openAskPalette())
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase()
  const typing = ['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'n' && document.getElementById('modal-overlay')?.classList.contains('hidden')) {
    if (window.OPALE?.moduleEnabled('tickets')) { e.preventDefault(); window.openQuickTicket() }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openAsk()
  }
  if (e.key === 'Escape') {
    closeModal()
    window.closeAskPalette?.()
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
  'today','dashboard','alertes','tickets','postes','conformite','stock',
  'users','groupes','scripts','onboarding','rapports','point','audit','parametres','packages','reseau'
]

function hideAllViews() {
  VIEWS.forEach(v => {
    const el = document.getElementById(`view-${v}`)
    if (el) { el.style.display = 'none'; el.innerHTML = '' }
  })
  document.getElementById('view-404').style.display = 'none'
}

function setActiveNav(route) {
  document.querySelectorAll('.topnav-link[data-route]').forEach(item => {
    item.classList.toggle('active', item.dataset.route === route)
  })
  // Une vue du menu « Plus » : le bouton Plus est actif.
  const inMore = !!document.querySelector(`#more-menu .more-item[href="#/${route}"]`)
  document.querySelector('#topnav-more > .topnav-link')?.classList.toggle('active', inMore)
  document.getElementById('more-menu')?.classList.add('hidden')
}

window.toggleMoreMenu = (e) => {
  e?.stopPropagation()
  const m = document.getElementById('more-menu')
  const open = m.classList.toggle('hidden')
  document.querySelector('#topnav-more > .topnav-link')?.setAttribute('aria-expanded', String(!open))
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('more-menu')
  if (m && !m.classList.contains('hidden') && !e.target.closest('#topnav-more')) m.classList.add('hidden')
})

async function router() {
  const hash  = window.location.hash || '#/today'
  const [pathPart] = hash.slice(1).split('?')
  const parts = pathPart.split('/').filter(Boolean)
  const route = parts[0] || 'today'

  hideAllViews()
  setActiveNav(route)

  // Module désactivé : redirection silencieuse vers le dashboard pour ne pas
  // laisser l'utilisateur sur une vue qui n'existe plus dans la sidebar.
  if (!window.OPALE.routeEnabled(route)) {
    showToast(`Module "${ROUTE_MODULE[route]}" désactivé`, 'info')
    window.location.hash = '#/today'
    return
  }

  if (!VIEWS.includes(route)) {
    document.getElementById('view-404').style.display = 'flex'
    return
  }

  const container = document.getElementById(`view-${route}`)
  container.style.display    = 'flex'
  container.style.flexDirection = 'column'
  // flex:1 plutôt que height:100% : la vue remplit l'espace restant SOUS la
  // barre Ask Opale (sibling flex-shrink:0) sans déborder. height:auto neutralise
  // le `.view { height:100% }` de la CSS qui réintroduirait l'overflow.
  container.style.flex       = '1'
  container.style.minHeight  = '0'
  container.style.height     = 'auto'
  container.style.overflow   = 'hidden'

  if (route === 'alertes') {
    const { renderAlertes } = await import('/views/alertes.js')
    renderAlertes(container)
  } else if (route === 'today') {
    const { renderToday } = await import('/views/today.js')
    renderToday(container)
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
    // `#/tickets/<id>` : page focus du ticket ; `#/tickets/mail/<id>` :
    // page focus d'un fil de mails pas encore ticket ; sinon la liste.
    if (parts[1] === 'mail' && parts[2]) {
      const { renderMailFocus } = await import('/views/ticket.js')
      renderMailFocus(container, parts[2])
    } else if (parts[1]) {
      const { renderTicketFocus } = await import('/views/ticket.js')
      renderTicketFocus(container, parts[1])
    } else {
      const { renderTickets } = await import('/views/tickets.js')
      renderTickets(container)
    }
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
  } else if (route === 'point') {
    // `#/point/<id>` ouvre un point précis (lien partageable) ; `new` = nouveau.
    const { renderPoint } = await import('/views/point.js')
    renderPoint(container, parts[1])
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

// ─── Badge tickets : ce qui a besoin de moi (à trier + à répondre) ───
// Capture rapide d'un ticket depuis n'importe quelle page (touche n, bouton
// « Nouveau ticket ») : la modale s'ouvre sans quitter l'écran en cours.
window.openQuickTicket = async (opts) => {
  const { openQuickTicket } = await import('/views/tickets.js')
  return openQuickTicket(opts || {})
}
window.setTicketsBadge = (n) => {
  const badge = document.getElementById('badge-tickets')
  if (!badge) return
  badge.textContent = n
  badge.style.display = n > 0 ? '' : 'none'
}
// Fils à trier (comme la liste « À trier », pas les mails un par un) +
// tickets en attente de ma réponse, comptés côté serveur sur tous les tickets.
async function updateTicketsBadge() {
  try {
    const [inbox, tickets] = await Promise.all([
      window.api.getInboxCount().catch(() => ({})),
      window.api.getTicketsCount().catch(() => ({})),
    ])
    window.setTicketsBadge((inbox.threads ?? inbox.pending ?? 0) + (tickets.awaiting_reply || 0))
  } catch {}
}
window.updateTicketsBadge = updateTicketsBadge

// ─── Badge mails à trier ───
// Mis à jour au boot (toutes les 5 min) et par la vue Tickets elle-même.
window.updateInboxSidebarBadge = (pending) => {
  const badge = document.getElementById('badge-inbox')
  if (!badge) return
  badge.textContent = pending
  badge.style.display = pending > 0 ? '' : 'none'
}
async function updateInboxBadge() {
  try {
    const { pending } = await window.api.getInboxCount()
    window.updateInboxSidebarBadge(pending || 0)
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


// ── Démo publique ─────────────────────────────────────────────────────────────
// Bandeau au-dessus de l'application quand le serveur annonce ENV.DEMO :
// données fictives, bouton pour repartir d'un jeu neuf.
function showDemoBanner() {
  if (!window.ENV?.DEMO || document.getElementById('demo-banner')) return
  const el = document.createElement('div')
  el.id = 'demo-banner'
  el.className = 'demo-banner'
  el.innerHTML = `<i class="ti ti-flask"></i><span class="demo-banner-text">${esc(t('demo.banner'))}</span>
    <button class="demo-banner-btn" onclick="demoReset()"><i class="ti ti-refresh"></i> ${esc(t('demo.reset'))}</button>
    <a class="demo-banner-btn" href="https://github.com/4rtefakt/opale#quick-start" target="_blank" rel="noopener"><i class="ti ti-download"></i> ${esc(t('demo.install'))}</a>`
  document.body.prepend(el)
  document.documentElement.classList.add('has-demo-banner')
}
window.demoReset = async () => {
  try { await window.api._fetch('/demo/reset', { method: 'POST', body: {} }) } catch {}
  try { sessionStorage.clear() } catch {}
  window.location.reload()
}

// ─── Init ───
async function init() {
  await initI18n()
  showDemoBanner()

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

    // Thème : la préférence serveur (multi-appareils) prime sur le cache local.
    window.OpaleTheme?.syncFromPrefs(window.api)

    const u = window.auth.getUser()
    const initials = (u.displayName || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    document.getElementById('sidebar-avatar').textContent = initials
    document.getElementById('sidebar-name').textContent   = u.displayName || u.email
    if (user.jobTitle) document.getElementById('sidebar-role').textContent = user.jobTitle
    // Libellés de navigation traduits (le HTML porte le français par défaut).
    document.querySelectorAll('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (t(k) !== k) el.textContent = t(k) })
  } catch (err) {
    console.error('sync-me échoué', err)
    window.appState = { user: null }
  }

  loading.style.display  = 'none'
  appEl.style.display    = 'flex'

  // Retire du DOM les entrées de menu des modules désactivés avant tout render
  applyModuleVisibility()

  // Barre Ask Opale globale : déclencheur visible de la palette (le ⌘K seul
  // n'était pas découvrable). Le bandeau est déjà retiré par applyModuleVisibility
  // si le module `ask` est off — on ne câble donc que s'il est présent.
  const askTrigger = document.getElementById('ask-bar-trigger')
  if (askTrigger) {
    askTrigger.addEventListener('click', openAsk)
    askTrigger.addEventListener('focus', openAsk)
  }
  const setAskLabel = () => {
    const el = document.getElementById('ask-bar-text')
    if (el) el.textContent = t('ask.cta')
  }
  setAskLabel()
  window.addEventListener('localechange', setAskLabel)

  // Badges sidebar — au démarrage puis toutes les 5 min
  const refreshBadges = () => {
    updateAlertBadge()
    updateTicketsBadge()
    updateProposalsBadge()
    updateInboxBadge()
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
  paintModeSeg()
}

// Bascule clair / sombre / système depuis le menu utilisateur (persistée
// localement et côté serveur via theme.js).
function paintModeSeg() {
  const mode = window.OpaleTheme?.get().mode
  document.querySelectorAll('#user-menu-mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode))
}
window.setThemeMode = (mode) => {
  window.OpaleTheme?.save(window.api, { mode })
  paintModeSeg()
}
window.addEventListener('themechange', paintModeSeg)

// Fermer le menu si on clique ailleurs
document.addEventListener('click', e => {
  const btn  = document.getElementById('sidebar-user-btn')
  const menu = document.getElementById('user-menu')
  if (menu && !menu.classList.contains('hidden') && !btn?.contains(e.target) && !menu.contains(e.target)) {
    menu.classList.add('hidden')
  }
})

init()
