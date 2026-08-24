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

// Traduit les éléments statiques du shell (sidebar) marqués data-i18n.
// Appelé au boot et à chaque localechange.
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'))
  })
}
window.addEventListener('localechange', applyStaticI18n)

window.showToast = (msg, type = 'info') => {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = `toast toast-${type}`
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.className = 'toast hidden' }, 3500)
}

// errorBox — état d'erreur réutilisable avec bouton réessayer (pendant du
// mErrorBox mobile). retryFnName = nom d'une fonction exposée sur window ;
// à injecter dans le conteneur de la vue au lieu de laisser le spinner
// tourner indéfiniment.
window.errorBox = (msg, retryFnName) => `
  <div class="empty-state" style="padding:2rem;text-align:center">
    <i class="ti ti-alert-triangle" style="font-size:28px;color:var(--red)"></i>
    <p style="margin:10px 0;color:var(--text-secondary)">${esc(msg)}</p>
    ${retryFnName ? `<button class="btn" onclick="${retryFnName}()"><i class="ti ti-refresh"></i> ${esc(t('btn.retry'))}</button>` : ''}
  </div>`

let _modalPrevFocus = null

window.showModal = (html) => {
  const overlay = document.getElementById('modal-overlay')
  const content = document.getElementById('modal-content')
  content.innerHTML = html
  // Sémantique dialogue + gestion du focus : sans ça, les lecteurs d'écran
  // ne signalent pas le modal et le focus clavier reste derrière l'overlay.
  content.setAttribute('role', 'dialog')
  content.setAttribute('aria-modal', 'true')
  content.setAttribute('tabindex', '-1')
  overlay.classList.remove('hidden')
  _modalPrevFocus = document.activeElement
  const first = content.querySelector('input, select, textarea, button')
  ;(first || content).focus()
}
window.closeModal = () => {
  const overlay = document.getElementById('modal-overlay')
  if (overlay.classList.contains('hidden')) return
  overlay.classList.add('hidden')
  if (_modalPrevFocus?.focus) _modalPrevFocus.focus()
  _modalPrevFocus = null
}

// Fermeture "polie" : si un champ contient du texte, on confirme avant de
// jeter la saisie (Escape fermait sans prévenir, backdrop ne fermait pas).
function modalIsDirty() {
  const content = document.getElementById('modal-content')
  if (!content) return false
  return [...content.querySelectorAll('input[type="text"], input:not([type]), textarea')]
    .some(el => el.value.trim() !== '')
}
window.requestCloseModal = () => {
  if (modalIsDirty() && !confirm(t('modal.discard_confirm'))) return
  closeModal()
}

// Backdrop : clic hors du contenu = demande de fermeture (convention UI).
document.addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) window.requestCloseModal()
})

// Piège à focus : Tab reste dans le modal tant qu'il est ouvert.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  const overlay = document.getElementById('modal-overlay')
  if (!overlay || overlay.classList.contains('hidden')) return
  const foci = overlay.querySelectorAll(
    'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')
  if (!foci.length) return
  const first = foci[0], last = foci[foci.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})

// withBusy — anti double-submit (porté du shell mobile) : désactive le
// bouton et affiche un spinner le temps de l'action asynchrone.
window.withBusy = async (btn, fn) => {
  if (!btn) return fn()
  if (btn.disabled) return
  const prev = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:-2px"></span>'
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.innerHTML = prev
  }
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
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openAsk()
  }
  if (e.key === 'Escape') {
    window.requestCloseModal()
    window.closeAskPalette?.()
  }
})

// ─── Formatage ───
// Basé sur Intl + la locale active (getLocale) : les dates relatives et
// absolues suivent la langue de l'UI au lieu d'être codées en dur en FR.
const _localeTag = () => (getLocale?.() === 'en' ? 'en-GB' : 'fr-FR')

window.formatWithDate = (iso) => {
  if (!iso) return t('common.never')
  const rel = window.formatRelative(iso)
  const d   = new Date(iso)
  const tag = _localeTag()
  const abs = d.toLocaleDateString(tag, { day: 'numeric', month: 'short', year: 'numeric' }) +
              ' ' + d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' })
  return `${rel} · ${abs}`
}

window.formatRelative = (iso) => {
  if (!iso) return t('common.never')
  const diff = Date.now() - new Date(iso).getTime()
  const min  = Math.floor(diff / 60_000)
  const h    = Math.floor(diff / 3_600_000)
  const d    = Math.floor(diff / 86_400_000)
  if (min < 2) return t('common.just_now')
  const rtf = new Intl.RelativeTimeFormat(_localeTag(), { numeric: 'auto' })
  if (min < 60) return rtf.format(-min, 'minute')
  if (h < 24)   return rtf.format(-h, 'hour')
  if (d < 30)   return rtf.format(-d, 'day')
  if (d < 365)  return rtf.format(-Math.floor(d / 30), 'month')
  return rtf.format(-Math.floor(d / 365), 'year')
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
  applyStaticI18n()

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
