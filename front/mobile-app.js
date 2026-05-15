import { initI18n, t } from '/i18n.js'
import '/auth.js'
import '/api.js'
import * as bio from '/biometric.js'

window.bio = bio

window.t = t

// ── Globals ──────────────────────────────────────────────────────────────────
// Échappe les 5 caractères dangereux pour insertion HTML (body, attributs,
// y compris dans un attribut onclick="fn('${esc(x)}')" — l'échappement de
// l'apostrophe ferme la classe de bugs où une valeur user-controlled
// casserait l'argument JS).
window.esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

// jsArg : pour passer une string en argument à un onclick="fn(…)" inline.
// `esc()` ne suffit pas car il échappe pour innerHTML, pas pour un attribut
// HTML qui contient du JS literal. JSON.stringify produit `"foo"` qui casse
// l'attribut → on remplace `"` par `&quot;` qui décode à l'évaluation.
window.jsArg = (v) => JSON.stringify(String(v ?? '')).replace(/"/g, '&quot;')

window.formatRelative = (iso) => {
  if (!iso) return 'jamais'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  const h   = Math.floor(diff / 3_600_000)
  const d   = Math.floor(diff / 86_400_000)
  if (min < 2)  return 'à l\'instant'
  if (min < 60) return `il y a ${min} min`
  if (h < 24)   return `il y a ${h}h`
  if (d === 1)  return 'hier'
  if (d < 30)   return `il y a ${d} j`
  const years  = Math.floor(d / 365)
  const months = Math.floor((d % 365) / 30)
  const days   = d % 30
  const parts  = []
  if (years)  parts.push(`${years} an${years > 1 ? 's' : ''}`)
  if (months) parts.push(`${months} mois`)
  if (days)   parts.push(`${days} j`)
  return `il y a ${parts.join(', ').replace(/,([^,]*)$/, ' et$1')}`
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
const SCREENS = ['dashboard','postes','poste','ssh','tickets','ticket','menu','settings',
                 'scripts','stock','onboarding','rapports','audit','search','alertes','packages']

window.mNavigateTo = (route) => { window.location.hash = '#/' + route }

function getRoute() {
  const hash  = window.location.hash || '#/dashboard'
  const parts = hash.slice(2).split('/').filter(Boolean)
  return { route: parts[0] || 'dashboard', parts }
}

function setActiveNav(route) {
  document.querySelectorAll('.m-nav-item').forEach(btn => {
    btn.classList.toggle('active',
      btn.dataset.route === route ||
      (route === 'poste'    && btn.dataset.route === 'postes')  ||
      (route === 'ssh'      && btn.dataset.route === 'postes')  ||
      (route === 'ticket'   && btn.dataset.route === 'tickets') ||
      (route === 'settings' && btn.dataset.route === 'menu')    ||
      (route === 'scripts'  && btn.dataset.route === 'menu')    ||
      (route === 'stock'    && btn.dataset.route === 'menu')    ||
      (route === 'onboarding' && btn.dataset.route === 'menu')  ||
      (route === 'rapports' && btn.dataset.route === 'menu')    ||
      (route === 'audit'    && btn.dataset.route === 'menu')    ||
      (route === 'search'   && btn.dataset.route === 'menu')    ||
      (route === 'packages' && btn.dataset.route === 'menu')
    )
  })
  const nav = document.getElementById('m-bottom-nav')
  nav.style.display = route === 'ssh' ? 'none' : 'flex'
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
  if (!container) { mNavigateTo('dashboard'); return }
  container.classList.add('active')

  if (route === 'dashboard') {
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
  }

  // Pull-to-refresh automatique sur tous les scroll containers
  setTimeout(() => {
    container.querySelectorAll('.m-scroll, .m-scroll-list').forEach(el => {
      window.addPullToRefresh(el, () => router())
    })
  }, 300)
}

// ── Alert badge ───────────────────────────────────────────────────────────────
async function updateBadge() {
  try {
    const data  = await window.api.getAlerts()
    const total = (data.counts?.critical || 0) + (data.counts?.warn || 0)
    const badge = document.getElementById('m-badge-crit')
    if (badge) {
      badge.textContent = total
      badge.style.display = total > 0 ? '' : 'none'
    }
  } catch {}
}

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
async function init() {
  await initI18n()
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
        window.showToast('Échec de la vérification', 'error')
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
          Votre compte <strong>${esc(user.email || '')}</strong><br>n'a pas accès au RMM.
        </p>
        <button class="m-login-btn" onclick="window.auth.logout()">
          <i class="ti ti-logout"></i> Déconnexion
        </button>`
      return
    }
  } catch (err) {
    console.error('syncMe échoué', err)
  }

  loading.style.display = 'none'
  appEl.style.display = 'flex'

  bio.touch()

  updateBadge()
  setInterval(updateBadge, 5 * 60 * 1000)

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
          window.showToast('Échec de la vérification', 'error')
        }
      }
    }
  })

  // PWA + push (non-bloquant, après le premier rendu)
  initPWA()
}

init()
