const SUPPORTED = ['fr', 'en']
const DEFAULT   = 'fr'

let _strings = {}
let _locale  = DEFAULT

export function getLocale() { return _locale }

export async function initI18n() {
  const stored = localStorage.getItem('rmm-locale')
  const browser = (navigator.language || DEFAULT).slice(0, 2).toLowerCase()
  _locale = SUPPORTED.includes(stored) ? stored
          : SUPPORTED.includes(browser) ? browser
          : DEFAULT

  await _loadLocale(_locale)
}

export async function setLocale(lang) {
  if (!SUPPORTED.includes(lang) || lang === _locale) return
  _locale = lang
  localStorage.setItem('rmm-locale', lang)
  await _loadLocale(lang)
  // Re-render la vue courante
  window.dispatchEvent(new CustomEvent('localechange'))
}

async function _loadLocale(locale) {
  const [fallback, target] = await Promise.all([
    import(`/locales/fr.js`),
    locale !== DEFAULT ? import(`/locales/${locale}.js`) : Promise.resolve(null),
  ])
  _strings = { ...fallback.default, ...(target?.default ?? {}) }
  document.documentElement.lang = locale
}

export function t(key, vars) {
  let s = _strings[key] ?? key
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`)
  return s
}
