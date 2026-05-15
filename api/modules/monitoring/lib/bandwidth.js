// Bandwidth — récupère la série de débit + KPIs pour l'adapter réseau
// PRINCIPAL (celui avec le plus de trafic 7j hors pseudo-adapters).
//
// Background (cf. bug observé 2026-05-14 — pic à 9.82 Gbps sur Wireless-AC
// 9462 dont le max théorique est 1.73 Gbps) :
//
// L'agent Go remonte un row par adapter à chaque checkin (15 min). Sur un
// poste typique, c'est 4-6 rows avec des sampled_at espacés de quelques
// millisecondes. La query historique calculait correctement `ds/dr` PAR
// adapter via LAG() PARTITION BY adapter, mais retournait tous les samples
// triés par sampled_at sans filtre — du coup, dans la série mélangée,
// deux samples consécutifs d'adapters DIFFÉRENTS pouvaient être espacés
// de quelques ms. Le front calculait alors mbps = dr*8 / Δt → débit absurde
// (6 MB sur 5 ms → 9.6 Gbps).
//
// Refonte :
//   1. Filtrer les pseudo-adapters (Loopback, vEthernet WSL, VPNs, Bluetooth,
//      tunnels IPv6 hérités, etc.) via regex SQL. Ces adapters peuvent
//      générer du faux trafic massif (Loopback = toute IPC locale,
//      vEthernet WSL = jusqu'à 10 GB/s observés en pratique).
//   2. Sélectionner l'adapter PRINCIPAL : celui avec le plus de trafic
//      cumulé sur 7j hors blacklist. C'est typiquement le wifi/ethernet
//      physique.
//   3. Calculer ds/dr UNIQUEMENT pour cet adapter, et retourner
//      `secs_since_prev` (intervalle réel SQL `EXTRACT(EPOCH FROM …)`) →
//      le front consomme directement ce nombre, plus de Δt à deviner.
//   4. Exclure les checkins doublons rapprochés (`prev_sampled_at < 10s`) —
//      artefact qui gonflerait les rates.
//
// Defense-in-depth : les samples des pseudo-adapters restent stockés en DB
// (pas de migration de cleanup). Si à terme on veut un endpoint pour
// analyser le trafic Netbird/VPN spécifiquement, l'historique reste
// disponible. Le filtrage est appliqué uniquement au SELECT.

// Regex blacklist case-insensitive (opérateur Postgres `!~*`).
// Le `^` est crucial : un adapter "Loopback Pseudo-Interface" matche, mais
// pas un adapter normal qui contiendrait le mot "Bluetooth" en sub-string.
//
// À étendre si on observe un nouveau pseudo-adapter qui pollue les chiffres :
// ouvrir une PR avec la regex enrichie + un cas de test fixture.
export const PSEUDO_ADAPTER_REGEX =
  '^(Loopback|isatap|Teredo|vEthernet|Microsoft Wi-Fi Direct|Microsoft KM-TEST|' +
  'Bluetooth|TAP-Windows|TAP-Win|VirtualBox|VMware|Netbird|WireGuard|Tailscale|' +
  'ZeroTier|Hyper-V|Local Area Connection\\*|Pseudo-Interface)'

// Seuil minimal entre deux samples consécutifs pour calculer un rate. Plus
// court = artefact (re-checkin manuel ou double déclenchement) qu'on exclut.
//
// Valeur 60s : suffisamment large pour exclure les artefacts qui produiraient
// des débits irréalistes (observé en prod : pic à 2.52 Gbps sur un AX211 dont
// le max physique est 2.4 Gbps, dû à un sample isolé sur intervalle entre
// 10-30s). Sur 15 min de checkin nominal, un seuil de 60s écarte largement
// les doublons sans amputer les samples légitimes.
const MIN_INTERVAL_SECONDS = 60

// Fenêtre historique exposée au front (graphe + KPIs).
const WINDOW_DAYS = 7

/**
 * fetchBandwidth — payload bandwidth complet pour une fiche poste.
 *
 * @param {object} db   - pool pg (fastify.db)
 * @param {string} deviceId
 * @returns {Promise<{
 *   series:           Array<{ t: Date, ds: number, dr: number, secs_since_prev: number }>,
 *   summary:          null | { sent_4h, recv_4h, sent_24h, recv_24h, sent_7d, recv_7d },
 *   primary_adapter:  string | null,
 * }>}
 */
