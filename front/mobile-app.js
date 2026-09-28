import '/escape.js'  // window.esc / window.jsArg (voir escape.js)
import { initI18n, t } from '/i18n.js'
import '/auth.js'
import '/api.js'
import * as bio from '/biometric.js'
import { MOBILE_NAV_ITEMS, MOBILE_NAV_DEFAULT, sanitizeMobileNav } from '/views/mobile/nav-config.js'

window.bio = bio

window.t = t

// ── Globals ──────────────────────────────────────────────────────────────────
// esc() (HTML) et jsArg() (argument de handler inline onclick="…") sont
// définis dans escape.js : esc() ne protège PAS une chaîne JS dans un handler.

window.formatRelative = (iso) => {
  if (!iso) return t('mobile.time.never')
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  const h   = Math.floor(diff / 3_600_000)
  const d   = Math.floor(diff / 86_400_000)
  if (min < 2)  return t('mobile.time.now')
  if (min < 60) return t('mobile.time.minutes', { n: min })
  if (h < 24)   return t('mobile.time.hours', { n: h })
  if (d === 1)  return t('mobile.time.yesterday')
  if (d < 30)   return t('mobile.time.days', { n: d })
  const years  = Math.floor(d / 365)
  const months = Math.floor((d % 365) / 30)
  const days   = d % 30
  const parts  = []
  if (years)  parts.push(t(years > 1 ? 'mobile.time.years' : 'mobile.time.year', { n: years }))
  if (months) parts.push(t('mobile.time.months', { n: months }))
  if (days)   parts.push(t('mobile.time.days_short', { n: days }))
  return t('mobile.time.ago', { parts: parts.join(', ').replace(/,([^,]*)$/, t('mobile.time.and') + '$1') })
}

window.appState = { user: null }

// ── Toast ─────────────────────────────────────────────────────────────────────
window.showToast = (msg, type = 'info') => {
  const el = document.getElementById('m-toast')
  el.textContent = msg
  el.className = `show ${type}`
  clearTimeout(el._t)
  el._t = setTimeout(() => el.className = '', 3000)
}

// ── Busy state (anti double-submit) ────────────────────────────────────────────
// Désactive le(s) bouton(s) déclencheur(s) et affiche un spinner pendant l'appel
// réseau, puis restaure l'état initial à la fin (succès comme échec). `el` accepte
// un élément, un tableau d'éléments, ou null (no-op). Retourne le résultat de fn.
window.withBusy = async (el, fn) => {
  const btns  = (Array.isArray(el) ? el : [el]).filter(b => b && b.nodeType === 1 && !b.dataset.busy)
  const saved = btns.map(b => ({ b, html: b.innerHTML }))
  btns.forEach(b => {
    b.dataset.busy   = '1'
    b.disabled       = true
    b.style.minWidth = b.offsetWidth + 'px'   // évite le saut de layout quand on remplace le contenu
    b.innerHTML      = '<span class="m-spinner-inline"></span>'
  })
  try {
    return await fn()
  } finally {
    saved.forEach(({ b, html }) => {
      delete b.dataset.busy
      b.disabled       = false
      b.style.minWidth = ''
      b.innerHTML      = html
    })
  }
}

// ── État d'erreur réutilisable (avec bouton Réessayer) ──────────────────────────
// Retourne le HTML d'un état d'erreur centré + bouton qui relance `retryFn`.
// La closure est stockée dans un registre, référencée par l'onclick inline.
window._mRetries = {}
window.mErrorBox = (message, retryFn) => {
  const key = 'r' + (window._mRetrySeq = (window._mRetrySeq || 0) + 1)
  window._mRetries[key] = retryFn
  return `<div class="m-error-state">
    <i class="ti ti-alert-circle"></i>
    <div class="m-error-msg">${esc(message || t('mobile.common.error'))}</div>
    <button class="m-error-retry" onclick="window._mRetries['${key}']?.()">
      <i class="ti ti-refresh"></i> ${t('mobile.common.retry')}
    </button>
  </div>`
}

// ── Sheet ─────────────────────────────────────────────────────────────────────
window.mShowSheet = (html) => {
  document.getElementById('m-sheet-inner').innerHTML = html
  document.getElementById('m-sheet-overlay').classList.add('open')
}
window.mCloseSheet = () => {
  document.getElementById('m-sheet-overlay').classList.remove('open')
}

