#!/usr/bin/env node
// Build cross-arch + génération de l'installeur PowerShell embarqué.
//
// Ce script :
//   1. Compile l'agent Go pour Windows amd64 + arm64 avec un branding
//      injecté via -ldflags -X.
//   2. Produit dist/agent-version.txt (version lue depuis version.go).
//   3. Substitue les markers ##...## de install.ps1 (binaire amd64 en B64,
//      token, url, noms de service / dossier / binaire) et écrit
//      dist/install-Agent.ps1.
//
// Usage :
//   TOKEN=eyJ... URL=https://rmm.example.com node agent-go/build.js
//   node agent-go/build.js --token eyJ... --url https://rmm.example.com
//
// Branding :
//   Par défaut, les valeurs neutres du paquet branding/ sont utilisées
//   (Opale-Agent, Opale, opale-agent, ...). Pour personnaliser :
//
//   - Profil JSON : créer `instance-local/agent-profile.json` avec un
//     subset des clés ci-dessous (gitignored, non publié).
//   - Override granulaire en CLI : --service-name=..., --data-dir-name=...,
//     --user-agent-slug=..., --laps-default-user=...,
//     --legacy-data-dir=... (pour la compat shim ancien dossier ProgramData)
//
// Autres flags :
//   --no-build  ne lance pas `go build` (suppose les binaires déjà présents
//               dans dist/), utile pour itérer sur l'installeur.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
const argv  = process.argv

const flagValue = (name) => {
  // Accepte --name=value ET --name value
  const eq = argv.find(a => a.startsWith(name + '='))
  if (eq) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  return i > 0 ? (argv[i + 1] || '') : ''
}

const token     = process.env.TOKEN || flagValue('--token')
const rawUrl    = process.env.URL   || flagValue('--url')
const url       = rawUrl.replace(/\/api$/, '').replace(/\/$/, '')
const skipBuild = argv.includes('--no-build')

if (!token || !url) {
  console.error('Usage : TOKEN=... URL=https://rmm.example.com node agent-go/build.js')
  process.exit(1)
}

// --- Profil de branding par défaut (aligné avec branding/branding.go) -------
const DEFAULT_BRANDING = {
  serviceName:            'Opale-Agent',
  serviceDisplayName:     'Opale Agent',
  serviceDescription:     'Agent Opale — checkin et auto-update.',
  dataDirName:            'Opale',
  binName:                'opale-agent',
  userAgentSlug:          'opale-agent-go',
  lapsDefaultUser:        'opale-recovery',
  lapsAccountDescription: 'Opale recovery account (LAPS-rotated)',
  legacyDataDirName:      '',
}

// Override 1 : fichier de profil local non publié (instance-local/agent-profile.json)
const profilePath = join(__dir, '..', 'instance-local', 'agent-profile.json')
const branding = { ...DEFAULT_BRANDING }
if (existsSync(profilePath)) {
  try {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    for (const [k, v] of Object.entries(profile)) {
      if (k in DEFAULT_BRANDING && typeof v === 'string') branding[k] = v
    }
    console.log(`→ profil branding chargé depuis ${profilePath}`)
  } catch (e) {
    console.error(`Erreur lecture ${profilePath} : ${e.message}`)
    process.exit(1)
  }
}

// Override 2 : flags CLI (priorité ultime)
const flagOverrides = {
  serviceName:            flagValue('--service-name'),
  serviceDisplayName:     flagValue('--service-display-name'),
  serviceDescription:     flagValue('--service-description'),
  dataDirName:            flagValue('--data-dir-name'),
  binName:                flagValue('--bin-name'),
  userAgentSlug:          flagValue('--user-agent-slug'),
  lapsDefaultUser:        flagValue('--laps-default-user'),
  lapsAccountDescription: flagValue('--laps-account-description'),
  legacyDataDirName:      flagValue('--legacy-data-dir'),
}
for (const [k, v] of Object.entries(flagOverrides)) if (v) branding[k] = v

console.log(`→ branding effectif :`)
for (const [k, v] of Object.entries(branding)) console.log(`    ${k.padEnd(24)} ${v || '(vide)'}`)

// --- Overlay pins.txt depuis instance-local si présent (cf. .gitignore) -----
// Le fichier embarqué via //go:embed pinning/pins.txt est sinon vide.
const localPinsPath = join(__dir, '..', 'instance-local', 'pinning', 'pins.txt')
const publicPinsPath = join(__dir, 'pinning', 'pins.txt')
if (existsSync(localPinsPath)) {
  copyFileSync(localPinsPath, publicPinsPath)
  console.log(`→ pins.txt overlay depuis instance-local/`)
}

