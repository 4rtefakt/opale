// Ask Opale — palette de recherche en langage naturel (Cmd+K).
//
// Overlay global : on tape une question en français, le backend la traduit en
// QuerySpec (LLM → validation stricte → SQL paramétré) et renvoie un jeu de
// résultats. On les rend avec les mêmes lignes que l'omni-search (cohérence
// visuelle), chaque ligne ouvrant le détail de l'entité. Lecture seule.
//
// Le composant est auto-suffisant : il crée son overlay à la volée, gère son
// clavier (Entrée = lancer, Échap = fermer) et son état (vide / chargement /
// résultats / erreur). Importé dynamiquement par app.js au 1er Cmd+K.

import { t } from '/i18n.js'

// Fonction (et non constante) : évaluée au rendu pour suivre la locale active.
const SUGGESTIONS = () => [
  t('ask.chip.offline'),
  t('ask.chip.tickets'),
  t('ask.chip.bitlocker'),
  t('ask.chip.department'),
]

// Métadonnées de rendu par ressource : icône + extraction titre/sous-titre +
// destination au clic.
const RENDERERS = {
  devices: {
    icon: 'ti-device-laptop',
    title: r => r.hostname,
    sub:   r => [r.model, r.user_name, r.status].filter(Boolean).join(' · '),
    href:  r => `/postes/${r.id}`,
  },
  tickets: {
    icon: 'ti-ticket',
    title: r => r.title,
    sub:   r => [r.status, r.priority, r.device_hostname].filter(Boolean).join(' · '),
    href:  r => `/tickets/${r.id}`,
  },
  compliance: {
    icon: 'ti-shield-check',
    title: r => r.hostname,
    sub:   r => [r.rule_id, r.status, r.severity].filter(Boolean).join(' · '),
    href:  r => `/postes/${r.device_id}`,
  },
}

let overlay = null
let _capsLoaded = false

function ensureOverlay() {
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.id = 'ask-overlay'
  overlay.className = 'ask-overlay hidden'
  overlay.innerHTML = `
    <div class="ask-panel" role="dialog" aria-label="Ask Opale">
      <div class="ask-inputwrap">
        <i class="ti ti-sparkles ask-inputicon"></i>
        <input id="ask-input" class="ask-input" type="text" autocomplete="off"
          placeholder="${esc(t('ask.placeholder'))}">
        <kbd>${esc(t('ask.kbd.esc'))}</kbd>
      </div>
      <div id="ask-body" class="ask-body"></div>
    </div>`
  document.body.appendChild(overlay)

  // Clic hors panneau = fermeture.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeAskPalette() })

  const input = overlay.querySelector('#ask-input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); runAsk(input.value) }
    if (e.key === 'Escape') { e.preventDefault(); closeAskPalette() }
  })
  return overlay
}

function setBody(html) {
  ensureOverlay().querySelector('#ask-body').innerHTML = html
}

// Décrit le spec interprété de façon lisible (transparence : « voici comment
// j'ai compris la demande »).
function describeSpec(spec) {
  const parts = []
  for (const [k, v] of Object.entries(spec.filters || {})) parts.push(`${k}=${v}`)
  for (const [k, v] of Object.entries(spec.cross || {}))   parts.push(`${k}=${v}`)
  return `${spec.resource}${parts.length ? ' · ' + parts.join(' · ') : ''}`
}

function renderEmpty() {
  const chips = SUGGESTIONS().map(s =>
    `<button class="ask-chip" onclick="askSuggest(${jsArg(s)})">${esc(s)}</button>`
  ).join('')
  setBody(`
    <div class="ask-hint">${esc(t('ask.hint'))}</div>
    <div class="ask-chips">${chips}</div>`)
}

function renderResults(data) {
  const r = RENDERERS[data.resource]
  if (!r) { setBody(`<div class="omni-empty">${esc(t('ask.unknown_resource'))}</div>`); return }

  if (!data.rows.length) {
    setBody(`
      <div class="ask-specline"><i class="ti ti-arrow-guide"></i> ${esc(describeSpec(data.spec))}</div>
      <div class="omni-empty">${esc(t('ask.no_results'))}</div>`)
    return
  }

  const rows = data.rows.map(row => `
    <div class="omni-row" onclick="navigateTo(${jsArg(r.href(row))});closeAskPalette()">
      <i class="ti ${r.icon} omni-ico"></i>
      <div class="omni-row-body">
        <span class="omni-row-title">${esc(r.title(row) || '—')}</span>
        <span class="omni-row-sub">${esc(r.sub(row))}</span>
      </div>
    </div>`).join('')

  const more = data.total > data.count
    ? `<div class="ask-more">${esc(t('ask.more', { shown: data.count, total: data.total }))}</div>`
    : ''

  setBody(`
    <div class="ask-specline">
      <span><i class="ti ti-arrow-guide"></i> ${esc(describeSpec(data.spec))}</span>
      <span class="ask-count">${data.total} ${esc(t('ask.results'))}</span>
    </div>
    <div class="ask-results">${rows}</div>
    ${more}`)
}

function renderError(err) {
  // err = ApiError ; body.details liste les raisons (422).
  const details = err.body?.details
  const detailHtml = Array.isArray(details) && details.length
    ? `<ul class="ask-errlist">${details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
    : ''
  const hint = (err.status === 503)
    ? `<div class="ask-hint">${esc(t('ask.config_hint'))}</div>`
    : ''
  setBody(`
    <div class="omni-empty ask-err">
      <i class="ti ti-alert-triangle"></i> ${esc(err.message || t('ask.error'))}
    </div>${detailHtml}${hint}`)
}

let _running = false
async function runAsk(question) {
  const q = (question || '').trim()
  if (!q || _running) return
  _running = true
  setBody(`<div class="omni-empty"><i class="ti ti-loader-2 ask-spin"></i> ${esc(t('ask.searching'))}</div>`)
  try {
    const data = await window.api.askOpale(q)
    renderResults(data)
  } catch (err) {
    renderError(err)
  } finally {
    _running = false
  }
}

// Suggestion cliquée : remplit l'input et lance.
window.askSuggest = (s) => {
  const input = overlay?.querySelector('#ask-input')
  if (input) { input.value = s; input.focus() }
  runAsk(s)
}

export function openAskPalette() {
  const el = ensureOverlay()
  el.classList.remove('hidden')
  const input = el.querySelector('#ask-input')
  input.value = ''
  input.focus()
  renderEmpty()

  // 1er affichage : si désactivé/non configuré, on le dit d'emblée plutôt que
  // d'attendre une question pour échouer en 503.
  if (!_capsLoaded) {
    _capsLoaded = true
    window.api.getAskCapabilities()
      .then(caps => {
        if (!caps.enabled || !caps.configured) {
          setBody(`<div class="ask-hint ask-err"><i class="ti ti-plug-off"></i> ${esc(t('ask.config_hint'))}</div>`)
        }
      })
      .catch(() => { /* tolérant : la question elle-même remontera l'erreur */ })
  }
}

export function closeAskPalette() {
  overlay?.classList.add('hidden')
}

// Exposés en global pour app.js (Cmd+K / Échap) et les onclick inline.
window.openAskPalette = openAskPalette
window.closeAskPalette = closeAskPalette
