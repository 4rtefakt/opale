// Tests api/lib/bandwidth.js — couvre :
//   - bytesToMbps (pure, edge cases)
//   - PSEUDO_ADAPTER_REGEX (translation Postgres `!~*` → RegExp JS)
//   - fetchBandwidth contre un vrai PG via acquireSchema()
//
// Les tests d'intégration valident le SQL réel : LAG() PARTITION,
// EXTRACT(EPOCH FROM ...), opérateur regex `!~*`, exclusion des doublons
// rapprochés. Si PG_TEST_URL n'est pas défini, les tests SQL skip
// proprement (les tests purs restent).
//
// Cf. helpers/db.js pour le pattern acquireSchema().

import { test }       from 'node:test'
import assert         from 'node:assert/strict'
import { acquireSchema, isDbAvailable, closeSharedPool } from '../helpers/db.js'

import {
  bytesToMbps,
  PSEUDO_ADAPTER_REGEX,
  fetchBandwidth,
  fetchTopBandwidth,
} from '../../modules/monitoring/lib/bandwidth.js'

// ─── bytesToMbps ─────────────────────────────────────────────────────────────

test('bytesToMbps — nominal 15 min / 1.8 MB', () => {
  // 1.8 MB en 900 s = 16 kbps ≈ 0.016 Mbps
  assert.equal(Math.round(bytesToMbps(1_800_000, 900) * 1000) / 1000, 0.016)
})

test('bytesToMbps — 100 Mbps cohérent', () => {
  // 100 Mbps × 1 s = 12.5 MB
  assert.equal(bytesToMbps(12_500_000, 1), 100)
})

test('bytesToMbps — edge cases retournent 0', () => {
  assert.equal(bytesToMbps(1_000_000, 0),         0, 'secs == 0')
  assert.equal(bytesToMbps(1_000_000, -1),        0, 'secs < 0')
  assert.equal(bytesToMbps(1_000_000, undefined), 0, 'secs undefined')
  assert.equal(bytesToMbps(0,         900),       0, 'bytes == 0')
  assert.equal(bytesToMbps(-1,        900),       0, 'bytes < 0')
})

test('bytesToMbps — cap par défaut 10 Gbps', () => {
  // dr = 2 GB sur 1 s = 16 Gbps → au-dessus du cap → 0
  assert.equal(bytesToMbps(2_000_000_000, 1), 0)
  // Juste sous le cap (9 Gbps = 9000 Mbps) → passe
  assert.equal(bytesToMbps(1_125_000_000, 1), 9000)
})

test('bytesToMbps — cap custom', () => {
  assert.equal(bytesToMbps(12_500_000, 1, 50),  0,   '100 Mbps > cap 50')
  assert.equal(bytesToMbps(12_500_000, 1, 200), 100, '100 Mbps < cap 200')
})

test('bytesToMbps — accept string (node-pg BIGINT)', () => {
  // node-pg sérialise les BIGINT en string par défaut.
  assert.equal(Math.round(bytesToMbps('1800000', 900) * 1000) / 1000, 0.016)
})

// ─── PSEUDO_ADAPTER_REGEX (translation JS) ───────────────────────────────────

const pseudoRe = new RegExp(PSEUDO_ADAPTER_REGEX, 'i')

test('regex — matche les pseudo-adapters connus', () => {
  for (const name of [
    'Loopback Pseudo-Interface 1',
    'loopback',                     // case-insensitive
    'vEthernet (WSL)',
    'vEthernet (Default Switch)',
    'isatap.{12345678-...}',
    'Teredo Tunneling Pseudo-Interface',
    'Netbird',
    'WireGuard Tunnel',
    'Tailscale',
    'ZeroTier One',
    'TAP-Windows Adapter V9',
    'TAP-Win32 Adapter',
    'Bluetooth Device (PAN)',
    'Microsoft Wi-Fi Direct Virtual Adapter',
    'VirtualBox Host-Only Ethernet Adapter',
    'VMware Virtual Ethernet Adapter for VMnet1',
    'Hyper-V Virtual Switch',
  ]) {
    assert.match(name, pseudoRe, `${name} doit matcher`)
  }
})

test('regex — ne matche PAS un adapter wifi/eth physique', () => {
  for (const name of [
    'Intel(R) Wireless-AC 9462',
    'Realtek PCIe GbE Family Controller',
    'Wi-Fi',
    'Ethernet',
    'Intel(R) Ethernet Connection (4) I219-LM',
  ]) {
    assert.doesNotMatch(name, pseudoRe, `${name} doit NE PAS matcher`)
  }
})

