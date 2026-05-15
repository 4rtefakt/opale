import { sendPushToAll } from '../../core/routes/push.js'
import { logAudit } from '../../core/lib/audit.js'

// Moteur d'évaluation de conformité — set fixe de règles built-in.
//
// Choix v1 : règles déclarées en JS (pas table SQL éditable depuis l'UI).
// Surface d'attaque réduite, pas d'évaluateur sandbox, pas de risque qu'un
// admin casse le scoring de tout le parc en éditant une expression. Si une
// table SQL devient nécessaire (admin power user, multi-tenant…), c'est
// une réécriture explicite avec validation, pas un YAGNI à payer
// maintenant.
//
// Convention par règle :
//   {
//     id        : slug stable, persisté en DB. Ne jamais le changer après
//                 release (sinon on perd l'historique des transitions).
//     severity  : 'low' | 'medium' | 'high' | 'critical'
//     label     : libellé court FR pour l'UI (le i18n viendra plus tard
//                 si on multilingue le dashboard).
//     evaluate  : (snapshot) => { status, value? }
//                 - 'pass'           : règle satisfaite
//                 - 'fail'           : règle violée
//                 - 'not_applicable' : donnée absente (signal pas remonté,
//                                      device pas Intune, etc.). Distinct
//                                      de 'fail' — sinon chaque nouvelle
//                                      collecte agent transforme N postes
//                                      en faux positifs le temps que les
//                                      checkins remontent les data.
//                 value (optionnel) = JSON pour drill-down UI.
//                 Une règle ne doit JAMAIS throw : le checkin ne doit pas
//                 échouer pour une éval bugguée. Le wrapping try/catch est
//                 dans evaluateAndPersist par sécurité, mais le code
//                 evaluate() doit rester défensif (optional chaining, etc.).
//
// Le snapshot d'entrée est construit dans le hook checkin avec UNIQUEMENT
// les données déjà collectées (health_signals, system_info, disks, etc.).
// Ne PAS rajouter de collecte agent ici — toute la data nécessaire pour
// la v1 est déjà serveur-side.

// Seuils — déclarés en const pour rester lisibles et auditables d'un coup
// d'œil. Si un jour on veut les rendre paramétrables côté settings, c'est
// une migration explicite (table settings, defaults ici en fallback).
const AGENT_OFFLINE_HOURS         = 24
const SIGNATURE_AV_MAX_AGE_DAYS   = 7
const WINDOWS_UPDATE_MAX_AGE_DAYS = 30
const DISK_C_MAX_USED_PCT         = 90

