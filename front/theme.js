// Thèmes de l'interface (desktop + mobile).
//
// Script classique (pas de module) chargé dans <head> AVANT le premier rendu :
// il applique immédiatement le thème mémorisé (localStorage) pour éviter un
// flash, puis app.js / mobile-app.js le resynchronisent avec la préférence
// serveur (ui_theme / ui_mode dans /api/me/prefs) une fois l'utilisateur
// authentifié.
//
// Chaque thème définit une palette claire et une palette sombre ; le mode
// (`system` | `light` | `dark`) choisit laquelle. Les couleurs sont posées en
// variables CSS sur <html> (style inline) : elles priment sur les valeurs par
// défaut de main.css / mobile.css, qui restent le filet de sécurité sans JS.
(function () {
  'use strict'

  const STORAGE_THEME = 'opale.theme'
  const STORAGE_MODE  = 'opale.mode'
  const IS_MOBILE = /mobile\.html$/.test(location.pathname)

  // Couleurs sémantiques partagées (identiques pour tous les thèmes).
  const SEM_LIGHT = {
    'green': '#1D9E75', 'green-bg': '#E1F5EE', 'green-text': '#0F6E56',
    'amber': '#BA7517', 'amber-bg': '#FAEEDA', 'amber-text': '#854F0B',
    'red':   '#E24B4A', 'red-bg':   '#FCEBEB', 'red-text':   '#A32D2D',
    'blue':  '#185FA5', 'blue-bg':  '#E6F1FB', 'blue-text':  '#0C447C',
    'purple':'#534AB7', 'purple-bg':'#EEEDFE', 'purple-text':'#3C3489',
    'orange':'#C2410C', 'gray': '#888780',
    'shadow-sm': '0 1px 2px rgba(0,0,0,0.06)', 'shadow-md': '0 6px 20px rgba(0,0,0,0.10)',
    'bg-hover': 'rgba(0,0,0,0.04)',
    'primary-fg': '#FFFFFF',
  }
  const SEM_DARK = {
    'green': '#2FB58A', 'green-bg': '#0B3A30', 'green-text': '#9FE1CB',
    'amber': '#D9962B', 'amber-bg': '#412402', 'amber-text': '#FAC775',
    'red':   '#EF6A69', 'red-bg':   '#501313', 'red-text':   '#F7C1C1',
    'blue':  '#5B9BE0', 'blue-bg':  '#0E3358', 'blue-text':  '#B5D4F4',
    'purple':'#8C84E8', 'purple-bg':'#26215C', 'purple-text':'#CECBF6',
    'orange':'#F97316', 'gray': '#8B8A84',
    'shadow-sm': '0 1px 2px rgba(0,0,0,0.45)', 'shadow-md': '0 6px 20px rgba(0,0,0,0.5)',
    'bg-hover': 'rgba(255,255,255,0.06)',
    'primary-fg': '#FFFFFF',
  }

  // Palette neutre + accent d'un thème. `primary` = couleur d'action
  // (boutons, sélection, indicateur de navigation).
  const THEMES = {
    // Le vrai Opale : base nuit profonde, éclats d'opale (émeraude, cyan,
    // violet, rose, or) en aurore lente derrière l'interface, verre dépoli
    // sur la barre. Même palette que la page de présentation (landing/).
    opale: {
      label: 'Opale', desc: 'Défaut — nuit et éclats d\'opale, aurore animée',
      effects: 'opal',
      preview: 'conic-gradient(from 210deg, #0c4c3c, #1D9E75, #22d3ee, #7dd3fc, #a78bfa, #f0abfc, #fbbf24, #1D9E75, #0c4c3c)',
      light: {
        'bg-primary': '#FBFCFD', 'bg-secondary': '#F1F5F6', 'bg-tertiary': '#E4ECEE',
        'sidebar-bg': 'rgba(255,255,255,0.62)', 'bg-base': '#EEF4F5',
        'text-primary': '#0F1A22', 'text-secondary': '#4A5A63', 'text-tertiary': '#7E8C93',
        'border': 'rgba(15,26,34,0.10)', 'border-md': 'rgba(15,26,34,0.20)',
        'primary': '#128A66', 'primary-hover': '#0F7556', 'primary-bg': '#D9F2E8', 'primary-text': '#0A5C44',
        'glow': 'rgba(29,158,117,0.22)',
      },
      dark: {
        'bg-primary': '#11141C', 'bg-secondary': '#161A25', 'bg-tertiary': '#1D2230',
        'sidebar-bg': 'rgba(10,12,16,0.58)', 'bg-base': '#0A0C10',
        'text-primary': '#F1EFE9', 'text-secondary': '#B4B2A9', 'text-tertiary': '#7F7D75',
        'border': 'rgba(255,255,255,0.08)', 'border-md': 'rgba(255,255,255,0.16)',
        'primary': '#1D9E75', 'primary-hover': '#25B888', 'primary-bg': 'rgba(29,158,117,0.18)', 'primary-text': '#9FE1CB',
        'glow': 'rgba(29,158,117,0.35)',
      },
    },
    craie: {
      label: 'Craie', desc: 'Calme — neutres chauds, accent émeraude, sans effets',
      light: {
        'bg-primary': '#FFFFFF', 'bg-secondary': '#F6F6F3', 'bg-tertiary': '#ECECE7',
        'sidebar-bg': '#F3F3EF',
        'text-primary': '#1B1B19', 'text-secondary': '#5C5B56', 'text-tertiary': '#8A897F',
        'border': 'rgba(0,0,0,0.10)', 'border-md': 'rgba(0,0,0,0.18)',
        'primary': '#0F9F73', 'primary-hover': '#0C8560', 'primary-bg': '#DDF4EA', 'primary-text': '#0A6B4E',
      },
      dark: {
        'bg-primary': '#1B1B19', 'bg-secondary': '#242422', 'bg-tertiary': '#2E2E2B',
        'sidebar-bg': '#181816',
        'text-primary': '#F0EFE9', 'text-secondary': '#B4B2A9', 'text-tertiary': '#87867E',
        'border': 'rgba(255,255,255,0.09)', 'border-md': 'rgba(255,255,255,0.17)',
        'primary': '#2FB58A', 'primary-hover': '#3CC79A', 'primary-bg': '#0B3A30', 'primary-text': '#9FE1CB',
      },
    },
    aurore: {
      label: 'Aurore', desc: 'Neutres froids, accent indigo',
      light: {
        'bg-primary': '#FFFFFF', 'bg-secondary': '#F5F6FA', 'bg-tertiary': '#EAECF3',
        'sidebar-bg': '#EEF0F7',
        'text-primary': '#15172B', 'text-secondary': '#4F546B', 'text-tertiary': '#858AA3',
        'border': 'rgba(30,35,80,0.10)', 'border-md': 'rgba(30,35,80,0.20)',
        'primary': '#5B5BD6', 'primary-hover': '#4A4AC4', 'primary-bg': '#E8E8FB', 'primary-text': '#3A3AA0',
      },
      dark: {
        'bg-primary': '#12131C', 'bg-secondary': '#1A1C28', 'bg-tertiary': '#242737',
        'sidebar-bg': '#0F1018',
        'text-primary': '#ECEDF5', 'text-secondary': '#AEB2C8', 'text-tertiary': '#7D819A',
        'border': 'rgba(255,255,255,0.09)', 'border-md': 'rgba(255,255,255,0.17)',
        'primary': '#8B8BF0', 'primary-hover': '#9D9DF5', 'primary-bg': '#26285C', 'primary-text': '#CBCBFA',
        'primary-fg': '#15172B',
      },
    },
    sable: {
      label: 'Sable', desc: 'Crème et terracotta, chaleureux',
      light: {
        'bg-primary': '#FFFDF8', 'bg-secondary': '#F7F1E6', 'bg-tertiary': '#EFE6D6',
        'sidebar-bg': '#F4ECDD',
        'text-primary': '#2A211A', 'text-secondary': '#6B5D50', 'text-tertiary': '#9A8C7D',
        'border': 'rgba(70,45,20,0.12)', 'border-md': 'rgba(70,45,20,0.22)',
        'primary': '#C2571F', 'primary-hover': '#A64815', 'primary-bg': '#FBE6D8', 'primary-text': '#8A3A0E',
      },
      dark: {
        'bg-primary': '#1C1815', 'bg-secondary': '#26211C', 'bg-tertiary': '#322B25',
        'sidebar-bg': '#181411',
        'text-primary': '#F3ECE2', 'text-secondary': '#C2B5A6', 'text-tertiary': '#8F8477',
        'border': 'rgba(255,240,220,0.09)', 'border-md': 'rgba(255,240,220,0.17)',
        'primary': '#E07A3F', 'primary-hover': '#EA8B54', 'primary-bg': '#4A2A17', 'primary-text': '#F6C9AC',
      },
    },
    ardoise: {
      label: 'Ardoise', desc: 'Gris bleuté, accent bleu acier',
      light: {
        'bg-primary': '#FFFFFF', 'bg-secondary': '#F1F5F9', 'bg-tertiary': '#E2E8F0',
        'sidebar-bg': '#E9EEF5',
        'text-primary': '#0F172A', 'text-secondary': '#475569', 'text-tertiary': '#7C8798',
        'border': 'rgba(15,23,42,0.10)', 'border-md': 'rgba(15,23,42,0.20)',
        'primary': '#2563EB', 'primary-hover': '#1D4ED8', 'primary-bg': '#DBEAFE', 'primary-text': '#1E40AF',
      },
      dark: {
        'bg-primary': '#0B1220', 'bg-secondary': '#131C2E', 'bg-tertiary': '#1C2740',
        'sidebar-bg': '#070D19',
        'text-primary': '#E5EAF3', 'text-secondary': '#A5B1C6', 'text-tertiary': '#748199',
        'border': 'rgba(255,255,255,0.09)', 'border-md': 'rgba(255,255,255,0.17)',
        'primary': '#60A5FA', 'primary-hover': '#7CB6FB', 'primary-bg': '#1E3A8A', 'primary-text': '#BFDBFE',
      },
    },
    foret: {
      label: 'Forêt', desc: 'Mousse et sapin, accent vert profond',
      light: {
        'bg-primary': '#FDFDFB', 'bg-secondary': '#F1F5EF', 'bg-tertiary': '#E3EBDF',
        'sidebar-bg': '#EAF1E6',
        'text-primary': '#182119', 'text-secondary': '#4E5C50', 'text-tertiary': '#7F8C80',
        'border': 'rgba(20,40,25,0.11)', 'border-md': 'rgba(20,40,25,0.21)',
        'primary': '#2F7D4A', 'primary-hover': '#25663B', 'primary-bg': '#DCEFE1', 'primary-text': '#1F5A34',
      },
      dark: {
        'bg-primary': '#0F1712', 'bg-secondary': '#17211A', 'bg-tertiary': '#1F2C23',
        'sidebar-bg': '#0B120E',
        'text-primary': '#E8F0E9', 'text-secondary': '#AEBFB2', 'text-tertiary': '#7B8B7F',
        'border': 'rgba(255,255,255,0.09)', 'border-md': 'rgba(255,255,255,0.17)',
        'primary': '#4CAF6E', 'primary-hover': '#5EBF80', 'primary-bg': '#1C4A2E', 'primary-text': '#B6E6C6',
      },
    },
  }
  const MODES = ['system', 'light', 'dark']
  const MOTIONS = ['full', 'reduced']
  const DEFAULT_THEME = 'opale'
  const DEFAULT_MODE  = IS_MOBILE ? 'dark' : 'system'
  const STORAGE_MOTION = 'opale.motion'

  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

  function read(key, fallback, allowed) {
    try {
      const v = localStorage.getItem(key)
      return allowed(v) ? v : fallback
    } catch { return fallback }
  }
  let _theme = read(STORAGE_THEME, DEFAULT_THEME, v => !!THEMES[v])
  let _mode  = read(STORAGE_MODE,  DEFAULT_MODE,  v => MODES.includes(v))
  let _motion = read(STORAGE_MOTION, 'full', v => MOTIONS.includes(v))

  // Couche d'aurore du thème Opale : insérée une fois dans <body>, affichée
  // par CSS uniquement quand html[data-theme="opale"]. Purement décorative.
  function ensureEffectsLayer() {
    if (!document.body || document.getElementById('opal-bg')) return
    const el = document.createElement('div')
    el.id = 'opal-bg'
    el.setAttribute('aria-hidden', 'true')
    el.innerHTML = '<div class="opal-conic"></div><div class="opal-conic-2"></div><div class="opal-grain"></div><div class="opal-vignette"></div>'
    document.body.prepend(el)
  }

  function resolvedScheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode
    return mq && mq.matches ? 'dark' : 'light'
  }

  function apply() {
    const theme  = THEMES[_theme] || THEMES[DEFAULT_THEME]
    const scheme = resolvedScheme(_mode)
    const pal    = Object.assign({ 'bg-base': (theme[scheme] || {})['bg-primary'], 'glow': 'transparent' }, scheme === 'dark' ? SEM_DARK : SEM_LIGHT, theme[scheme])
    const root   = document.documentElement
    for (const k in pal) root.style.setProperty('--' + k, pal[k])
    root.setAttribute('data-effects', theme.effects || 'none')
    root.setAttribute('data-motion', _motion)
    if (theme.effects) {
      if (document.body) ensureEffectsLayer()
      else document.addEventListener('DOMContentLoaded', ensureEffectsLayer, { once: true })
    }
    // Mobile : la couleur d'accent historique est --blue (nav active,
    // boutons principaux) → suit l'accent du thème.
    if (IS_MOBILE) {
      root.style.setProperty('--blue', pal.primary)
      root.style.setProperty('--blue-text', scheme === 'dark' ? pal['primary-text'] : pal.primary)
    }
    root.setAttribute('data-theme', _theme)
    root.setAttribute('data-mode', _mode)
    root.setAttribute('data-scheme', scheme)
    root.style.colorScheme = scheme
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', pal['bg-primary'])
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: _theme, mode: _mode, scheme } }))
  }

  function set({ theme, mode, motion } = {}, { persist = true } = {}) {
    if (theme && THEMES[theme]) _theme = theme
    if (mode && MODES.includes(mode)) _mode = mode
    if (motion && MOTIONS.includes(motion)) _motion = motion
    if (persist) {
      try { localStorage.setItem(STORAGE_THEME, _theme); localStorage.setItem(STORAGE_MODE, _mode); localStorage.setItem(STORAGE_MOTION, _motion) } catch {}
    }
    apply()
  }

  // Après authentification : la préférence serveur (multi-appareils) prime
  // sur le cache local ; si le serveur n'a rien, on y pousse le choix local
  // (best-effort, silencieux).
  async function syncFromPrefs(api) {
    if (!api?.getMyPrefs) return
    try {
      const prefs = await api.getMyPrefs()
      const hasServer = prefs && (THEMES[prefs.ui_theme] || MODES.includes(prefs.ui_mode) || MOTIONS.includes(prefs.ui_motion))
      if (hasServer) {
        set({ theme: prefs.ui_theme, mode: prefs.ui_mode, motion: prefs.ui_motion })
      }
    } catch {}
  }

  // Enregistre côté serveur (appelé par les écrans de réglages).
  async function save(api, { theme, mode, motion } = {}) {
    set({ theme, mode, motion })
    try { await api?.updateMyPrefs?.({ ui_theme: _theme, ui_mode: _mode, ui_motion: _motion }) } catch {}
  }

  if (mq) {
    const onChange = () => { if (_mode === 'system') apply() }
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else if (mq.addListener) mq.addListener(onChange)
  }

  apply()

  window.OpaleTheme = {
    THEMES, MODES, MOTIONS, DEFAULT_THEME, DEFAULT_MODE,
    get: () => ({ theme: _theme, mode: _mode, motion: _motion, scheme: resolvedScheme(_mode) }),
    set, save, syncFromPrefs, apply,
  }
})()
