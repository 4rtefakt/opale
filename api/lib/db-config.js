// Configuration du pool Postgres — partagée entre l'API (plugins/db.js) et
// les scripts CLI (scripts/migrate.js, scripts/purge-old-attachments.js…),
// pour qu'ils se connectent tous exactement de la même façon.
//
// TLS : `POSTGRES_SSLMODE` suit la sémantique libpq usuelle.
//   disable     (défaut) — pas de TLS. Correct quand la base est sur le même
//                          hôte Docker et n'est jamais exposée sur le réseau.
//   require                — TLS obligatoire, certificat NON vérifié. Protège
//                          de l'écoute passive, pas d'un MITM actif.
//   verify-full            — TLS obligatoire + vérification de la chaîne et du
//                          nom d'hôte. À utiliser dès que POSTGRES_HOST
//                          désigne une machine distante. `POSTGRES_SSLROOTCERT`
//                          pointe le CA à utiliser (défaut : magasin système).

import fs from 'node:fs'

const SSL_MODES = new Set(['disable', 'require', 'verify-full'])

export function buildSslConfig(env = process.env) {
  const mode = (env.POSTGRES_SSLMODE || 'disable').toLowerCase()
  if (!SSL_MODES.has(mode)) {
    throw new Error(
      `POSTGRES_SSLMODE invalide : « ${mode} » (attendu : ${[...SSL_MODES].join(', ')})`
    )
  }
  if (mode === 'disable') return false
  if (mode === 'require') return { rejectUnauthorized: false }

  const ssl = { rejectUnauthorized: true }
  if (env.POSTGRES_SSLROOTCERT) {
    ssl.ca = fs.readFileSync(env.POSTGRES_SSLROOTCERT, 'utf8')
  }
  return ssl
}

export function buildPoolConfig(env = process.env) {
  return {
    host:     env.POSTGRES_HOST || 'db',
    port:     parseInt(env.POSTGRES_PORT || '5432', 10),
    database: env.POSTGRES_DB,
    user:     env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    ssl:      buildSslConfig(env),
    max:      parseInt(env.POSTGRES_POOL_MAX || '10', 10),
    // Un client qui n'obtient pas de connexion doit échouer vite plutôt que
    // de rester pendu : sinon une saturation du pool se traduit par des
    // requêtes HTTP qui ne répondent jamais au lieu d'un 500 franc.
    connectionTimeoutMillis: parseInt(env.POSTGRES_CONNECT_TIMEOUT_MS || '10000', 10),
  }
}