// ── Pull-to-refresh ────────────────────────────────────────────────────────────
window.addPullToRefresh = (scrollEl, onRefresh) => {
  if (!scrollEl || scrollEl._ptr) return
  scrollEl._ptr = true

  const indicator = document.createElement('div')
  indicator.className = 'm-ptr-indicator'
  indicator.innerHTML = '<div class="m-spinner" style="width:20px;height:20px;border-width:2px"></div>'
  scrollEl.parentElement?.insertBefore(indicator, scrollEl)

  let startY = 0, pulling = false, triggered = false

  scrollEl.addEventListener('touchstart', e => {
    if (scrollEl.scrollTop > 0) return
    startY   = e.touches[0].clientY
    pulling  = true
    triggered = false
  }, { passive: true })

  scrollEl.addEventListener('touchmove', e => {
    if (!pulling || scrollEl.scrollTop > 0) return
    const dy = e.touches[0].clientY - startY
    if (dy < 10) return
    const progress = Math.min(dy / 70, 1)
    indicator.style.height  = `${progress * 44}px`
    indicator.style.opacity = String(progress)
  }, { passive: true })

  scrollEl.addEventListener('touchend', async e => {
    if (!pulling) return
    pulling = false
    const dy = e.changedTouches[0].clientY - startY
    indicator.style.height  = '0'
    indicator.style.opacity = '0'
    if (dy > 70 && !triggered) {
      triggered = true
      indicator.style.height  = '44px'
      indicator.style.opacity = '1'
      await onRefresh()
      indicator.style.height  = '0'
      indicator.style.opacity = '0'
    }
  }, { passive: true })
}

// ── Router ────────────────────────────────────────────────────────────────────
const SCREENS = ['today','dashboard','postes','poste','ssh','tickets','ticket','menu','settings',
                 'scripts','stock','onboarding','rapports','audit','search','alertes','packages',
                 'ask','conformite']

window.mNavigateTo = (route) => { window.location.hash = '#/' + route }

// Liens de la version desktop (`#/tickets/<id>`, `#/postes/<id>`, `#/users/<id>`)
// partagés par mail, notification ou redirection depuis index.html : ils
// doivent ouvrir la fiche, pas la liste. Le `?…` éventuel est ignoré.
const DETAIL_ALIASES = { tickets: 'ticket', postes: 'poste' }
function getRoute() {
  const hash  = window.location.hash || '#/today'
  const parts = hash.slice(2).split('?')[0].split('/').filter(Boolean)
  let route = parts[0] || 'today'
  if (DETAIL_ALIASES[route] && parts[1]) { route = DETAIL_ALIASES[route] }
  return { route, parts }
}

// Les 4 raccourcis courants de la barre du bas (le 5e onglet « Plus » est fixe).
// Personnalisable par user (pref serveur mobile_nav) ; défaut sinon.
let _navRoutes = [...MOBILE_NAV_DEFAULT]

// (Re)génère les 4 onglets raccourcis + l'onglet « Plus » fixe depuis `routes`.
// Recrée les badges (alertes critiques, tickets à traiter) si l'onglet est un
// raccourci (updateBadges cible #m-badge-* ; absent sinon → no-op silencieux).
function renderBottomNav(routes) {
  _navRoutes = routes
  const nav = document.getElementById('m-bottom-nav')
  if (!nav) return
  const shortcuts = routes.map(r => {
    const meta = MOBILE_NAV_ITEMS[r]
    if (!meta) return ''
    const badge = r === 'alertes' ? '<span class="m-nav-badge crit" id="m-badge-crit" style="display:none"></span>'
                : r === 'tickets' ? '<span class="m-nav-badge" id="m-badge-tickets" style="display:none"></span>'
                : ''
    return `<button class="m-nav-item" data-route="${r}" onclick="mNavigateTo('${r}')">
      <i class="ti ${meta.icon}"></i>${esc(t(meta.labelKey))}${badge}
    </button>`
  }).join('')
  nav.innerHTML = shortcuts + `
    <button class="m-nav-item" data-route="menu" onclick="mNavigateTo('menu')">
      <i class="ti ti-dots"></i>${esc(t('mobile.nav.more'))}
    </button>`
  setActiveNav(getRoute().route)
  paintBadges()
}
// Exposé pour que l'écran de réglage rafraîchisse la barre après sauvegarde.
window.mRenderBottomNav = renderBottomNav
window.mNavRoutes = () => [..._navRoutes]

// Vues de détail → onglet liste parent. Toute route absente des raccourcis
// (et ≠ menu) vit sous l'onglet « Plus ».
const NAV_PARENT = { poste: 'postes', ssh: 'postes', ticket: 'tickets' }
function setActiveNav(route) {
  let target = NAV_PARENT[route] || route
  if (target !== 'menu' && !_navRoutes.includes(target)) target = 'menu'
  document.querySelectorAll('.m-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.route === target)
  })
  const nav = document.getElementById('m-bottom-nav')
  if (nav) nav.style.display = route === 'ssh' ? 'none' : 'flex'
}

