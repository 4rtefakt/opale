// Vérification des clés d'hôte SSH (TOFU persisté).
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

import crypto from 'node:crypto'
import { logAudit } from '../../core/lib/audit.js'

export function hostKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function hostKeyPolicy(env = process.env) {
  const p = String(env.OPALE_SSH_HOST_KEY_POLICY || 'tofu').toLowerCase()
  return p === 'strict' ? 'strict' : 'tofu'
}

/**
 * Construit le `hostVerifier` à passer à ssh2 pour un device donné.
 *
 * ssh2 appelle ce callback avec la clé d'hôte présentée ; retourner `false`
 * avorte la poignée de main avant toute authentification, donc avant que la
 * clé privée d'Opale ne soit exposée à l'hôte distant.
 *
 * Le callback est synchrone côté ssh2 : l'empreinte connue est donc chargée
 * AVANT la connexion (`loadKnownHostKey`) et la mémorisation d'une nouvelle
 * empreinte se fait en tâche de fond, sans bloquer la poignée de main.
 *
 * @param {object}  deps           - { db, log }
 * @param {object}  device         - { id, hostname }
 * @param {string?} knownFp        - empreinte enregistrée, ou null
 * @param {object}  [opts]         - { policy, onReject }
 */
export function makeHostVerifier({ db, log }, device, knownFp, opts = {}) {
  const policy = opts.policy || hostKeyPolicy()

  return function hostVerifier(key) {
    const fp = hostKeyFingerprint(key)

    if (knownFp) {
      if (fp === knownFp) return true
      log.error(
        { device_id: device.id, hostname: device.hostname, expected: knownFp, got: fp },
        'ssh : clé d\'hôte inattendue — connexion refusée'
      )
      logAudit(db, log, {
        action:  'ssh_host_key_mismatch',
        byUser:  'système',
        target:  device.id,
        details: { hostname: device.hostname, expected_fingerprint: knownFp, presented_fingerprint: fp },
      }).catch(() => {})
      opts.onReject?.(
        `Clé d'hôte SSH inattendue pour ${device.hostname}. La connexion a été refusée. ` +
        `Si le poste a été réinstallé, réinitialisez son empreinte depuis sa fiche ; ` +
        `sinon, traitez l'incident comme une possible interception.`
      )
      return false
    }

    if (policy === 'strict') {
      log.error(
        { device_id: device.id, hostname: device.hostname, presented: fp },
        'ssh : aucune empreinte enregistrée et politique stricte — connexion refusée'
      )
      opts.onReject?.(
        `Aucune empreinte SSH enregistrée pour ${device.hostname} et la politique est « strict ». ` +
        `Provisionnez l'empreinte avant de vous connecter.`
      )
      return false
    }

    // Premier contact : on mémorise. L'écriture est asynchrone — ssh2 attend
    // un booléen synchrone — mais elle est tracée et idempotente (le WHERE
    // n'écrase jamais une empreinte déjà posée : deux connexions simultanées
    // sur un device neuf ne peuvent pas se contredire).
    db.query(
      `UPDATE devices SET ssh_host_key_fp = $1, ssh_host_key_learned_at = now()
       WHERE id = $2 AND ssh_host_key_fp IS NULL`,
      [fp, device.id]
    ).then(() => {
      log.info({ device_id: device.id, hostname: device.hostname, fingerprint: fp },
        'ssh : empreinte d\'hôte apprise (premier contact)')
      return logAudit(db, log, {
        action:  'ssh_host_key_learned',
        byUser:  'système',
        target:  device.id,
        details: { hostname: device.hostname, fingerprint: fp },
      })
    }).catch(err => log.warn({ err: err.message, device_id: device.id },
      'ssh : mémorisation de l\'empreinte d\'hôte échouée'))

    return true
  }
}

// Charge l'empreinte connue d'un device. À appeler AVANT conn.connect(), le
// hostVerifier de ssh2 étant synchrone.
export async function loadKnownHostKey(db, deviceId) {
  const { rows } = await db.query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [deviceId])
  return rows[0]?.ssh_host_key_fp || null
}