function daysSince(yyyymmdd) {
  // Format attendu YYYY-MM-DD (cf. types.go HealthSignals). Renvoie null si
  // invalide pour que la règle bascule en not_applicable plutôt que fail.
  if (typeof yyyymmdd !== 'string') return null
  const d = new Date(yyyymmdd + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

function semverGt(a, b) {
  // Comparaison stricte : a > b. Identique à la logique d'auto-update agent
  // (cf. agent.js semverGt). On veut "version courante OU plus récente" donc
  // on teste !semverGt(latest, current) — i.e. current >= latest.
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

export const RULES = [
  {
    id: 'bitlocker_c_active',
    severity: 'high',
    label: 'BitLocker activé sur C:',
    evaluate: (s) => {
      const bl = s.health?.bitlocker
      if (!bl || typeof bl !== 'object') return { status: 'not_applicable' }
      // L'agent ne remonte qu'un volume (C: en pratique). On accepte le
      // signal tel quel : si bl.volume !== 'C:' on traite comme N/A
      // (cas pathologique : poste sans C: ou collecte exotique).
      if (bl.volume !== 'C:') return { status: 'not_applicable', value: { volume: bl.volume } }
      if (bl.protection_status === 'on') return { status: 'pass' }
      return { status: 'fail', value: { protection_status: bl.protection_status, enabled: bl.enabled } }
    },
  },

  {
    id: 'defender_av_active',
    severity: 'critical',
    label: 'Defender — antivirus actif',
    evaluate: (s) => {
      const d = s.health?.defender
      if (!d || typeof d !== 'object') return { status: 'not_applicable' }
      return d.antivirus_enabled === true
        ? { status: 'pass' }
        : { status: 'fail', value: { antivirus_enabled: d.antivirus_enabled } }
    },
  },

  {
    id: 'defender_rt_active',
    severity: 'critical',
    label: 'Defender — protection temps réel',
    evaluate: (s) => {
      const d = s.health?.defender
      if (!d || typeof d !== 'object') return { status: 'not_applicable' }
      return d.realtime_protection === true
        ? { status: 'pass' }
        : { status: 'fail', value: { realtime_protection: d.realtime_protection } }
    },
  },

  {
    id: 'defender_signature_fresh',
    severity: 'medium',
    label: `Signature AV mise à jour (< ${SIGNATURE_AV_MAX_AGE_DAYS} j)`,
    evaluate: (s) => {
      const d = s.health?.defender
      if (!d || typeof d !== 'object') return { status: 'not_applicable' }
      // signature_age_days peut être 0 (mis à jour aujourd'hui). On préfère
      // ce champ direct au calcul depuis signature_last_update : c'est ce
      // que l'agent calcule lui-même avec sa propre horloge.
      const age = d.signature_age_days
      if (typeof age !== 'number') return { status: 'not_applicable' }
      return age <= SIGNATURE_AV_MAX_AGE_DAYS
        ? { status: 'pass', value: { age_days: age } }
        : { status: 'fail', value: { age_days: age, max: SIGNATURE_AV_MAX_AGE_DAYS } }
    },
  },

  {
    id: 'defender_no_recent_threats',
    severity: 'high',
    label: 'Aucune menace détectée (30 j)',
    evaluate: (s) => {
      const d = s.health?.defender
      if (!d || typeof d !== 'object') return { status: 'not_applicable' }
      const n = d.threats_last_30d
      if (typeof n !== 'number') return { status: 'not_applicable' }
      // n=0 → pass. n>0 → fail (info : pas forcément alarmant, mais un poste
      // qui chope régulièrement des malware est un "à risque" à investiguer).
      return n === 0
        ? { status: 'pass' }
        : { status: 'fail', value: { threats_last_30d: n, last_threat_at: d.last_threat_at || null } }
    },
  },

  {
    id: 'firewall_all_profiles',
    severity: 'high',
    label: 'Pare-feu activé sur tous les profils',
    evaluate: (s) => {
      const fw = s.health?.firewall
      if (!fw || typeof fw !== 'object') return { status: 'not_applicable' }
      const ok = fw.domain_enabled === true && fw.private_enabled === true && fw.public_enabled === true
      return ok
        ? { status: 'pass' }
        : { status: 'fail', value: { domain: fw.domain_enabled, private: fw.private_enabled, public: fw.public_enabled } }
    },
  },

  {
    id: 'agent_seen_recent',
    severity: 'medium',
    label: `Agent vu il y a moins de ${AGENT_OFFLINE_HOURS} h`,
    evaluate: (s) => {
      // Évalué pendant le checkin : par construction last_seen vient d'être
      // mis à jour, donc cette règle passe TOUJOURS pour le device qui
      // déclenche l'éval. Elle est utile pour le dashboard agrégé : les
      // devices qui ne checkin plus gardent leur dernier verdict (le row
      // n'est pas re-touché), donc à mesure que le temps passe, ils
      // basculent en fail au prochain refresh global ou à un futur batch.
      //
      // Note : pas de batch périodique en v1. Si un device est offline 3j,
      // sa row montre toujours pass jusqu'au prochain checkin (probablement
      // jamais). Mieux : règle re-évaluée côté API au moment de l'aggregate
      // pour cette règle spécifique. À ajouter en PR2 si nécessaire — pour
      // l'instant on documente la limite.
      if (!s.last_seen) return { status: 'not_applicable' }
      const ageMs = Date.now() - new Date(s.last_seen).getTime()
      const ageHours = ageMs / 3600000
      return ageHours <= AGENT_OFFLINE_HOURS
        ? { status: 'pass', value: { hours_since: Math.round(ageHours) } }
        : { status: 'fail', value: { hours_since: Math.round(ageHours), max: AGENT_OFFLINE_HOURS } }
    },
  },

  {
    id: 'agent_version_current',
    severity: 'low',
    label: 'Version d\'agent à jour',
    evaluate: (s) => {
      if (!s.agent_version || !s.latest_agent_version) return { status: 'not_applicable' }
      // pass si current >= latest (cad la latest n'est pas strictement
      // supérieure). Évite que les agents installés en MAIN/dev marqués
      // "999.x.x" remontent en fail.
      return !semverGt(s.latest_agent_version, s.agent_version)
        ? { status: 'pass', value: { current: s.agent_version, latest: s.latest_agent_version } }
        : { status: 'fail', value: { current: s.agent_version, latest: s.latest_agent_version } }
    },
  },

  {
    id: 'disk_c_under_90',
    severity: 'medium',
    label: 'Disque système (C:) utilisé < 90%',
    evaluate: (s) => {
      const pct = s.disk_c_used_pct
      if (typeof pct !== 'number') return { status: 'not_applicable' }
      return pct < DISK_C_MAX_USED_PCT
        ? { status: 'pass', value: { used_pct: pct } }
        : { status: 'fail', value: { used_pct: pct, max: DISK_C_MAX_USED_PCT } }
    },
  },

  {
    id: 'windows_update_recent',
    severity: 'medium',
    label: `Windows Update appliqué (< ${WINDOWS_UPDATE_MAX_AGE_DAYS} j)`,
    evaluate: (s) => {
      const d = daysSince(s.health?.last_windows_update)
      if (d === null) return { status: 'not_applicable' }
      return d <= WINDOWS_UPDATE_MAX_AGE_DAYS
        ? { status: 'pass', value: { age_days: d } }
        : { status: 'fail', value: { age_days: d, max: WINDOWS_UPDATE_MAX_AGE_DAYS } }
    },
  },

  {
    id: 'no_pending_reboot',
    severity: 'low',
    label: 'Pas de redémarrage en attente',
    evaluate: (s) => {
      const pr = s.health?.pending_reboot
      if (typeof pr !== 'boolean') return { status: 'not_applicable' }
      return pr === false ? { status: 'pass' } : { status: 'fail' }
    },
  },

  {
    id: 'intune_compliant',
    severity: 'medium',
    label: 'Conforme Intune',
    // ⚠ Règle transitoire : à retirer quand le système de groupes natif
    // remplacera la dépendance Entra/Intune (cf. roadmap project_groups).
    evaluate: (s) => {
      // compliance_state vient de la sync Intune (routes/settings.js).
      // NULL = device pas dans Intune → N/A (le RMM gère aussi des postes
      // hors Intune). 'compliant' = pass. Autre valeur = fail.
      const c = s.compliance_state
      if (c === null || c === undefined) return { status: 'not_applicable' }
      return c === 'compliant'
        ? { status: 'pass' }
        : { status: 'fail', value: { compliance_state: c } }
    },
  },
]

// Index par id pour les lookups (audit logs, drill-downs).
export const RULES_BY_ID = new Map(RULES.map(r => [r.id, r]))

// Sévérités qui déclenchent un push + ticket_proposal sur transition
// pass→fail (PR4). Gardé en const pour faciliter une éventuelle
// paramétrisation (setting CSV) plus tard.
export const ALERTING_SEVERITIES = new Set(['high', 'critical'])

// Mapping severity (compliance) → priority (tickets). Cf. PRIORITIES dans
// api/routes/tickets.js (low|normal|high|critical).
const SEVERITY_TO_PRIORITY = {
  critical: 'critical',
  high:     'high',
}

// Crée une ticket_proposal pending pour une règle qui vient de basculer en
// fail. Idempotent : si une proposal pending existe déjà pour le couple
// (rule_id, device_id), on ne re-crée pas. Si l'admin a rejected, la
// prochaine transition pass→fail re-créera (cohérent : chaque transition
// est un événement distinct).
async function createComplianceProposal(fastify, { rule, deviceId, hostname, value }) {
  const { rows: existing } = await fastify.db.query(`
    SELECT id FROM ticket_proposals
    WHERE source = 'compliance'
      AND status = 'pending'
      AND source_payload->>'rule_id'   = $1
      AND source_payload->>'device_id' = $2
    LIMIT 1
  `, [rule.id, deviceId])
  if (existing.length) return null

  const priority = SEVERITY_TO_PRIORITY[rule.severity] || 'normal'
  const title = `Conformité : ${rule.label} — ${hostname || 'poste inconnu'}`
  const description =
    `Règle de conformité non respectée sur le poste ${hostname || deviceId}.\n` +
    `Sévérité : ${rule.severity}.\n` +
    (value ? `Détail : ${JSON.stringify(value)}` : '')

  const { rows } = await fastify.db.query(`
    INSERT INTO ticket_proposals
      (source, source_ref_type, source_payload,
       suggested_title, suggested_description, suggested_priority,
       suggested_device_id)
    VALUES ('compliance', 'compliance_rule', $1::jsonb,
            $2, $3, $4,
            $5)
    RETURNING id
  `, [
    JSON.stringify({ rule_id: rule.id, device_id: deviceId, severity: rule.severity, value: value ?? null }),
    title,
    description,
    priority,
    deviceId,
  ])
  return rows[0]?.id || null
}

/**
 * Évalue toutes les règles et persiste les résultats en DB.
 *
 * Garanties :
 *   - Ne throw jamais. Tout problème est loggé et le checkin continue.
 *   - Transactionnel via FOR UPDATE sur les rows existantes pour détecter
 *     proprement les transitions pass↔fail (sans race vs un autre checkin
 *     concurrent — rare en pratique, l'agent ne lance pas deux checkins
 *     simultanés, mais on reste safe).
 *   - Les transitions pass→fail et fail→pass sont loggées dans audit_logs
 *     (action 'compliance_changed'). Les transitions impliquant
 *     not_applicable sont ignorées (pas une vraie info de conformité).
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {string} deviceId
 * @param {object} snapshot — voir buildSnapshot()
 */
export async function evaluateAndPersist(fastify, deviceId, snapshot) {
  let prevRows
  try {
    const r = await fastify.db.query(
      `SELECT rule_id, status FROM compliance_results WHERE device_id = $1 FOR UPDATE`,
      [deviceId]
    )
    prevRows = r.rows
  } catch (err) {
    fastify.log.warn({ err: err.message, deviceId }, 'compliance: lookup previous failed')
    return
  }
  const prevMap = new Map(prevRows.map(r => [r.rule_id, r.status]))

  // Setting "alertes conformité" lu une seule fois par éval (pas par règle).
  // Défaut = false : à l'activation explicite par un admin, on commence à
  // pusher + créer des proposals sur les transitions critical/high.
  let alertsEnabled = false
  try {
    const { rows } = await fastify.db.query(
      `SELECT value FROM settings WHERE key = 'compliance_alerts_enabled'`
    )
    alertsEnabled = rows[0]?.value === 'true'
  } catch { /* defaults to false */ }

  for (const rule of RULES) {
    let result
    try {
      result = rule.evaluate(snapshot)
    } catch (err) {
      fastify.log.warn({ err: err.message, rule: rule.id, deviceId }, 'compliance: rule evaluator threw')
      continue
    }
    if (!result || !['pass', 'fail', 'not_applicable'].includes(result.status)) {
      fastify.log.warn({ rule: rule.id, deviceId, result }, 'compliance: rule returned invalid status')
      continue
    }

    try {
      await fastify.db.query(`
        INSERT INTO compliance_results (device_id, rule_id, status, severity, value, evaluated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, now())
        ON CONFLICT (device_id, rule_id) DO UPDATE SET
          status       = EXCLUDED.status,
          severity     = EXCLUDED.severity,
          value        = EXCLUDED.value,
          evaluated_at = now()
      `, [
        deviceId,
        rule.id,
        result.status,
        rule.severity,
        result.value !== undefined ? JSON.stringify(result.value) : null,
      ])
    } catch (err) {
      fastify.log.warn({ err: err.message, rule: rule.id, deviceId }, 'compliance: upsert failed')
      continue
    }

    const before = prevMap.get(rule.id)
    // Transitions notables = pass↔fail. On ignore les transitions
    // impliquant not_applicable (apparition/disparition d'un signal n'est
    // pas un événement de conformité).
    const isPassFailTransition =
      before && before !== result.status
        && (before === 'pass' || before === 'fail')
        && (result.status === 'pass' || result.status === 'fail')

    if (isPassFailTransition) {
      logAudit(fastify.db, fastify.log, {
        action: 'compliance_changed',
        byUser: 'system',
        target: deviceId,
        details: {
          rule_id:  rule.id,
          from:     before,
          to:       result.status,
          severity: rule.severity,
          value:    result.value ?? null,
        },
      })

      // Action automatique : push admin + ticket_proposal sur transition
      // PASS→FAIL d'une règle critical/high, si le setting est activé.
      // Les fail→pass et les transitions de moindre sévérité ne déclenchent
      // rien (volontaire : on veut juste pister les régressions sensibles).
      if (alertsEnabled
          && before === 'pass'
          && result.status === 'fail'
          && ALERTING_SEVERITIES.has(rule.severity)) {
        const hostname = snapshot.hostname || null

        // Push admin (best-effort, ne bloque pas la suite).
        sendPushToAll(fastify, {
          title: `⚠ Conformité — ${hostname || 'poste'}`,
          body:  `${rule.label} (${rule.severity})`,
          deviceId,
          url:   `/mobile.html#/poste/${deviceId}`,
        }).catch(err => fastify.log.warn({ err: err.message }, 'compliance: push failed'))

        // Ticket_proposal idempotent (pas de doublon pending).
        createComplianceProposal(fastify, {
          rule,
          deviceId,
          hostname,
          value: result.value ?? null,
        }).catch(err => fastify.log.warn({ err: err.message, rule: rule.id, deviceId }, 'compliance: proposal creation failed'))
      }
    }
  }
}
