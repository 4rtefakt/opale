// Stockage disque des pièces jointes de tickets (upload manuel).
//
// Les fichiers vivent sous un répertoire de base (volume Docker RW en prod,
// répertoire temporaire en test) dans une arborescence <ticket_id>/<uuid>.
// On ne met jamais le nom de fichier d'origine dans le chemin (anti
// path-traversal) ; il n'est conservé qu'en DB (colonne filename) et
// renvoyé au download via Content-Disposition.

import { randomUUID } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

// Répertoire de base configurable (ATTACHMENTS_DIR), défaut = chemin du
// volume monté en prod. En test, le caller passe un tmpdir via l'env.
export function attachmentsBaseDir() {
  return process.env.ATTACHMENTS_DIR || '/app/data/ticket-attachments'
}

// Chemin absolu sur disque à partir du storage_path relatif stocké en DB.
// Résout puis vérifie que le résultat reste sous la base (défense
// supplémentaire contre un storage_path malformé).
export function resolveAttachmentPath(storagePath) {
  const base = path.resolve(attachmentsBaseDir())
  const abs  = path.resolve(base, storagePath)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('storage_path hors base')
  }
  return abs
}

// Écrit le stream `fileStream` sur disque pour un ticket donné. Retourne
// { storagePath, sizeBytes }. `onLimit` est appelé si la limite multipart
// est atteinte (file.truncated) — le caller doit alors nettoyer + 413.
export async function saveAttachmentStream(ticketId, fileStream) {
  const storagePath = path.join(ticketId, randomUUID())
  const abs = resolveAttachmentPath(storagePath)
  await mkdir(path.dirname(abs), { recursive: true })
  await pipeline(fileStream, createWriteStream(abs))
  const { size } = await stat(abs)
  return { storagePath, sizeBytes: size }
}

// Ouvre un read stream pour le download.
export function openAttachment(storagePath) {
  return createReadStream(resolveAttachmentPath(storagePath))
}

// Supprime le fichier disque. Idempotent : ignore ENOENT (déjà supprimé).
export async function deleteAttachmentFile(storagePath) {
  try {
    await unlink(resolveAttachmentPath(storagePath))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// Header Content-Disposition sûr : toujours "attachment" (jamais inline,
// pour qu'un SVG/HTML malveillant ne s'exécute pas dans le navigateur),
// filename ASCII échappé + filename* RFC 5987 pour l'unicode.
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const utf8  = encodeURIComponent(String(filename))
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}
