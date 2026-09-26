// Faux serveur SSH local (ssh2) pour les tests des chemins SSH sortants :
// accepte toute authentification et répond à `exec` / `shell` par `output`
// puis le code de sortie donné. Chaque serveur a sa propre clé d'hôte, ce qui
// permet de simuler un poste réinstallé ou un imposteur sur la même IP.

import ssh2 from 'ssh2'

const { Server: SshServer, utils: sshUtils } = ssh2

// ssh2 génère environ 0,2 % de clés ed25519 que son propre parseur refuse :
// on régénère (borné) jusqu'à obtenir une clé lisible.
export function ed25519KeyPair() {
  for (let i = 0; i < 20; i++) {
    const k = sshUtils.generateKeyPairSync('ed25519')
    if (!(sshUtils.parseKey(k.private) instanceof Error)) return k
  }
  throw new Error('ssh2 : aucune clé ed25519 lisible générée')
}

// Démarre un serveur sur 127.0.0.1 (port libre). Retourne { port, state }
// où `state.execs` compte les commandes réellement reçues (0 si la poignée de
// main a été refusée côté client avant authentification). `rejectAuth` :
// hôte qui refuse la clé d'Opale (IP réattribuée à un autre pair).
// `endOnReady` : hôte qui raccroche juste après l'authentification.
export async function startFakeSshServer(t, { output = 'ok', exitCode = 0, rejectAuth = false, endOnReady = false } = {}) {
  const hostKey = ed25519KeyPair()
  const state = { execs: 0 }
  const server = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => (rejectAuth ? ctx.reject() : ctx.accept()))
    client.on('ready', () => {
      if (endOnReady) { client.end(); return }
      client.on('session', (accept) => {
        const session = accept()
        const reply = (acceptStream) => {
          state.execs++
          const stream = acceptStream()
          stream.write(output)
          stream.exit(exitCode)
          stream.end()
        }
        session.on('exec', reply)
        session.on('pty', (acceptPty) => acceptPty?.())
        session.on('shell', reply)
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { port: server.address().port, state }
}

// Positionne des variables d'environnement pour la durée d'un test.
export function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })
}

// Clé cliente + variables SSH pointant vers le faux serveur.
export function sshClientEnv(t, port) {
  const clientKey = ed25519KeyPair()
  withEnv(t, {
    SSH_PORT: String(port),
    SSH_USER: 'opale',
    SSH_PRIVATE_KEY_B64: Buffer.from(clientKey.private).toString('base64'),
  })
}

// Collecte les rejets de promesse non gérés pendant un test : sans
// gestionnaire, Node 22 arrête le processus de l'API.
export function trackUnhandledRejections(t) {
  const seen = []
  const onRejection = (reason) => seen.push(String(reason?.message || reason))
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))
  return seen
}
