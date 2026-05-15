const CACHE_NAME = 'opale-v4'

// Charge window/self.ENV pour récupérer le branding (fallback titre push).
// importScripts est synchrone et ne bloque pas l'install si l'endpoint échoue.
try { importScripts('/env.js') } catch { /* env indispo : on tombera sur les fallbacks */ }
const PRECACHE = [
  '/mobile.html',
  '/mobile-app.js',
  '/styles/mobile.css',
  '/auth.js',
  '/api.js',
  '/i18n.js',
  '/env.js',
]

// ── Installation : précache des assets statiques ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

// ── Activation : supprime les vieux caches ────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// ── Fetch : cache-first pour les assets statiques, network-first pour l'API ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // Ne pas intercepter les appels API ni les WebSockets
  if (url.pathname.startsWith('/api') || e.request.url.startsWith('ws')) return

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
        }
        return res
      })
      return cached || network
    })
  )
})

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return
  let payload
  try { payload = e.data.json() } catch { return }

  const { title, body, deviceId, url } = payload
  e.waitUntil(
    self.registration.showNotification(title || (self.ENV?.BRANDING?.product_name) || 'RMM', {
      body:    body || '',
      icon:    '/branding/icon.svg',
      badge:   '/branding/icon.svg',
      tag:     deviceId || 'rmm-alert',
      renotify: true,
      data:    { url: url || '/mobile.html' }
    })
  )
})

// ── Clic sur notification → ouvrir l'app ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = e.notification.data?.url || '/mobile.html'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('/mobile.html'))
      if (existing) { existing.focus(); existing.navigate(target) }
      else self.clients.openWindow(target)
    })
  )
})