test('regex — ancrage ^ empêche les sub-string trompeurs', () => {
  // Un adapter custom "MonReseau-Bluetooth-Backup" ne doit pas matcher
  // parce que "Bluetooth" n'est pas en début de chaîne.
  assert.doesNotMatch('MonReseau-Bluetooth-Backup', pseudoRe)
})

// ─── fetchBandwidth contre un vrai PG ────────────────────────────────────────
//
// Les tests qui suivent valident le SQL réel : exclusion regex
// `!~*`, LAG() PARTITION, EXTRACT(EPOCH FROM ...), seuil 10s entre samples.
// Skip propre si PG_TEST_URL absent.

const HOSTNAME = 'TEST-DEV'

async function seedDevice(db) {
  const { rows } = await db.query(
    `INSERT INTO devices (hostname) VALUES ($1) RETURNING id`,
    [HOSTNAME]
  )
  return rows[0].id
}

async function seedBandwidth(db, deviceId, rows) {
  // rows = [{ adapter, bytes_sent, bytes_recv, sampled_at }]
  for (const r of rows) {
    await db.query(
      `INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, r.adapter, r.bytes_sent, r.bytes_recv, r.sampled_at]
    )
  }
}

test('fetchBandwidth — pas de samples → payload vide', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const got = await fetchBandwidth(db, deviceId)
  assert.deepEqual(got, { series: [], summary: null, primary_adapter: null })
})

test('fetchBandwidth — pseudo-adapters seuls → payload vide (filtrage SQL)', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const t0 = new Date('2026-05-13T10:00:00Z')
  const t1 = new Date('2026-05-13T10:15:00Z')
  await seedBandwidth(db, deviceId, [
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 0,       bytes_recv: 0,       sampled_at: t0 },
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 1_000_000, bytes_recv: 1_000_000, sampled_at: t1 },
    { adapter: 'vEthernet (WSL)',             bytes_sent: 0,       bytes_recv: 0,       sampled_at: t0 },
    { adapter: 'vEthernet (WSL)',             bytes_sent: 5_000_000_000, bytes_recv: 5_000_000_000, sampled_at: t1 },
  ])

  const got = await fetchBandwidth(db, deviceId)
  // Tous les adapters sont blacklist → primary_adapter null
  assert.equal(got.primary_adapter, null)
  assert.equal(got.series.length, 0)
})

test('fetchBandwidth — sélectionne l\'adapter PHYSIQUE entre wifi + Netbird + Loopback', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const tA = new Date('2026-05-13T10:00:00Z')
  const tB = new Date('2026-05-13T10:15:00Z')
  await seedBandwidth(db, deviceId, [
    // Wifi : 100 MB cumulé → après filtre c'est l'adapter principal
    { adapter: 'Intel(R) Wireless-AC 9462', bytes_sent: 0,           bytes_recv: 0,           sampled_at: tA },
    { adapter: 'Intel(R) Wireless-AC 9462', bytes_sent: 50_000_000,  bytes_recv: 50_000_000,  sampled_at: tB },
    // Netbird : 1 GB cumulé MAIS dans la blacklist → ignoré
    { adapter: 'Netbird',                   bytes_sent: 0,           bytes_recv: 0,           sampled_at: tA },
    { adapter: 'Netbird',                   bytes_sent: 500_000_000, bytes_recv: 500_000_000, sampled_at: tB },
    // Loopback : 10 GB cumulé MAIS blacklist
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 0, bytes_recv: 0, sampled_at: tA },
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 5_000_000_000, bytes_recv: 5_000_000_000, sampled_at: tB },
  ])

  const got = await fetchBandwidth(db, deviceId)
  assert.equal(got.primary_adapter, 'Intel(R) Wireless-AC 9462')
})

test('fetchBandwidth — calcule ds/dr/secs_since_prev sur l\'adapter unique', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const tA = new Date('2026-05-13T10:00:00Z')
  const tB = new Date('2026-05-13T10:15:00Z') // +15 min = 900 s
  await seedBandwidth(db, deviceId, [
    { adapter: 'Wi-Fi', bytes_sent: 100_000_000, bytes_recv: 200_000_000, sampled_at: tA },
    { adapter: 'Wi-Fi', bytes_sent: 110_000_000, bytes_recv: 230_000_000, sampled_at: tB },
  ])

  const got = await fetchBandwidth(db, deviceId)
  assert.equal(got.series.length, 1, 'un seul delta calculable')
  const p = got.series[0]
  assert.equal(p.ds, 10_000_000,  'delta sent = 10 MB')
  assert.equal(p.dr, 30_000_000,  'delta recv = 30 MB')
  assert.equal(p.secs_since_prev, 900, 'intervalle = 900 s')
})

test('fetchBandwidth — exclut les doublons rapprochés (< 60s)', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  // 3 samples : T, T+30s (doublon proche), T+15min. Le doublon doit être
  // exclu de la série finale (seuil MIN_INTERVAL_SECONDS = 60s) → un seul
  // delta calculable. Le delta tDup → tB n'est PAS exclu lui-même
  // (Δ = 14:30 min > 60s) mais part d'un sample qui restera dans le
  // tableau final via LAG. C'est intentionnel : le bug visé est le pic
  // calculé sur intervalle court, pas l'exclusion du delta legitimate.
  const tA = new Date('2026-05-13T10:00:00Z')
  const tDup = new Date('2026-05-13T10:00:30Z')
  const tB = new Date('2026-05-13T10:15:00Z')
  await seedBandwidth(db, deviceId, [
    { adapter: 'Wi-Fi', bytes_sent: 100_000_000, bytes_recv: 200_000_000, sampled_at: tA },
    { adapter: 'Wi-Fi', bytes_sent: 100_001_000, bytes_recv: 200_001_000, sampled_at: tDup },
    { adapter: 'Wi-Fi', bytes_sent: 110_000_000, bytes_recv: 230_000_000, sampled_at: tB },
  ])

  const got = await fetchBandwidth(db, deviceId)
  // Deltas WHERE prev_at != null AND sampled_at - prev_at >= 60s :
  //   - tA          : prev_at NULL → exclu
  //   - tDup        : tDup - tA  = 30s < 60s → exclu
  //   - tB          : tB - tDup = 14:30 > 60s → INCLUS, delta basé sur tDup
  // → 1 row dans la série finale, intervalle ≈ 14:30 min = 870 s
  assert.equal(got.series.length, 1)
  assert.equal(got.series[0].secs_since_prev, 14 * 60 + 30, 'intervalle tDup → tB')
})

test('fetchBandwidth — reset compteur (delta négatif) → ds/dr = 0', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  // Reboot Windows → compteur perfMon repart à 0.
  // bytes_sent_now (5 MB depuis boot) < prev (100 MB) → CASE WHEN >= → 0
  const tA = new Date('2026-05-13T10:00:00Z')
  const tB = new Date('2026-05-13T10:15:00Z')
  await seedBandwidth(db, deviceId, [
    { adapter: 'Wi-Fi', bytes_sent: 100_000_000, bytes_recv: 200_000_000, sampled_at: tA },
    { adapter: 'Wi-Fi', bytes_sent: 5_000_000,   bytes_recv: 8_000_000,   sampled_at: tB },
  ])

  const got = await fetchBandwidth(db, deviceId)
  assert.equal(got.series.length, 1)
  assert.equal(got.series[0].ds, 0, 'delta négatif sent → 0')
  assert.equal(got.series[0].dr, 0, 'delta négatif recv → 0')
})

test('fetchBandwidth — summary 4h/24h/7j cumule sur l\'adapter principal uniquement', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const now  = new Date()
  const t30  = new Date(now.getTime() - 30  * 60 * 1000) // -30 min (dans 4h)
  const t15  = new Date(now.getTime() - 15  * 60 * 1000) // -15 min (dans 4h)

  await seedBandwidth(db, deviceId, [
    // Wifi : delta 10 MB sent / 30 MB recv dans les 4h
    { adapter: 'Wi-Fi', bytes_sent: 100_000_000, bytes_recv: 200_000_000, sampled_at: t30 },
    { adapter: 'Wi-Fi', bytes_sent: 110_000_000, bytes_recv: 230_000_000, sampled_at: t15 },
    // Loopback : 100 MB de delta sur la même période — DOIT être ignoré
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 0,           bytes_recv: 0,           sampled_at: t30 },
    { adapter: 'Loopback Pseudo-Interface 1', bytes_sent: 100_000_000, bytes_recv: 100_000_000, sampled_at: t15 },
  ])

  const got = await fetchBandwidth(db, deviceId)
  // summary basé sur l'adapter Wi-Fi uniquement
  assert.equal(Number(got.summary.sent_4h), 10_000_000,  'sent_4h ne compte que le wifi')
  assert.equal(Number(got.summary.recv_4h), 30_000_000,  'recv_4h ne compte que le wifi')
})

test('fetchBandwidth — wifi + ethernet : pick celui qui a le plus de trafic', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const deviceId = await seedDevice(db)
  const tA = new Date('2026-05-13T10:00:00Z')
  const tB = new Date('2026-05-13T10:15:00Z')
  await seedBandwidth(db, deviceId, [
    { adapter: 'Wi-Fi',    bytes_sent: 0,            bytes_recv: 0,            sampled_at: tA },
    { adapter: 'Wi-Fi',    bytes_sent: 10_000_000,   bytes_recv: 10_000_000,   sampled_at: tB },
    { adapter: 'Ethernet', bytes_sent: 0,            bytes_recv: 0,            sampled_at: tA },
    { adapter: 'Ethernet', bytes_sent: 1_000_000_000, bytes_recv: 1_000_000_000, sampled_at: tB },
  ])

  const got = await fetchBandwidth(db, deviceId)
  // Ethernet a 1 GB cumulé vs 10 MB pour wifi → Ethernet principal
  assert.equal(got.primary_adapter, 'Ethernet')
})

// ─── fetchTopBandwidth ───────────────────────────────────────────────────────

test('fetchTopBandwidth — pas de samples → tableau vide', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.deepEqual(got, [])
})

test('fetchTopBandwidth — Loopback only → exclu, tableau vide', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('DEV-1') RETURNING id`)
  const deviceId = rows[0].id
  const tA = new Date(Date.now() - 30 * 60 * 1000)
  const tB = new Date(Date.now() - 15 * 60 * 1000)
  for (const t of [tA, tB]) {
    await db.query(
      `INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at)
       VALUES ($1, 'Loopback Pseudo-Interface 1', $2, $2, $3)`,
      [deviceId, t === tA ? 0 : 1_000_000_000, t]
    )
  }
  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.equal(got.length, 0)
})