export async function fetchBandwidth(db, deviceId) {
  // 1. Identifier l'adapter principal : max(bytes_sent + bytes_recv cumulé)
  //    sur 7j hors pseudo-adapters. Si aucun, on renvoie un payload vide
  //    (le front masque le panel).
  const { rows: pa } = await db.query(`
    SELECT adapter
    FROM bandwidth_stats
    WHERE device_id = $1
      AND sampled_at > now() - interval '${WINDOW_DAYS} days'
      AND adapter !~* $2
    GROUP BY adapter
    ORDER BY SUM(COALESCE(bytes_sent, 0) + COALESCE(bytes_recv, 0)) DESC NULLS LAST
    LIMIT 1
  `, [deviceId, PSEUDO_ADAPTER_REGEX])

  if (!pa.length) {
    return { series: [], summary: null, primary_adapter: null }
  }
  const adapter = pa[0].adapter

  // 2. Série + KPIs basés sur cet unique adapter, avec intervalle explicite
  //    (`secs_since_prev`) calculé SQL.
  const [seriesRes, summaryRes] = await Promise.all([
    db.query(`
      WITH ordered AS (
        SELECT sampled_at, bytes_sent, bytes_recv,
               LAG(bytes_sent) OVER w AS prev_sent,
               LAG(bytes_recv) OVER w AS prev_recv,
               LAG(sampled_at) OVER w AS prev_sampled_at
        FROM bandwidth_stats
        WHERE device_id = $1 AND adapter = $2
          AND sampled_at > now() - interval '${WINDOW_DAYS} days'
        WINDOW w AS (ORDER BY sampled_at)
      )
      SELECT sampled_at,
             CASE WHEN bytes_sent >= prev_sent THEN bytes_sent - prev_sent ELSE 0 END AS ds,
             CASE WHEN bytes_recv >= prev_recv THEN bytes_recv - prev_recv ELSE 0 END AS dr,
             EXTRACT(EPOCH FROM (sampled_at - prev_sampled_at)) AS secs_since_prev
      FROM ordered
      WHERE prev_sent IS NOT NULL
        AND prev_sampled_at IS NOT NULL
        AND sampled_at - prev_sampled_at >= interval '${MIN_INTERVAL_SECONDS} seconds'
      ORDER BY sampled_at ASC
    `, [deviceId, adapter]),
    db.query(`
      WITH ordered AS (
        SELECT sampled_at, bytes_sent, bytes_recv,
               LAG(bytes_sent) OVER w AS prev_sent,
               LAG(bytes_recv) OVER w AS prev_recv,
               LAG(sampled_at) OVER w AS prev_sampled_at
        FROM bandwidth_stats
        WHERE device_id = $1 AND adapter = $2
          AND sampled_at > now() - interval '${WINDOW_DAYS} days'
        WINDOW w AS (ORDER BY sampled_at)
      ),
      deltas AS (
        SELECT sampled_at,
               CASE WHEN bytes_sent >= prev_sent THEN bytes_sent - prev_sent ELSE 0 END AS ds,
               CASE WHEN bytes_recv >= prev_recv THEN bytes_recv - prev_recv ELSE 0 END AS dr
        FROM ordered
        WHERE prev_sent IS NOT NULL
          AND prev_sampled_at IS NOT NULL
          AND sampled_at - prev_sampled_at >= interval '${MIN_INTERVAL_SECONDS} seconds'
      )
      SELECT
        SUM(CASE WHEN sampled_at > now() - interval '4 hours'  THEN ds ELSE 0 END)::bigint AS sent_4h,
        SUM(CASE WHEN sampled_at > now() - interval '4 hours'  THEN dr ELSE 0 END)::bigint AS recv_4h,
        SUM(CASE WHEN sampled_at > now() - interval '24 hours' THEN ds ELSE 0 END)::bigint AS sent_24h,
        SUM(CASE WHEN sampled_at > now() - interval '24 hours' THEN dr ELSE 0 END)::bigint AS recv_24h,
        SUM(ds)::bigint AS sent_7d,
        SUM(dr)::bigint AS recv_7d
      FROM deltas
    `, [deviceId, adapter]),
  ])

  return {
    series: seriesRes.rows.map(r => ({
      t:                r.sampled_at,
      ds:               Number(r.ds),
      dr:               Number(r.dr),
      secs_since_prev:  Number(r.secs_since_prev),
    })),
    summary: summaryRes.rows[0] || null,
    primary_adapter: adapter,
  }
}

// Fenêtres valides pour /api/network/top — whitelist défensive (jamais
// concaténer un input user dans le SQL).
const TOP_PERIODS = { '4h': '4 hours', '24h': '24 hours', '7d': '7 days' }
const TOP_SORTS   = { total: 'total_bytes', sent: 'sent_bytes', recv: 'recv_bytes' }

