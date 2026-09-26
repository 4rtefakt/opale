// Vérification des clés d'hôte SSH (TOFU persisté).
// Repris de la branche claude/tool-security-architecture-review-s8j0am
// (63bb247), sans ses autres changements.
//
// `ssh2` accepte n'importe quelle clé d'hôte quand aucun `hostVerifier` n'est
// fourni, et il n'existait pas de known_hosts côté serveur. L'authentification
// par clé publique empêche un attaquant de rejouer la clé privée d'Opale, mais
// pas de se faire passer pour le poste cible. Sur un mesh VPN où les IP sont
// réattribuables (Netbird, Tailscale, ZeroTier — ceux que la doc recommande),
// détourner une IP suffisait alors à obtenir :
//   • le contenu intégral des scripts PowerShell poussés (qui portent en
//     pratique des identifiants d'installation) ;
//   • tout ce que l'admin tape dans le terminal web ;
//   • la capacité de renvoyer une sortie falsifiée, donc de faire croire à une
//     remédiation qui n'a pas eu lieu.
//
// Modèle retenu : Trust On First Use, par device.
//   • Premier contact  → on mémorise l'empreinte SHA-256 de la clé d'hôte.
//   • Contacts suivants → toute clé différente coupe la connexion.
//   • Changement légitime (réinstallation du poste, régénération des clés
//     sshd) → un admin remet l'empreinte à zéro depuis la fiche du poste,
//     et le prochain contact réapprend. Chaque étape est auditée.
//
// Le TOFU laisse une fenêtre : si le tout premier contact est déjà détourné,
// on épingle la mauvaise clé. C'est le compromis standard de ce modèle, et il
// reste très supérieur à l'absence totale de vérification — l'attaquant doit
// être en place AVANT le premier accès et le rester, sans quoi la coupure est
// immédiate et visible.
//
// OPALE_SSH_HOST_KEY_POLICY :
//   tofu   (défaut) — apprend au premier contact, refuse tout changement
//   strict          — refuse aussi le premier contact tant qu'aucune empreinte
//                     n'est enregistrée (parcs où l'empreinte est provisionnée
//                     hors bande)
//
// Format de l'empreinte : SHA-256 de la clé, en base64 sans padding — la
// valeur que `ssh-keygen -lf` affiche après « SHA256: ». Une valeur stockée
// avec ce préfixe ou avec le padding « = » (provisionnée à la main, ou écrite
// par une autre version du code) est acceptée : la comparaison normalise.
//
// Déroulé d'une connexion (hostKeyGuard) :
//   1. hostVerifier (asynchrone : ssh2 fournit un callback `verify`) relit
//      l'empreinte en base à la poignée de main initiale et refuse toute clé
//      différente AVANT l'authentification. Poste sans empreinte : accepté en
//      tofu, mais rien n'est encore mémorisé. Les rekeys (dans le canal déjà
//      authentifié) sont comparés en mémoire à la clé acceptée : pas d'aller-
//      retour en base qui pourrait couper une session en cours.
//   2. confirm(), appelé sur 'ready' AVANT toute commande, mémorise
//      l'empreinte (UPDATE … WHERE ssh_host_key_fp IS NULL) : un hôte qui
//      refuse la clé d'Opale (IP réattribuée à un autre pair) n'est donc pas
//      épinglé à la place du poste. Si une autre connexion a mémorisé une clé
//      différente entre-temps, confirm() refuse : de deux premiers contacts
//      concurrents, un seul peut recevoir des commandes.
//   Toute erreur de base pendant la vérification refuse la connexion.

import crypto from 'node:crypto'
import { logAudit } from '../../core/lib/audit.js'

// Algorithmes de clé d'hôte acceptés, dans l'ordre par défaut de ssh2 1.17
// (Node 22, ed25519 disponible). Figés ici : l'empreinte dépend du type de
// clé négocié, et un changement d'ordre dans une future version de ssh2
// ferait refuser tous les postes déjà connus.
export const SSH_HOST_KEY_ALGORITHMS = Object.freeze([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
])

export function hostKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

// Forme canonique d'une empreinte stockée : sans préfixe « SHA256: », sans
// padding, sans espaces autour.
export function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return null
  const v = fp.trim().replace(/^SHA256:/i, '').trim().replace(/=+$/, '')
  return v || null
}

let _warnedPolicy = null
export function hostKeyPolicy(env = process.env, log = null) {
  const raw = String(env.OPALE_SSH_HOST_KEY_POLICY || '').trim().toLowerCase()
  if (raw === 'strict') return 'strict'
  if (raw && raw !== 'tofu' && _warnedPolicy !== raw) {
    // Valeur inconnue (faute de frappe) : on reste en tofu, mais on le dit.
    _warnedPolicy = raw
    log?.warn?.({ value: raw }, 'OPALE_SSH_HOST_KEY_POLICY inconnue : politique tofu appliquée')
  }
  return 'tofu'
}

// Charge l'empreinte connue d'un device (forme canonique), ou null.
// `undefined` si le device n'existe pas.
export async function loadKnownHostKey(db, deviceId) {
  const { rows } = await db.query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [deviceId])
  if (!rows.length) return undefined
  return normalizeFingerprint(rows[0].ssh_host_key_fp)
}