test('fetchTopBandwidth — wifi + loopback : wifi seul dans le top', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('DEV-A') RETURNING id`)
  const deviceId = rows[0].id
  const tA = new Date(Date.now() - 30 * 60 * 1000)
  const tB = new Date(Date.now() - 15 * 60 * 1000)

  // Wifi : 30 MB sent + 70 MB recv = 100 MB total
  await db.query(
    `INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
     ($1, 'Wi-Fi', 0,              0,              $2),
     ($1, 'Wi-Fi', 30000000,       70000000,       $3)`,
    [deviceId, tA, tB]
  )
  // Loopback : 10 GB de trafic mais blacklist
  await db.query(
    `INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
     ($1, 'Loopback Pseudo-Interface 1', 0,            0,            $2),
     ($1, 'Loopback Pseudo-Interface 1', 10000000000,  10000000000,  $3)`,
    [deviceId, tA, tB]
  )

  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.equal(got.length, 1)
  assert.equal(got[0].hostname, 'DEV-A')
  assert.equal(got[0].adapter,  'Wi-Fi')
  assert.equal(got[0].sent_bytes, 30_000_000, 'somme wifi seul')
  assert.equal(got[0].recv_bytes, 70_000_000)
  assert.equal(got[0].total_bytes, 100_000_000)
})

test('fetchTopBandwidth — sort by total / sent / recv produit des ordres différents', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  // Device A : beaucoup envoyé, peu reçu
  // Device B : beaucoup reçu, peu envoyé
  // Device C : ni l'un ni l'autre — milieu
  const { rows: rA } = await db.query(`INSERT INTO devices (hostname) VALUES ('A') RETURNING id`)
  const { rows: rB } = await db.query(`INSERT INTO devices (hostname) VALUES ('B') RETURNING id`)
  const { rows: rC } = await db.query(`INSERT INTO devices (hostname) VALUES ('C') RETURNING id`)

  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(Date.now() - 15 * 60 * 1000)
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,           0,           $4),
      ($1, 'Wi-Fi', 900000000,   100000000,   $5),
      ($2, 'Wi-Fi', 0,           0,           $4),
      ($2, 'Wi-Fi', 100000000,   900000000,   $5),
      ($3, 'Wi-Fi', 0,           0,           $4),
      ($3, 'Wi-Fi', 500000000,   500000000,   $5)
  `, [rA[0].id, rB[0].id, rC[0].id, t0, t1])

  const byTotal = await fetchTopBandwidth(db, { sort: 'total', limit: 3 })
  const bySent  = await fetchTopBandwidth(db, { sort: 'sent',  limit: 3 })
  const byRecv  = await fetchTopBandwidth(db, { sort: 'recv',  limit: 3 })

  // Tous les 3 ont total = 1 GB → ordre dépend du tie-breaker (device_id), mais
  // tous doivent figurer dans byTotal
  assert.equal(byTotal.length, 3)
  // sent : A en premier (900 MB)
  assert.equal(bySent[0].hostname, 'A')
  // recv : B en premier (900 MB)
  assert.equal(byRecv[0].hostname, 'B')
})