// Secondes par période — utilisé pour calculer le bucket size de la
// sparkline (period / SPARKLINE_BUCKETS).
const PERIOD_SECONDS = {
  '4h':       4 * 3600,
  '24h':     24 * 3600,
  '7d':  7 * 24 * 3600,
}

// Nombre de buckets dans la sparkline — équilibre lisibilité (assez de
// points pour voir l'allure générale) et taille du payload JSON
// (24 * 100 devices * float ≈ 100 KB max).
const SPARKLINE_BUCKETS = 24

const MAX_LIMIT = 100
// Sanity cap sur le pic affiché côté UI /reseau. 5 Gbps couvre largement
// le 10 GbE en pratique (peu de NIC saturent 5 Gbps soutenu sur un single
// flow), et bloque les artefacts physiquement impossibles (ex: 9.82 Gbps
// observé sur wifi AC qui a un max théorique de 1.73 Gbps).
//
// La constante de `bytesToMbps()` (cap 10 Gbps) reste plus permissive
// pour ne pas amputer les chiffres d'une fiche poste éventuellement
// branchée en 10 GbE ; ici c'est un cap d'affichage du PEAK, signal
// dérivé sensible aux outliers.
const MAX_PEAK_MBPS = 5_000

/**
 * fetchTopBandwidth — Top N postes consommateurs sur une période donnée,
 * réutilise la même logique d'adapter principal que fetchBandwidth (filtre
 * pseudo-adapters → max trafic cumulé) appliquée à TOUS les postes en une
 * seule query SQL (pas de N+1 sur 112 postes).
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.period - '4h' | '24h' | '7d' (default '24h')
 * @param {string} opts.sort   - 'total' | 'sent' | 'recv' (default 'total')
 * @param {number} opts.limit  - 1..100 (default 20)
 * @returns {Promise<Array<{
 *   device_id, hostname, adapter, user_name, user_entra_id,
 *   sent_bytes, recv_bytes, total_bytes, peak_mbps,
 *   online: boolean, last_seen,
 * }>>}
 */
