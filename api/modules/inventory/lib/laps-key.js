// Clé privée LAPS de l'instance (`laps.key`), partagée entre la consultation
// des mots de passe locaux (admin-credentials.js) et l'escrow Linux : la clé
// publique servie aux agents est DÉRIVÉE de la clé privée à l'exécution
// (`laps.pub` n'est jamais lu par l'API) et identifiée par le sha256 de son
// SPKI DER (docs/linux-fleet-design.md §4).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Layout différent en dev vs Docker (cf. agent.js).
// Docker : /app/modules/inventory/lib/ → /app/agent-go/ (3 levels up)
// Dev    : /repo/api/modules/inventory/lib/ → /repo/agent-go/ (4 levels up)
const AGENT_GO_DIR = process.env.AGENT_GO_DIR ||
  (fs.existsSync(path.join(__dirname, '..', '..', '..', 'agent-go'))
    ? path.join(__dirname, '..', '..', '..', 'agent-go')
    : path.join(__dirname, '..', '..', '..', '..', 'agent-go'))

// Résolu à la première lecture (et non à l'import) : l'env peut être posé après le chargement.
export const defaultLapsKeyPath = () => process.env.LAPS_PRIVATE_KEY || path.join(AGENT_GO_DIR, 'keys', 'laps.key')

const UNAVAILABLE = { status: 'unavailable', public_key_pem: null, key_id: null, bits: null }

export function createLapsKey({ keyPath = defaultLapsKeyPath } = {}) {
  let privateKey = null
  let derived = null
  let warned = false
  // Une lecture échouée n'est pas mémorisée : la clé peut apparaître (volume monté) sans redémarrage.
  const load = () => {
    if (privateKey) return privateKey
    const pem = fs.readFileSync(keyPath(), 'utf8')
    privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' })
    return privateKey
  }
  const derive = () => {
    if (derived) return derived
    const publicKey = crypto.createPublicKey(load())
    const der = publicKey.export({ type: 'spki', format: 'der' })
    derived = {
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
      key_id:         crypto.createHash('sha256').update(der).digest('hex'),
      bits:           publicKey.asymmetricKeyDetails?.modulusLength ?? null,
    }
    return derived
  }
  return {
    loadPrivateKey: load,
    publicKeyPem:   () => derive().public_key_pem,
    keyId:          () => derive().key_id,
    // Ne lève jamais : { status: 'ok' | 'unavailable', public_key_pem, key_id, bits }.
    // Un seul avertissement par processus quand la clé est illisible.
    info(log) {
      try {
        return { status: 'ok', ...derive() }
      } catch (err) {
        if (!warned) {
          warned = true
          log?.warn?.({ err: err.message }, 'Clé LAPS illisible : escrow indisponible pour les postes Linux')
        }
        return { ...UNAVAILABLE }
      }
    },
  }
}

export const lapsKey = createLapsKey()
export const loadLAPSKey      = () => lapsKey.loadPrivateKey()
export const lapsPublicKeyPem = () => lapsKey.publicKeyPem()
export const lapsKeyId        = () => lapsKey.keyId()