test('fetchTopBandwidth — limit clampe à 100 et respecte la valeur', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  // Crée 5 devices avec wifi 1 GB chacun
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(Date.now() - 15 * 60 * 1000)
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ($1) RETURNING id`, [`D${i}`])
    await db.query(`
      INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
        ($1, 'Wi-Fi', 0,         0,         $2),
        ($1, 'Wi-Fi', 500000000, 500000000, $3)
    `, [rows[0].id, t0, t1])
  }
  const limit3 = await fetchTopBandwidth(db, { limit: 3 })
  assert.equal(limit3.length, 3)
  const limit200 = await fetchTopBandwidth(db, { limit: 200 })
  // 200 dépasse le max 100, mais on n'a que 5 devices → tous remontent
  assert.equal(limit200.length, 5)
})

test('fetchTopBandwidth — peak_mbps calculé sur les samples valides', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('PEAK') RETURNING id`)
  const deviceId = rows[0].id
  // 3 samples espacés de 5 min — tous au-dessus du seuil 60s.
  //   t0 → t1 : 0+0 → 50M+50M = 100 MB en 300 s = 2.67 Mbps
  //   t1 → t2 : 50M+50M → 150M+150M = 200 MB en 300 s = 5.33 Mbps
  // Peak = 5.33 Mbps (le delta t1→t2).
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(t0.getTime() +  5 * 60 * 1000)
  const t2 = new Date(t0.getTime() + 10 * 60 * 1000)
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,           0,           $2),
      ($1, 'Wi-Fi', 50000000,    50000000,    $3),
      ($1, 'Wi-Fi', 150000000,   150000000,   $4)
  `, [deviceId, t0, t1, t2])

  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.equal(got.length, 1)
  // Le pic doit être autour de 5.33 Mbps.
  assert(got[0].peak_mbps > 4 && got[0].peak_mbps < 7,
    `peak_mbps = ${got[0].peak_mbps}, attendu ≈ 5.33`)
})

test('fetchTopBandwidth — peak_mbps cappé à 5 Gbps (sanity sur outliers)', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('OUTLIER') RETURNING id`)
  const deviceId = rows[0].id
  // Crée un sample artificiel qui donnerait un débit absurde si pas capé :
  // 5 GB en 60 s = 666 Mbps × 8/1e6 ≈ 666 Mbps. Faisable. Mais 50 GB en 60s
  // = 6.66 Gbps → au-dessus du cap MAX_PEAK_MBPS=5000 → clampé à 5000.
  // Le delta entre 2 samples qui passe le seuil 60s.
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(t0.getTime() + 5 * 60 * 1000)   // +5 min : delta 100 MB → ~2.6 Mbps (normal)
  const t2 = new Date(t1.getTime() + 60 * 1000)        // +60 s : delta 50 GB → 6.66 Gbps clampé
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,             0,             $2),
      ($1, 'Wi-Fi', 50000000,      50000000,      $3),
      ($1, 'Wi-Fi', 50050000000,   50050000000,   $4)
  `, [deviceId, t0, t1, t2])

  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.equal(got.length, 1)
  // Cap = 5000 Mbps. Le sample t1→t2 produit 6+ Gbps brut, doit être clampé.
  assert.equal(got[0].peak_mbps, 5000, `peak_mbps = ${got[0].peak_mbps}, attendu cap 5000`)
})

test('fetchTopBandwidth — primary_adapter = celui avec le plus de trafic (pas alphabétique)', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('MIX') RETURNING id`)
  const deviceId = rows[0].id
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(Date.now() - 15 * 60 * 1000)
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi',    0,            0,            $2),
      ($1, 'Wi-Fi',    10000000,     10000000,     $3),
      ($1, 'Ethernet', 0,            0,            $2),
      ($1, 'Ethernet', 5000000000,   5000000000,   $3)
  `, [deviceId, t0, t1])

  const got = await fetchTopBandwidth(db, { period: '24h' })
  assert.equal(got.length, 1)
  // Ethernet a beaucoup plus de trafic → adapter principal
  assert.equal(got[0].adapter, 'Ethernet')
})

// ─── fetchTopBandwidth : sparkline + trend (PR #124) ────────────────────────

test('fetchTopBandwidth — series_mbps populé pour les devices retournés', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('SPARK') RETURNING id`)
  const deviceId = rows[0].id
  // 3 samples espacés de 5 min → 2 deltas → au moins 2 buckets remplis sur
  // les 24 buckets de la fenêtre 4h.
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(t0.getTime() +  5 * 60 * 1000)
  const t2 = new Date(t0.getTime() + 10 * 60 * 1000)
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,         0,         $2),
      ($1, 'Wi-Fi', 50000000,  50000000,  $3),
      ($1, 'Wi-Fi', 150000000, 150000000, $4)
  `, [deviceId, t0, t1, t2])

  const got = await fetchTopBandwidth(db, { period: '4h' })
  assert.equal(got.length, 1)
  assert(Array.isArray(got[0].series_mbps), 'series_mbps doit être un tableau')
  assert(got[0].series_mbps.length >= 1, `series_mbps vide alors qu'on a des deltas`)
  // Tous les points doivent être des nombres positifs
  for (const v of got[0].series_mbps) {
    assert(typeof v === 'number' && v >= 0, `point invalide : ${v}`)
  }
})

