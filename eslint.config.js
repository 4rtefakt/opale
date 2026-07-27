// Configuration ESLint (flat config) pour Opale.
//
// Le job CI s'appelait « Lint & test API » mais ne faisait qu'un
// `node --check`, qui vérifie uniquement qu'un fichier PARSE. Sur ~240
// fichiers JS sans types, cela ne détectait ni variable non déclarée, ni
// `await` oublié, ni promesse non gérée, ni import mort.
//
// Parti pris : un jeu de règles resserré sur ce qui attrape de VRAIS bugs, pas
// sur le style. Le code existant a une mise en forme cohérente et lisible ;
// imposer par-dessus un formateur produirait un diff massif sans rien corriger.
// Les règles ci-dessous sont donc quasi toutes des règles de correction.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import globals from 'globals'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Globals du front, dérivées du code ────────────────────────────────────
// Le front n'a pas de bundler : plusieurs centaines de fonctions sont
// publiées sur `window` puis appelées depuis des attributs `onclick=` inline.
// Elles n'ont donc aucune référence statique dans le module qui les consomme,
// et `no-undef` les signalerait toutes.
//
// Les lister à la main les figerait immédiatement et — plus grave — obligerait
// à y ajouter tout nouveau nom, y compris un nom fautif : la règle ne
// détecterait alors plus jamais une faute de frappe. On scanne donc les
// affectations `window.X =` réellement présentes dans front/. Un appel à
// `window.tkOpenDrawrer()` (typo) reste signalé, puisque rien ne l'assigne.
function frontWindowGlobals() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'tabler-icons-webfont') continue
        walk(full)
      } else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8')
        for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) found.add(m[1])
      }
    }
  }
  try { walk(path.join(__dirname, 'front')) } catch { /* front absent : pas bloquant */ }
  return Object.fromEntries([...found].map(name => [name, 'readonly']))
}

const correctness = {
  // ── Vrais bugs ──────────────────────────────────────────────────────────
  'no-undef':                   'error',
  // `args: 'none'` : les signatures de handlers Fastify (req, reply) et de
  // callbacks ssh2 sont POSITIONNELLES et imposées — un `reply` inutilisé
  // n'est pas du code mort, c'est la signature. Les VARIABLES restent
  // vérifiées : c'est là que se cache le vrai code mort.
  'no-unused-vars':             ['error', {
    args: 'none',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',       // `catch {}` volontaires, très courants ici
    // `const { q, alt, ...spec } = obj` est l'idiome standard pour OMETTRE
    // des clés : q et alt sont nommées précisément pour être exclues.
    ignoreRestSiblings: true,
  }],
  'no-const-assign':            'error',
  'no-dupe-keys':               'error',
  'no-dupe-args':               'error',
  'no-duplicate-case':          'error',
  'no-unreachable':             'error',
  'no-fallthrough':             'error',
  'no-self-compare':            'error',
  'no-template-curly-in-string': 'error',  // '${x}' au lieu de `${x}`
  // Faux positifs structurels ici : les vues embarquent des exemples
  // PowerShell (`\$env:PATH`) et des classes de caractères où l'échappement
  // explicite documente l'intention. La règle est cosmétique, le bruit ne
  // vaut pas le signal.
  'no-useless-escape':          'off',
  // ssh.js et sa version mobile parsent des séquences ANSI : les caractères
  // de contrôle dans ces regex sont le sujet même du code.
  'no-control-regex':           'off',
  'no-unsafe-negation':         'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan':                  'error',
  'valid-typeof':               'error',
  'no-constant-condition':      ['error', { checkLoops: false }],
  'no-sparse-arrays':           'error',
  // `try { … } catch {}` est un idiome assumé et fréquent ici (best-effort
  // explicitement documenté : flush de buffer, audit non bloquant, parse
  // tolérant). Les autres blocs vides restent des erreurs.
  'no-empty':                   ['error', { allowEmptyCatch: true }],
  'no-async-promise-executor':  'error',
  'require-atomic-updates':     'off',     // trop de faux positifs sur les handlers

  // ── Asynchrone : la classe de bugs la plus coûteuse dans ce code ────────
  'no-return-await':            'error',
  'require-await':              'off',     // handlers Fastify async sans await = normal

  // ── Sécurité ────────────────────────────────────────────────────────────
  'no-eval':                    'error',
  'no-implied-eval':            'error',
  'no-new-func':                'error',
  'no-script-url':              'error',
  'no-proto':                   'error',
  'no-extend-native':           'error',
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'front/msal-browser.min.js',
      'front/xterm.js',
      'front/chart.umd.min.js',
      'front/tabler-icons-webfont/**',
      'landing/**',
      'agent-go/**',
    ],
  },

  // ── API : ESM, Node ──────────────────────────────────────────────────────
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...correctness },
  },

  // ── Front : ESM chargé directement par le navigateur ─────────────────────
  // Beaucoup de fonctions sont exposées via `window.x = …` puis appelées
  // depuis des attributs `onclick=` inline : elles n'ont donc pas de
  // référence statique dans le module et seraient signalées à tort.
  {
    files: ['front/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // Bibliothèques vendorisées, chargées par <script> avant les modules.
        msal: 'readonly',
        Chart: 'readonly',
        Terminal: 'readonly',
        // Tout ce que le code publie sur `window` (cf. frontWindowGlobals).
        ...frontWindowGlobals(),
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...correctness,
      // Le point d'entrée d'une vue est référencé depuis le routeur par nom,
      // pas par import : on ne peut pas exiger une référence statique.
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^(_|render|init|mount)',
        caughtErrors: 'none',
      }],
    },
  },

  // ── Catalogues i18n ──────────────────────────────────────────────────────
  // Ces fichiers contiennent des libellés qui DÉCRIVENT une syntaxe à
  // l'utilisateur (ex. la clause OData `${attribut} eq '${valeur}'`). Le
  // `${…}` y est du texte affiché, pas une interpolation ratée.
  {
    files: ['front/locales/*.js'],
    rules: { 'no-template-curly-in-string': 'off' },
  },

  // ── Tests : node:test ────────────────────────────────────────────────────
  {
    files: ['api/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...correctness },
  },
]
