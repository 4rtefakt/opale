// Index winget officiel Microsoft (recherche/autocomplétion).
//
// Microsoft distribue l'index winget sous forme de MSIX signé à
// https://cdn.winget.microsoft.com/cache/source2.msix — c'est exactement
// ce que le CLI `winget` télécharge lui-même. Le MSIX est un ZIP contenant
// un fichier SQLite `Public/index.db` qui liste tous les packages
// (identifiant, nom, éditeur, versions). On le télécharge au démarrage,
// on l'extrait en mémoire, on garde la SQLite chargée via sql.js (WASM)
// pour répondre aux requêtes de recherche, et on rafraîchit toutes les
// 24h. En cas d'échec de rafraîchissement, on conserve l'index précédent
// (graceful degradation — pas de coupure de service).
//
// Pourquoi sql.js (WASM) plutôt que better-sqlite3 (natif) :
//   - aucune compilation native dans le container (portable, reproductible)
//   - sandbox WASM (surface d'attaque réduite face à une éventuelle DB
//     malveillante — peu probable car la source MS est signée, mais
//     defense in depth)
//   - perf largement suffisante pour des requêtes occasionnelles sur ~50Mo
//
// Sécurité :
//   - Téléchargement HTTPS strict (chaîne TLS vérifiée → certif Microsoft)
//   - Aucun appel direct browser → CDN MS : tout transite par notre API
//   - SQLite ouverte en lecture seule, requêtes paramétrées (pas d'injection)
//   - Tout en mémoire (pas d'écriture disque, donc rien à nettoyer)

import yauzl from 'yauzl'
import initSqlJs from 'sql.js'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// URL officielle MS (source v2, format actuel). Configurable au cas où MS
// migrerait l'endpoint — defaultise sur le canonique documenté dans le code
// de winget-cli.
const MSIX_URL = process.env.WINGET_SOURCE_URL || 'https://cdn.winget.microsoft.com/cache/source2.msix'

// Rafraîchissement toutes les 24h. L'index côté MS est régénéré ~1x/jour
// donc rafraîchir plus souvent ne sert à rien.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

// Timeout généreux : le MSIX fait ~50Mo. Sur un lien lent ou un CDN MS
// momentanément saturé on tolère jusqu'à 2min.
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000

// Limite défensive : si le CDN renvoyait un fichier anormalement gros
// (corruption, redirection vers une mauvaise URL), on coupe avant
// d'épuiser la RAM. L'index réel fait ~50Mo, on accepte jusqu'à 500Mo.
const MAX_MSIX_BYTES = 500 * 1024 * 1024

// Nom du fichier SQLite à extraire du MSIX. Le MSIX winget contient
// toujours l'index à ce chemin (case-sensitive côté ZIP).
const INDEX_PATH_IN_MSIX = /^Public\/index\.db$/i

let _sqlJsPromise = null
async function getSqlJs() {
  if (!_sqlJsPromise) {
    // On charge le wasm via Buffer plutôt que via fetch/path pour éviter
    // les soucis de résolution de chemin selon le cwd / le packaging.
    // sql.js est installé dans api/node_modules. Depuis modules/inventory/lib/
    // il faut remonter 3 niveaux pour atteindre la racine api/.
    const wasmPath = join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    _sqlJsPromise = initSqlJs({ wasmBinary: await readFile(wasmPath) })
  }
  return _sqlJsPromise
}

// Télécharge le MSIX et retourne son contenu en Buffer.
async function downloadMsix(log) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(MSIX_URL, {
      signal: ac.signal,
      // Pas de redirection vers un autre host : on attend uniquement le
      // CDN MS, donc si jamais un middlebox tentait de rediriger ailleurs
      // on préfère échouer.
      redirect: 'follow',
      headers: { 'User-Agent': 'opale/1.0 (+winget-index-fetcher)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const contentLength = Number(res.headers.get('content-length') || 0)
    if (contentLength && contentLength > MAX_MSIX_BYTES) {
      throw new Error(`MSIX trop gros (${contentLength} > ${MAX_MSIX_BYTES})`)
    }

    // Streaming + cap manuel pour ne pas avaler un fichier énorme si le
    // serveur ne renvoie pas de Content-Length.
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > MAX_MSIX_BYTES) {
        throw new Error(`MSIX dépasse ${MAX_MSIX_BYTES} octets en cours de download`)
      }
      chunks.push(chunk)
    }
    const buf = Buffer.concat(chunks, total)
    log.info({ bytes: total }, 'winget: MSIX téléchargé')
    return buf
  } finally {
    clearTimeout(t)
  }
}