/**
 * Garde de clé d'hôte pour UNE connexion ssh2 vers un device.
 *
 * Usage :
 *   const guard = hostKeyGuard({ db, log }, device, { onReject })
 *   conn.on('ready', async () => { if (!(await guard.confirm())) return conn.end(); … })
 *   conn.connect({ …, ...guard.sshOptions })
 *
 * @param {object} deps    - { db, log }
 * @param {object} device  - { id, hostname }
 * @param {object} [opts]  - { policy, onReject(message) }
 */
export function hostKeyGuard({ db, log }, device, opts = {}) {
  const policy = opts.policy || hostKeyPolicy(process.env, log)
  let pendingFp = null   // clé acceptée en tofu, à mémoriser sur 'ready'
  let acceptedFp = null  // clé acceptée à la poignée de main initiale
  let rejected = false

  const reject = (message) => {
    if (rejected) return
    rejected = true
    opts.onReject?.(message)
  }

  // logAudit ne lève jamais (erreurs journalisées) : on l'attend pour que
  // l'entrée existe quand la connexion est refusée.
  const mismatch = async (expected, presented) => {
    log.error(
      { device_id: device.id, hostname: device.hostname, expected, got: presented },
      'ssh : clé d\'hôte inattendue — connexion refusée'
    )
    await logAudit(db, log, {
      action:  'ssh_host_key_mismatch',
      byUser:  'système',
      target:  device.id,
      details: {
        level: 'error', hostname: device.hostname,
        expected_fingerprint: expected, presented_fingerprint: presented,
      },
    })
    reject(
      `Clé d'hôte SSH inattendue pour ${device.hostname}. La connexion a été refusée. ` +
      `Si le poste a été réinstallé, réinitialisez son empreinte depuis sa fiche ; ` +
      `sinon, traitez l'incident comme une possible interception.`
    )
  }

  const dbFailure = (err) => {
    log.error({ err: err.message, device_id: device.id },
      'ssh : vérification de la clé d\'hôte impossible — connexion refusée')
    reject(`Vérification de la clé d'hôte SSH de ${device.hostname} impossible. La connexion a été refusée.`)
  }

  // Appelé par ssh2 à chaque poignée de main (connexion initiale et rekeys).
  // Ne retourne rien : la réponse passe par `verify`.
  function hostVerifier(key, verify) {
    const fp = hostKeyFingerprint(key)
    if (acceptedFp) {
      // Rekey : même clé attendue que pour la poignée de main initiale.
      if (fp === acceptedFp) return verify(true)
      mismatch(acceptedFp, fp).finally(() => verify(false))
      return
    }
    loadKnownHostKey(db, device.id).then(async (known) => {
      if (known === undefined) {
        reject(`Poste ${device.hostname} introuvable.`)
        return verify(false)
      }
      if (known) {
        if (fp === known) { acceptedFp = fp; return verify(true) }
        await mismatch(known, fp)
        return verify(false)
      }
      if (policy === 'strict') {
        log.error(
          { device_id: device.id, hostname: device.hostname, presented: fp },
          'ssh : aucune empreinte enregistrée et politique stricte — connexion refusée'
        )
        reject(
          `Aucune empreinte SSH enregistrée pour ${device.hostname} et la politique est « strict ». ` +
          `Provisionnez l'empreinte avant de vous connecter.`
        )
        return verify(false)
      }
      pendingFp = fp
      acceptedFp = fp
      verify(true)
    }).catch((err) => {
      dbFailure(err)
      verify(false)
    })
  }

  // À appeler sur 'ready', avant toute commande : mémorise la clé acceptée au
  // premier contact. false = ne rien envoyer, fermer la connexion (le motif a
  // déjà été transmis à onReject).
  async function confirm() {
    if (rejected) return false
    if (!pendingFp) return true
    const fp = pendingFp
    try {
      const { rowCount } = await db.query(
        // Une valeur vide ou réduite au préfixe (saisie manuelle ratée) compte
        // comme absente, comme dans normalizeFingerprint.
        `UPDATE devices SET ssh_host_key_fp = $1, ssh_host_key_learned_at = now()
         WHERE id = $2
           AND (ssh_host_key_fp IS NULL
                OR btrim(regexp_replace(btrim(ssh_host_key_fp), '^SHA256:', '', 'i'), ' =') = '')`,
        [fp, device.id]
      )
      if (rowCount === 1) {
        pendingFp = null
        log.info({ device_id: device.id, hostname: device.hostname, fingerprint: fp },
          'ssh : empreinte d\'hôte apprise (premier contact)')
        await logAudit(db, log, {
          action:  'ssh_host_key_learned',
          byUser:  'système',
          target:  device.id,
          details: { level: 'info', hostname: device.hostname, fingerprint: fp },
        })
        return true
      }
      // Rien écrit : une autre connexion a mémorisé une empreinte entre la
      // poignée de main et maintenant (ou le poste a été supprimé).
      const known = await loadKnownHostKey(db, device.id)
      if (known === fp) { pendingFp = null; return true }
      if (known === undefined) { reject(`Poste ${device.hostname} introuvable.`); return false }
      await mismatch(known, fp)
      return false
    } catch (err) {
      dbFailure(err)
      return false
    }
  }

  return {
    confirm,
    hostVerifier,
    sshOptions: {
      hostVerifier,
      algorithms: { serverHostKey: [...SSH_HOST_KEY_ALGORITHMS] },
    },
  }
}
