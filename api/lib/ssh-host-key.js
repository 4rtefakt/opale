// Vérification TOFU (trust-on-first-use) de la clé d'hôte SSH.
//
// ssh2 n'authentifie PAS l'hôte par défaut : sans `hostVerifier`, n'importe
// quelle clé d'hôte est acceptée. Comme la cible (devices.ip_netbird) provient
// d'une donnée rapportée par l'agent, un agent compromis rapportant une fausse
// IP pouvait rediriger une session SSH admin vers un hôte contrôlé. On ajoute
// ici une couche TOFU : la clé d'hôte est mémorisée (fingerprint SHA-256) au
// premier contact et comparée à chaque connexion suivante.
//
// Cette vérification vient EN PLUS de la sécurité réseau Netbird (WireGuard
// chiffré/authentifié) — défense en profondeur, pas en remplacement.
//
// Retourne une fonction `hostVerifier(keyBuf, cb)` conforme à ssh2.

import crypto from 'crypto'

export function fingerprint(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('base64')
}

export function makeHostVerifier({ fastify, deviceId, hostname }) {
  return function hostVerifier(keyBuf, cb) {
    const fp = fingerprint(keyBuf)
    fastify.db
      .query('SELECT ssh_host_key_fp FROM devices WHERE id = $1', [deviceId])
      .then(({ rows }) => {
        const known = rows[0]?.ssh_host_key_fp || null

        if (!known) {
          // Premier contact : on mémorise (TOFU) et on accepte. Best-effort —
          // un échec d'écriture ne doit pas bloquer la session légitime.
          fastify.db
            .query(
              'UPDATE devices SET ssh_host_key_fp = $1, ssh_host_key_seen = now() WHERE id = $2',
              [fp, deviceId]
            )
            .catch(err => fastify.log.warn({ err: err.message, deviceId }, 'ssh host key TOFU persist failed'))
          fastify.log.info({ deviceId, hostname, fp }, 'ssh host key mémorisée (TOFU)')
          return cb(true)
        }

        if (known === fp) return cb(true)

        // Mismatch : refus. Signale une rotation de clé (réinstall) OU une
        // redirection vers un hôte non-légitime. On journalise pour l'admin ;
        // la résolution légitime = effacer devices.ssh_host_key_fp (NULL).
        fastify.log.error(
          { deviceId, hostname, expected: known, got: fp },
          'ssh host key MISMATCH — connexion refusée'
        )
        cb(false)
      })
      .catch(err => {
        // En cas d'erreur DB, on refuse par défaut (fail-closed) : mieux vaut
        // une session SSH indisponible qu'une session non authentifiée.
        fastify.log.error({ err: err.message, deviceId }, 'ssh host key check failed (fail-closed)')
        cb(false)
      })
  }
}