async function router() {
  const { route, parts } = getRoute()
  const id = parts[1]

  SCREENS.forEach(s => {
    const el = document.getElementById(`m-screen-${s}`)
    if (el) el.classList.remove('active')
  })
  mCloseSheet()
  setActiveNav(route)

  const container = document.getElementById(`m-screen-${route}`)
  if (!container) {
    // Route desktop sans équivalent mobile (users, groupes, réseau…) : on
    // retombe sur Aujourd'hui plutôt qu'un écran vide.
    mNavigateTo('today'); return
  }
  container.classList.add('active')

  if (route === 'today') {
    const { renderToday } = await import('/views/mobile/today.js')
    await renderToday(container)
  } else if (route === 'dashboard') {
    const { renderDashboard } = await import('/views/mobile/dashboard.js')
    await renderDashboard(container)
  } else if (route === 'postes') {
    const { renderPostes } = await import('/views/mobile/postes.js')
    await renderPostes(container)
  } else if (route === 'poste') {
    const { renderPoste } = await import('/views/mobile/poste.js')
    renderPoste(container, id)
  } else if (route === 'ssh') {
    const { renderSSH } = await import('/views/mobile/ssh.js')
    renderSSH(container, id)
  } else if (route === 'tickets') {
    const { renderTickets } = await import('/views/mobile/tickets.js')
    await renderTickets(container)
  } else if (route === 'ticket') {
    const { renderTicket } = await import('/views/mobile/ticket.js')
    renderTicket(container, id)
  } else if (route === 'menu') {
    const { renderMenu } = await import('/views/mobile/menu.js')
    renderMenu(container)
  } else if (route === 'settings') {
    const { renderSettings } = await import('/views/mobile/settings.js')
    renderSettings(container)
  } else if (route === 'scripts') {
    const { renderScripts } = await import('/views/mobile/scripts.js')
    renderScripts(container)
  } else if (route === 'stock') {
    const { renderStock } = await import('/views/mobile/stock.js')
    renderStock(container)
  } else if (route === 'onboarding') {
    const { renderOnboarding } = await import('/views/mobile/onboarding.js')
    renderOnboarding(container)
  } else if (route === 'rapports') {
    const { renderRapports } = await import('/views/mobile/rapports.js')
    renderRapports(container)
  } else if (route === 'audit') {
    const { renderAudit } = await import('/views/mobile/audit.js')
    renderAudit(container)
  } else if (route === 'search') {
    const { renderSearch } = await import('/views/mobile/search.js')
    renderSearch(container)
  } else if (route === 'alertes') {
    const { renderAlertes } = await import('/views/mobile/alertes.js')
    await renderAlertes(container)
  } else if (route === 'packages') {
    const { renderPackages } = await import('/views/mobile/packages.js')
    await renderPackages(container)
  } else if (route === 'ask') {
    const { renderAsk } = await import('/views/mobile/ask.js')
    renderAsk(container)
  } else if (route === 'conformite') {
    const { renderConformite } = await import('/views/mobile/conformite.js')
    await renderConformite(container, id)
  }

  // Pull-to-refresh automatique sur tous les scroll containers
  setTimeout(() => {
    container.querySelectorAll('.m-scroll, .m-scroll-list').forEach(el => {
      window.addPullToRefresh(el, () => router())
    })
  }, 300)
}

// ── Badges de la barre du bas ────────────────────────────────────────────────
// Alertes : critiques + avertissements. Tickets : fils de mails à trier +
// tickets en attente de réponse (compteurs serveur, comme le desktop).
let _badges = { crit: 0, tickets: 0 }
function paintBadges() {
  const crit = document.getElementById('m-badge-crit')
  if (crit) { crit.textContent = _badges.crit; crit.style.display = _badges.crit > 0 ? '' : 'none' }
  const tk = document.getElementById('m-badge-tickets')
  if (tk) { tk.textContent = _badges.tickets; tk.style.display = _badges.tickets > 0 ? '' : 'none' }
}
window.mSetTicketsBadge = (n) => { _badges.tickets = n || 0; paintBadges() }
async function updateBadges() {
  const [alerts, inbox, tickets] = await Promise.all([
    window.api.getAlerts().catch(() => null),
    window.api.getInboxCount().catch(() => ({})),
    window.api.getTicketsCount().catch(() => ({})),
  ])
  if (alerts) _badges.crit = (alerts.counts?.critical || 0) + (alerts.counts?.warn || 0)
  _badges.tickets = (inbox.threads ?? inbox.pending ?? 0) + (tickets.awaiting_reply || 0)
  paintBadges()
}
window.mUpdateTicketsBadge = updateBadges