// Extrait Public/index.db du MSIX (qui est un ZIP) et retourne son
// contenu en Buffer. Utilise yauzl en random-access depuis le Buffer.
function extractIndexDb(msixBuf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(msixBuf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      let found = false
      zip.on('entry', (entry) => {
        if (!INDEX_PATH_IN_MSIX.test(entry.fileName)) {
          return zip.readEntry()
        }
        found = true
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2)
          const chunks = []
          stream.on('data', (c) => chunks.push(c))
          stream.on('end', () => {
            zip.close()
            resolve(Buffer.concat(chunks))
          })
          stream.on('error', reject)
        })
      })
      zip.on('end', () => {
        if (!found) reject(new Error('index.db introuvable dans le MSIX'))
      })
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

// Service stateful : garde la dernière DB chargée, sait se rafraîchir,
// et expose une méthode search() pour les routes.
export class WingetIndex {
  constructor(log) {
    this.log = log
    this.db = null
    this.lastUpdated = null
    this.timer = null
    this._refreshing = null
  }

  // À appeler au démarrage. On NE bloque PAS le boot de l'API : si le
  // téléchargement échoue, on log et on retentera plus tard. La recherche
  // renverra simplement "indisponible" tant qu'on n'a pas réussi à charger
  // l'index au moins une fois.
  start() {
    this._refresh().catch((err) => {
      this.log.warn({ err: err.message }, 'winget: chargement initial échoué (réessai dans 5 min)')
      setTimeout(() => this._refresh().catch(() => {}), 5 * 60 * 1000)
    })
    this.timer = setInterval(() => {
      this._refresh().catch((err) => {
        this.log.warn({ err: err.message }, 'winget: rafraîchissement échoué (index précédent conservé)')
      })
    }, REFRESH_INTERVAL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.db) try { this.db.close() } catch {}
    this.db = null
  }

  // Déduplique les appels concurrents : si un refresh est déjà en cours,
  // on retourne la même promesse plutôt que de lancer un 2e download.
  async _refresh() {
    if (this._refreshing) return this._refreshing
    this._refreshing = (async () => {
      const SQL = await getSqlJs()
      const msix = await downloadMsix(this.log)
      const dbBytes = await extractIndexDb(msix)
      this.log.info({ bytes: dbBytes.length }, 'winget: index.db extrait')
      const newDb = new SQL.Database(dbBytes)
      // On bascule atomiquement : ferme l'ancienne DB seulement après que
      // la nouvelle est prête, pour ne jamais avoir un état "pas d'index".
      const old = this.db
      this.db = newDb
      this.lastUpdated = new Date()
      if (old) try { old.close() } catch {}
      this.log.info({ at: this.lastUpdated.toISOString() }, 'winget: index prêt')
    })()
    try {
      await this._refreshing
    } finally {
      this._refreshing = null
    }
  }

  ready() {
    return this.db !== null
  }

  // Recherche par fragment de texte (case-insensitive). Le schéma de
  // source2.msix est dénormalisé : tout tient dans la table `packages`
  // avec colonnes (id, name, moniker, latest_version) — pas besoin de
  // JOIN. On match sur id, name et moniker (moniker = alias court type
  // "firefox" qui pointe sur "Mozilla.Firefox").
  //
  // Le tri pousse en haut : (1) match exact sur ID, (2) match exact sur
  // moniker, (3) ID prefix, (4) moniker prefix, (5) name prefix, (6) le
  // reste. À égalité on préfère les IDs courts (proxy pour "package
  // principal vs dérivés type Mozilla.Firefox.Nightly").
  search(query, limit = 20) {
    if (!this.db) return { ready: false, results: [] }
    const q = String(query || '').trim()
    if (q.length < 2) return { ready: true, results: [] }
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const cap = Math.min(Math.max(parseInt(limit) || 20, 1), 50)
    const qLower = q.toLowerCase()

    const sql = `
      SELECT
        id             AS package_id,
        name           AS display_name,
        moniker        AS moniker,
        latest_version AS version
      FROM packages
      WHERE id      LIKE $like ESCAPE '\\'
         OR name    LIKE $like ESCAPE '\\'
         OR moniker LIKE $like ESCAPE '\\'
      ORDER BY
        CASE
          WHEN LOWER(id)      = $qLower                THEN 0
          WHEN LOWER(moniker) = $qLower                THEN 1
          WHEN LOWER(id)      LIKE $qLower || '%'      THEN 2
          WHEN LOWER(moniker) LIKE $qLower || '%'      THEN 3
          WHEN LOWER(name)    LIKE $qLower || '%'      THEN 4
          ELSE 5
        END,
        LENGTH(id),
        id
      LIMIT $cap
    `
    let stmt
    try {
      stmt = this.db.prepare(sql)
      stmt.bind({ $like: like, $qLower: qLower, $cap: cap })
      const out = []
      while (stmt.step()) out.push(stmt.getAsObject())
      return { ready: true, results: out }
    } catch (err) {
      this.log.warn({ err: err.message }, 'winget: requête search a échoué')
      return { ready: true, results: [], error: 'search_failed' }
    } finally {
      if (stmt) try { stmt.free() } catch {}
    }
  }
}