test('fetchTopBandwidth — trend null si pas de data sur période précédente', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('NEW') RETURNING id`)
  const deviceId = rows[0].id
  // Seulement de la donnée récente, RIEN sur la fenêtre prev (now-8h → now-4h)
  const t0 = new Date(Date.now() - 30 * 60 * 1000)
  const t1 = new Date(t0.getTime() +  5 * 60 * 1000)
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,         0,         $2),
      ($1, 'Wi-Fi', 10000000,  10000000,  $3)
  `, [deviceId, t0, t1])

  const got = await fetchTopBandwidth(db, { period: '4h' })
  assert.equal(got.length, 1)
  assert.equal(got[0].trend, null, 'trend doit être null sans data prev')
})

test('fetchTopBandwidth — trend.delta_pct calculé pour data sur les 2 périodes', async (t) => {
  if (!isDbAvailable()) return t.skip('PG_TEST_URL absent')
  const { db, release } = await acquireSchema()
  t.after(() => release())

  const { rows } = await db.query(`INSERT INTO devices (hostname) VALUES ('GROW') RETURNING id`)
  const deviceId = rows[0].id
  // Période 4h. Prev = now-8h → now-4h.
  // Prev (4 GB consommés)  vs current (8 GB consommés) → delta +100 %
  const prevA = new Date(Date.now() - 7 * 3600 * 1000)        // -7h, dans prev
  const prevB = new Date(Date.now() - 5 * 3600 * 1000)        // -5h, dans prev
  const curA  = new Date(Date.now() - 3 * 3600 * 1000)        // -3h, dans current
  const curB  = new Date(Date.now() - 1 * 3600 * 1000)        // -1h, dans current
  await db.query(`
    INSERT INTO bandwidth_stats (device_id, adapter, bytes_sent, bytes_recv, sampled_at) VALUES
      ($1, 'Wi-Fi', 0,            0,            $2),
      ($1, 'Wi-Fi', 2000000000,   2000000000,   $3),
      ($1, 'Wi-Fi', 4000000000,   4000000000,   $4),
      ($1, 'Wi-Fi', 8000000000,   8000000000,   $5)
  `, [deviceId, prevA, prevB, curA, curB])

  const got = await fetchTopBandwidth(db, { period: '4h' })
  assert.equal(got.length, 1)
  assert(got[0].trend !== null, `trend devrait être défini, got ${JSON.stringify(got[0].trend)}`)
  // delta = (current - prev) / prev. Prev ≈ 4 GB, current ≈ 8 GB → +100 %.
  // Tolérance large car LAG dans prev part de prevA-1 (NULL) donc somme
  // exclut le 1er delta, ce qui peut shift les valeurs.
  assert(got[0].trend.delta_pct > 50,
    `delta_pct = ${got[0].trend.delta_pct}, attendu > 50`)
})

test.after(() => closeSharedPool())