// ── Service Worker + Push ─────────────────────────────────────────────────────
async function initPWA() {
  if (!('serviceWorker' in navigator)) return

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })

    // Push notifications
    if (!('PushManager' in window)) return
    const { data } = await window.api._fetch('/push/vapid-public').catch(() => ({ data: null }))
    if (!data?.publicKey) return

    const existing = await reg.pushManager.getSubscription()
    if (existing) return // déjà abonné

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:     true,
      applicationServerKey: urlB64ToUint8Array(data.publicKey)
    })
    await window.api._fetch('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } })
  } catch (err) {
    console.warn('PWA/push init:', err.message)
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw     = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Textes statiques de mobile.html (connexion, verrou biométrique) : traduits
// une fois les locales chargées.
function translateStatic() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')) })
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

async function init() {
  await initI18n()
  translateStatic()
  showDemoBanner()
  await window.auth.init()

  const loading = document.getElementById('m-loading')
  const loginEl = document.getElementById('m-login')

  if (!window.auth.ready()) {
    loading.style.display = 'none'
    loginEl.classList.add('active')
    document.getElementById('m-btn-login').addEventListener('click', () => window.auth.login())
    return
  }

  // Verrou biométrique si activé et délai écoulé
  if (bio.isEnabled() && bio.shouldLock()) {
    loading.style.display = 'none'
    const lockEl = document.getElementById('m-bio-lock')
    lockEl.style.display = 'flex'

    const tryUnlock = async () => {
      const ok = await bio.verify()
      if (ok) {
        lockEl.style.display = 'none'
        await launchApp()
      } else {
        window.showToast(t('mobile.login.bio_failed'), 'error')
      }
    }

    document.getElementById('m-bio-unlock-btn').onclick = tryUnlock
    tryUnlock() // déclencher automatiquement au chargement
    return
  }

  await launchApp()
}

async function launchApp() {
  const loading = document.getElementById('m-loading')
  const loginEl = document.getElementById('m-login')
  const appEl   = document.getElementById('m-app')

  try {
    const user = await window.api.syncMe()
    window.appState = { user }

    if (!user.isAdmin) {
      loading.style.display = 'none'
      loginEl.classList.add('active')
      const productName = window.ENV?.BRANDING?.product_name || 'Opale'
      loginEl.innerHTML = `
        <div class="m-login-logo">${esc(productName)}</div>
        <p style="font-size:13px;color:var(--text-secondary);text-align:center;line-height:1.6">
          ${t('mobile.login.no_access', { email: `<strong>${esc(user.email || '')}</strong>` })}
        </p>
        <button class="m-login-btn" onclick="window.auth.logout()">
          <i class="ti ti-logout"></i> ${esc(t('mobile.menu.logout'))}
        </button>`
      return
    }
  } catch (err) {
    console.error('syncMe échoué', err)
  }

  loading.style.display = 'none'
  appEl.style.display = 'flex'

  bio.touch()
  window.OpaleTheme?.syncFromPrefs(window.api)

  // Barre du bas personnalisée (pref serveur par user). Non bloquant : en cas
  // d'échec on garde les 4 raccourcis par défaut. Rendu avant updateBadges pour
  // que les badges existent si leurs onglets sont des raccourcis.
  try {
    const prefs = await window.api.getMyPrefs()
    renderBottomNav(sanitizeMobileNav(prefs?.mobile_nav))
  } catch {
    renderBottomNav([...MOBILE_NAV_DEFAULT])
  }

  updateBadges()
  setInterval(updateBadges, 5 * 60 * 1000)

  window.addEventListener('hashchange', router)
  await router()

  // Verrou automatique au retour en premier plan après inactivité
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      bio.touch()
      return
    }
    if (bio.isEnabled() && bio.shouldLock()) {
      const lockEl = document.getElementById('m-bio-lock')
      if (!lockEl) return
      lockEl.style.display = 'flex'
      document.getElementById('m-bio-unlock-btn').onclick = async () => {
        const ok = await bio.verify()
        if (ok) {
          lockEl.style.display = 'none'
          bio.touch()
        } else {
          window.showToast(t('mobile.login.bio_failed'), 'error')
        }
      }
    }
  })

  // PWA + push (non-bloquant, après le premier rendu)
  initPWA()
}

init()
