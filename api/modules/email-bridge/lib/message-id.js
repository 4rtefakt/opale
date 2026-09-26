// Forme stockée d'un internetMessageId dans email_thread_mapping.
//
// La colonne est `TEXT UNIQUE` : une entrée d'index btree est plafonnée à
// ~2,7 Ko. Un Message-ID forgé plus long (l'en-tête vient de l'expéditeur)
// faisait échouer l'INSERT à chaque tentative — mail « poison ». Au-delà de
// MAX_STORED_MESSAGE_ID_BYTES (un Message-ID RFC 5322 tient en une ligne de
// 998 caractères), on stocke une empreinte SHA-256 ; l'identifiant complet
// reste dans `raw`.
//
// Compatibilité : une ligne déjà stockée avec un identifiant brut long (un
// id compressible a pu passer l'index) doit rester trouvable. Les
// recherches (dédoublonnage, rattachement de fil) essaient donc la forme
// brute ET la forme stockée (messageIdLookupKeys).

import { createHash } from 'node:crypto'

export const MAX_STORED_MESSAGE_ID_BYTES = 1000

export function storedMessageId(id) {
  if (id == null) return id
  const s = String(id)
  if (Buffer.byteLength(s, 'utf8') <= MAX_STORED_MESSAGE_ID_BYTES) return s
  return `<sha256-${createHash('sha256').update(s).digest('hex')}@opale.invalid>`
}

export function messageIdLookupKeys(id) {
  const stored = storedMessageId(id)
  return stored === id ? [id] : [id, stored]
}