export async function fetchTopBandwidth(db, { period = '24h', sort = 'total', limit = 20 } = {}) {
  const pgInterval = TOP_PERIODS[period] || TOP_PERIODS['24h']
  const orderCol   = TOP_SORTS[sort]     || TOP_SORTS.total
  const lim        = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_LIMIT)

  // Une seule query avec CTEs imbriquées :
  //   filtered          : samples dans la fenêtre, hors blacklist
  //   adapter_totals    : SUM par (device, adapter)
  //   primary_adapter   : DISTINCT ON pick le top adapter par device
  //   deltas            : LAG sur l'adapter principal uniquement
  //   rates             : ds, dr, secs (defensive contre reset & doublons)
  //   aggregated        : SUM + MAX(mbps) par device
  //   final SELECT      : join devices + users_cache + ORDER BY + LIMIT
  //
  // ORDER BY $orderCol via injection contrôlée (whitelist `TOP_SORTS`).
  // LIMIT via injection contrôlée (parseInt + clamp).
  const { rows } = await db.query(`
    WITH filtered AS (
      SELECT device_id, adapter, sampled_at,
             COALESCE(bytes_sent, 0)::bigint AS bytes_sent,
             COALESCE(bytes_recv, 0)::bigint AS bytes_recv
      FROM bandwidth_stats
      WHERE sampled_at > now() - $1::interval
        AND adapter !~* $2
    ),
    adapter_totals AS (
      SELECT device_id, adapter,
             SUM(bytes_sent + bytes_recv) AS total_bytes
      FROM filtered
      GROUP BY device_id, adapter
    ),
    primary_adapter AS (
      SELECT DISTINCT ON (device_id) device_id, adapter
      FROM adapter_totals
      ORDER BY device_id, total_bytes DESC NULLS LAST
    ),
    deltas AS (
      SELECT f.device_id, f.adapter, f.sampled_at, f.bytes_sent, f.bytes_recv,
             LAG(f.bytes_sent)  OVER w AS prev_sent,
             LAG(f.bytes_recv)  OVER w AS prev_recv,
             LAG(f.sampled_at)  OVER w AS prev_at
      FROM filtered f
      JOIN primary_adapter pa ON pa.device_id = f.device_id AND pa.adapter = f.adapter
      WINDOW w AS (PARTITION BY f.device_id ORDER BY f.sampled_at)
    ),
    rates AS (
      SELECT device_id, adapter, sampled_at,
             CASE WHEN bytes_sent >= prev_sent THEN bytes_sent - prev_sent ELSE 0 END AS ds,
             CASE WHEN bytes_recv >= prev_recv THEN bytes_recv - prev_recv ELSE 0 END AS dr,
             EXTRACT(EPOCH FROM (sampled_at - prev_at)) AS secs
      FROM deltas
      WHERE prev_sent IS NOT NULL
        AND prev_at IS NOT NULL
        AND sampled_at - prev_at >= interval '${MIN_INTERVAL_SECONDS} seconds'
    ),
    aggregated AS (
      SELECT device_id, adapter,
             SUM(ds)::bigint                                                AS sent_bytes,
             SUM(dr)::bigint                                                AS recv_bytes,
             (SUM(ds) + SUM(dr))::bigint                                    AS total_bytes,
             COALESCE(
               MAX( ((ds + dr)::numeric * 8) / NULLIF(secs * 1000000, 0) ),
             0)::float                                                       AS peak_mbps
      FROM rates
      WHERE secs > 0
      GROUP BY device_id, adapter
    )
    SELECT a.device_id, a.adapter,
           a.sent_bytes, a.recv_bytes, a.total_bytes, a.peak_mbps,
           d.hostname, d.last_seen,
           uc.entra_id    AS user_entra_id,
           uc.display_name AS user_name
    FROM aggregated a
    JOIN devices d        ON d.id = a.device_id
    LEFT JOIN users_cache uc ON uc.entra_id = d.assigned_user_id
    ORDER BY a.${orderCol} DESC NULLS LAST
    LIMIT ${lim}
  `, [pgInterval, PSEUDO_ADAPTER_REGEX])

  if (rows.length === 0) return []

  const deviceIds = rows.map(r => r.device_id)

  // Queries auxiliaires en parallèle :
  //   (B) sparkline = série bucketisée Mbps pour les TOP devices uniquement
  //   (C) previous  = total cumulé sur la fenêtre IMMÉDIATEMENT PRÉCÉDENTE
  //                   (pour le delta_pct ↑↓). Skip silencieux si on n'a pas
  //                   d'historique remontant assez loin (cas typique : 7d
  //                   period × retention bandwidth_stats 7j → prev fenêtre
  //                   vide).
  const periodSeconds = PERIOD_SECONDS[period] || PERIOD_SECONDS['24h']
  const bucketSeconds = periodSeconds / SPARKLINE_BUCKETS

  const [sparkRes, prevRes] = await Promise.all([
    db.query(`
      WITH filtered AS (
        SELECT device_id, adapter, sampled_at,
               COALESCE(bytes_sent, 0)::bigint AS bytes_sent,
               COALESCE(bytes_recv, 0)::bigint AS bytes_recv
        FROM bandwidth_stats
        WHERE sampled_at > now() - $1::interval
          AND adapter !~* $2
          AND device_id = ANY($3::uuid[])
      ),
      adapter_totals AS (
        SELECT device_id, adapter,
               SUM(bytes_sent + bytes_recv) AS total_bytes
        FROM filtered
        GROUP BY device_id, adapter
      ),
      primary_adapter AS (
        SELECT DISTINCT ON (device_id) device_id, adapter
        FROM adapter_totals
        ORDER BY device_id, total_bytes DESC NULLS LAST
      ),
      deltas AS (
        SELECT f.device_id, f.sampled_at, f.bytes_sent, f.bytes_recv,
               LAG(f.bytes_sent) OVER w AS prev_sent,
               LAG(f.bytes_recv) OVER w AS prev_recv,
               LAG(f.sampled_at) OVER w AS prev_at
        FROM filtered f
        JOIN primary_adapter pa ON pa.device_id = f.device_id AND pa.adapter = f.adapter
        WINDOW w AS (PARTITION BY f.device_id ORDER BY f.sampled_at)
      ),
      rates AS (
        SELECT device_id, sampled_at,
               CASE WHEN bytes_sent >= prev_sent THEN bytes_sent - prev_sent ELSE 0 END AS ds,
               CASE WHEN bytes_recv >= prev_recv THEN bytes_recv - prev_recv ELSE 0 END AS dr,
               EXTRACT(EPOCH FROM (sampled_at - prev_at)) AS secs
        FROM deltas
        WHERE prev_sent IS NOT NULL
          AND prev_at IS NOT NULL
          AND sampled_at - prev_at >= interval '${MIN_INTERVAL_SECONDS} seconds'
      ),
      bucketed AS (
        SELECT device_id,
               FLOOR(
                 EXTRACT(EPOCH FROM (sampled_at - (now() - $1::interval)))
                 / $4::numeric
               )::int AS bucket,
               AVG((ds + dr)::numeric * 8 / NULLIF(secs * 1000000, 0))::float AS mbps
        FROM rates
        WHERE secs > 0
        GROUP BY device_id, bucket
      )
      SELECT device_id, array_agg(mbps ORDER BY bucket) AS series_mbps
      FROM bucketed
      GROUP BY device_id
    `, [pgInterval, PSEUDO_ADAPTER_REGEX, deviceIds, bucketSeconds]),

    // Previous period — total simple sur fenêtre [now - 2P, now - P].
    // Simplification : on somme TOUS les adapters non-pseudo (pas de
    // primary_adapter ici). L'erreur de double-comptage si plusieurs
    // adapters sont utilisés simultanément reste consistent entre current
    // et prev → la TENDANCE reste juste, c'est juste la valeur absolue
    // prev qui peut être légèrement sur-estimée. Acceptable pour XS.
    db.query(`
      WITH filtered AS (
        SELECT device_id, bytes_sent, bytes_recv,
               LAG(bytes_sent) OVER w AS prev_sent,
               LAG(bytes_recv) OVER w AS prev_recv
        FROM bandwidth_stats
        WHERE sampled_at > now() - ($1::interval * 2)
          AND sampled_at <= now() - $1::interval
          AND adapter !~* $2
          AND device_id = ANY($3::uuid[])
        WINDOW w AS (PARTITION BY device_id, adapter ORDER BY sampled_at)
      )
      SELECT device_id,
             SUM(
               CASE WHEN bytes_sent >= prev_sent THEN bytes_sent - prev_sent ELSE 0 END
               + CASE WHEN bytes_recv >= prev_recv THEN bytes_recv - prev_recv ELSE 0 END
             )::bigint AS prev_total_bytes
      FROM filtered
      WHERE prev_sent IS NOT NULL
      GROUP BY device_id
    `, [pgInterval, PSEUDO_ADAPTER_REGEX, deviceIds]),
  ])

  const seriesByDev = new Map(sparkRes.rows.map(r => [r.device_id, (r.series_mbps || []).map(Number)]))
  const prevByDev   = new Map(prevRes.rows.map(r => [r.device_id, Number(r.prev_total_bytes)]))

  const onlineThresholdMs = 60 * 60 * 1000  // = 1 h, cohérent avec computeStatus
  return rows.map(r => {
    const curTotal  = Number(r.total_bytes)
    const prevTotal = prevByDev.get(r.device_id)
    // trend = null si pas de donnée prev ou prev=0 (évite division par 0
    // qui produirait Infinity/NaN dans le JSON et casserait le rendu).
    let trend = null
    if (prevTotal !== undefined && prevTotal > 0) {
      trend = {
        prev_total_bytes: prevTotal,
        delta_pct: ((curTotal - prevTotal) / prevTotal) * 100,
      }
    }
    return {
      device_id:     r.device_id,
      hostname:      r.hostname,
      adapter:       r.adapter,
      user_name:     r.user_name,
      user_entra_id: r.user_entra_id,
      sent_bytes:    Number(r.sent_bytes),
      recv_bytes:    Number(r.recv_bytes),
      total_bytes:   curTotal,
      peak_mbps:     r.peak_mbps != null ? Math.min(Number(r.peak_mbps), MAX_PEAK_MBPS) : 0,
      online:        !!r.last_seen && (Date.now() - new Date(r.last_seen).getTime()) <= onlineThresholdMs,
      last_seen:     r.last_seen,
      series_mbps:   seriesByDev.get(r.device_id) || [],
      trend,
    }
  })
}

// Whitelists exposées pour validation côté route (params query).
export const TOP_BANDWIDTH_PERIODS = Object.keys(TOP_PERIODS)
export const TOP_BANDWIDTH_SORTS   = Object.keys(TOP_SORTS)

/**
 * Conversion bytes → Mbps. Pure function, testable sans DB.
 * Exposé pour les tests + un éventuel usage frontend (déduplication).
 *
 * @param {number} bytes
 * @param {number} secs   intervalle réel ; si ≤ 0, retourne 0 (defensive)
 * @param {number} cap    plafond Mbps ; au-dessus → 0 (compteur reset)
 */
export function bytesToMbps(bytes, secs, cap = 10_000) {
  if (!secs || secs <= 0) return 0
  if (!bytes || bytes < 0) return 0
  const mbps = (Number(bytes) * 8) / (secs * 1_000_000)
  return mbps > cap ? 0 : mbps
}
