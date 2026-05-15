// Sert les assets de branding avec fallback :
//   GET /branding/icon.svg → front/branding/icon.svg si présent, sinon front/icon.svg
// Le contenu de front/branding/ est documenté dans front/branding/README.md.
// Aucun JS côté client : l'URL est fixe, le serveur résout.

import fs from 'fs/promises'
import { join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { createReadStream } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Dans l'image Docker, api/ est aplati à la racine /app/ (cf. api/Dockerfile),
// donc ce fichier est à /app/modules/core/routes/branding.js et front/ est
// à /app/front/ — il faut remonter 3 niveaux pour atteindre /app/.
const FRONT_ROOT = join(__dirname, '..', '..', '..', 'front')

const MIME = {
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
}

function safeAssetName(name) {
  // Empêche les traversées de chemin : un seul segment, pas de slash.
  const clean = basename(name || '')
  return /^[A-Za-z0-9._-]+$/.test(clean) ? clean : null
}

async function fileExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

export default async function brandingRoute(fastify) {
  fastify.get('/branding/:asset', async (req, reply) => {
    const asset = safeAssetName(req.params.asset)
    if (!asset) return reply.code(400).send({ error: 'Invalid asset name' })

    const overridePath = join(FRONT_ROOT, 'branding', asset)
    const fallbackPath = join(FRONT_ROOT, asset)

    const path = (await fileExists(overridePath))
      ? overridePath
      : (await fileExists(fallbackPath) ? fallbackPath : null)

    if (!path) return reply.code(404).send({ error: 'Asset not found' })

    const ext = extname(asset).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    reply.header('Content-Type', mime)
    reply.header('Cache-Control', 'public, max-age=300')
    // X-Content-Type-Options + CSP stricte sur les SVG : un SVG peut contenir
    // <script> et des handlers on*=. Notre usage est <img src="…"> où le
    // browser sandbox déjà l'exécution, mais si quelqu'un ouvre l'URL en
    // direct, la CSP refuse les scripts/CSS inline. Défense en profondeur
    // si un attaquant arrive à déposer un fichier dans front/branding/.
    reply.header('X-Content-Type-Options', 'nosniff')
    if (ext === '.svg') {
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    }
    return reply.send(createReadStream(path))
  })
}