// --- ldflags Go --------------------------------------------------------------
// Module path = github.com/4rtefakt/opale/agent-go (cf. go.mod).
// Le branding runtime est dérivé via -ldflags (indépendant du module path).
const PKG = 'github.com/4rtefakt/opale/agent-go/branding'
const ldflagsBranding = [
  ['ServiceName',            branding.serviceName],
  ['ServiceDisplayName',     branding.serviceDisplayName],
  ['ServiceDescription',     branding.serviceDescription],
  ['DataDirName',            branding.dataDirName],
  ['BinName',                branding.binName],
  ['UserAgentSlug',          branding.userAgentSlug],
  ['LAPSDefaultUser',        branding.lapsDefaultUser],
  ['LAPSAccountDescription', branding.lapsAccountDescription],
  ['LegacyDataDirName',      branding.legacyDataDirName],
].map(([sym, val]) => `-X '${PKG}.${sym}=${val}'`).join(' ')

const ldflags = `-s -w ${ldflagsBranding}`

// --- Build cross-arch --------------------------------------------------------
const archs = ['amd64', 'arm64']

if (!skipBuild) {
  for (const arch of archs) {
    const outName = `${branding.binName}-${arch}.exe`
    console.log(`→ go build (GOOS=windows GOARCH=${arch}) → dist/${outName}`)
    execSync(
      `GOOS=windows GOARCH=${arch} go build -ldflags="${ldflags}" -o dist/${outName} .`,
      { cwd: __dir, stdio: 'inherit' }
    )
  }
}

// Compatibilité : on copie l'amd64 sur l'ancien chemin sans suffixe arch
// pour les API qui le servent en fallback (cf. AGENT_BIN_LEGACY côté API).
copyFileSync(
  join(__dir, 'dist', `${branding.binName}-amd64.exe`),
  join(__dir, 'dist', `${branding.binName}.exe`)
)

// Sidecar version → lu par l'API. On parse version.go pour rester
// la seule source de vérité (le const AgentVersion).
const versionGo = readFileSync(join(__dir, 'version.go'), 'utf8')
const versionMatch = versionGo.match(/AgentVersion\s*=\s*"([^"]+)"/)
if (!versionMatch) { console.error('AgentVersion introuvable dans version.go'); process.exit(1) }
writeFileSync(join(__dir, 'dist', 'agent-version.txt'), versionMatch[1] + '\n', 'utf8')
console.log(`→ agent-version.txt = ${versionMatch[1]}`)

// --- Génération de l'installeur PS ------------------------------------------
const binPath = join(__dir, 'dist', `${branding.binName}-amd64.exe`)
if (!existsSync(binPath)) {
  console.error(`Binaire introuvable : ${binPath}`)
  console.error('  → exécutez sans --no-build, ou compilez manuellement.')
  process.exit(1)
}

const bin    = readFileSync(binPath)
const binB64 = bin.toString('base64')
const tmpl   = readFileSync(join(__dir, 'install.ps1'), 'utf8')

// Remplacement strict des markers — pas de regex, pas d'échappement
// surprise. Le binaire en B64 est inerte côté PS (juste une string).
const replacements = [
  ["'##AGENT_BIN_B64##'",        `'${binB64}'`],
  ["'##TOKEN##'",                `'${token}'`],
  ["'##URL##'",                  `'${url}'`],
  ["'##SERVICE_NAME##'",         `'${branding.serviceName}'`],
  ["'##SERVICE_DISPLAY_NAME##'", `'${branding.serviceDisplayName}'`],
  ["'##SERVICE_DESCRIPTION##'",  `'${branding.serviceDescription}'`],
  ["'##DATA_DIR_NAME##'",        `'${branding.dataDirName}'`],
  ["'##BIN_NAME##'",             `'${branding.binName}'`],
]
let out = tmpl
for (const [marker, value] of replacements) out = out.replace(marker, value)

const outPath = join(__dir, 'dist', 'install-Agent.ps1')
writeFileSync(outPath, out, 'utf8')
console.log(`✓ ${outPath} (${bin.length} octets binaire embarqué)`)

console.log(`\nDéploiement :`)
console.log(`  scp ${outPath} root@<server>:/tmp/`)
console.log(`  ou via Intune (PowerShell script, contexte SYSTEM)`)
