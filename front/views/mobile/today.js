// Aujourd'hui (mobile) — l'onglet d'accueil : ce qui a besoin de moi, dans
// l'ordre, une action évidente par ligne. Même logique que la page desktop
// (views/today.js) : trois chiffres, une file « À suivre », « Commencer ».

import { getLocale } from '/i18n.js'
import { buildQueue, saveQueue, shortName } from '/views/ticket-shared.js'

let _data = null

export async function renderToday(el) {
  const user  = window.appState?.user
  const first = (user?.displayName || '').split(' ')[0]
  const loc   = getLocale() === 'en' ? 'en-GB' : 'fr-FR'
  const today = new Date().toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' })

  el.innerHTML = `
    <div class="m-header big">
      <div class="m-head-text">
        <div class="m-kicker">${esc(today)}</div>
        <h1>${esc(t('today.greeting', { name: first || '' }))}<span class="m-h1-sub" id="m-today-sub">${esc(t('today.loading'))}</span></h1>
      </div>
      <div class="m-actions">
        <button class="m-icon-btn" onclick="window.location.hash='#/search'" title="${esc(t('mobile.dashboard.search_title'))}"><i class="ti ti-search"></i></button>
      </div>
    </div>
    <div class="m-scroll" id="m-today-body">
      <div class="m-today-cards" id="m-today-cards"></div>
      <div class="m-upnext" id="m-today-upnext">
        <div class="m-upnext-head"><span>${esc(t('today.upnext'))}</span></div>
        <div class="m-loading-row"><div class="m-spinner sm"></div></div>
      </div>
      <button class="m-btn primary block" id="m-today-start" onclick="mTodayStart()" style="display:none"><i class="ti ti-player-play"></i> ${esc(t('today.start'))}</button>
      <div class="m-fleet" id="m-today-fleet"></div>
    </div>`

  window.mTodayStart = todayStart
  window.mTodayQueue = () => { if (_data) saveQueue(buildQueue(_data.shown), 'today') }
  await load(el)
}

async function load(el) {
  let inbox, tickets, alerts, dash, inboxCount, ticketsCount
  try {
    ;[inbox, tickets, alerts, dash, inboxCount, ticketsCount] = await Promise.all([
      window.api.getInbox({ limit: 200 }).catch(() => []),
      window.api.getTickets({ limit: 200 }),
      window.api.getAlerts().catch(() => null),
      window.api.getDashboard().catch(() => null),
      window.api.getInboxCount().catch(() => ({})),
      window.api.getTicketsCount().catch(() => ({})),
    ])
  } catch (err) {
    const body = document.getElementById('m-today-body')
    if (body) body.innerHTML = mErrorBox(err.message, () => load(el))
    return
  }
  const me = window.appState?.user?.entraId
  const live = tickets.filter(tk => ['open', 'in_progress'].includes(tk.status))
  const waited = tk => Date.parse(tk.updated_at || tk.created_at)
  const needs      = live.filter(tk => tk.awaiting_reply).sort((a, b) => waited(a) - waited(b))
  const critical   = live.filter(tk => tk.priority === 'critical' && !tk.awaiting_reply)
  const unassigned = live.filter(tk => !tk.assigned_to_entra_id && !tk.awaiting_reply && tk.priority !== 'critical')
  const mineQuiet  = live.filter(tk => tk.assigned_to_entra_id === me && !tk.awaiting_reply && tk.priority !== 'critical')
  const oldestMail = inbox.reduce((m, x) => (!m || Date.parse(x.received_at) < Date.parse(m.received_at)) ? x : m, null)
  const alertCrit  = alerts?.counts?.critical || 0

  // Compteurs serveur (fils à trier, tickets en attente) : les listes sont
  // bornées à 200 et comptent les mails un par un.
  const nInbox = inboxCount.threads ?? inbox.length
  const nNeeds = ticketsCount.awaiting_reply ?? needs.length
  const total  = nInbox + nNeeds + critical.length
  const sub = document.getElementById('m-today-sub')
  if (sub) sub.textContent = total === 0 ? t('today.nothing') : t('today.count', { n: total })
  window.mSetTicketsBadge?.(nInbox + nNeeds)

  const cards = document.getElementById('m-today-cards')
  if (cards) cards.innerHTML = `
    <a class="m-today-card ${nInbox ? 'hot' : ''}" href="#/tickets?folder=inbox">
      <span class="lbl">${esc(t('today.card.inbox'))}</span>
      <span class="num">${nInbox}</span>
      <span class="sub">${esc(oldestMail ? t('today.card.inbox_oldest', { age: formatRelative(oldestMail.received_at) }) : t('today.card.inbox_empty'))}</span>
    </a>
    <a class="m-today-card ${nNeeds ? 'needs' : 'ok'}" href="#/tickets?folder=needs">
      <span class="lbl">${esc(t('today.card.needs'))}</span>
      <span class="num">${nNeeds}</span>
      <span class="sub">${esc(needs.length ? needs.slice(0, 2).map(tk => shortName(tk.requester_name) || tk.hostname || '?').join(' · ') : t('today.card.needs_empty'))}</span>
    </a>
    <a class="m-today-card ${alertCrit ? 'crit' : 'ok'}" href="#/alertes">
      <span class="lbl">${esc(t('today.card.alerts'))}</span>
      <span class="num">${alertCrit}</span>
      <span class="sub">${esc(alertCrit ? firstAlertLabel(alerts) : t('today.card.alerts_empty'))}</span>
    </a>`

  // File « À suivre » : qui attend depuis le plus longtemps d'abord.
  const rows = []
  for (const tk of needs) rows.push({ tk, kind: 'needs', why: t('today.why.replied', { who: shortName(tk.requester_name) || t('today.someone'), when: formatRelative(tk.updated_at || tk.created_at) }) + assigneeWhy(tk, me), act: t('today.act.reply') })
  for (const tk of critical) rows.push({ tk, kind: 'crit', why: t('today.why.critical', { when: formatRelative(tk.created_at) }) + assigneeWhy(tk, me), act: tk.assigned_to_entra_id ? t('today.act.open') : t('today.act.take') })
  for (const tk of unassigned.slice(0, 3)) rows.push({ tk, kind: 'quiet', why: t('today.why.unassigned', { when: formatRelative(tk.created_at) }), act: t('today.act.take') })
  for (const tk of mineQuiet.slice(0, 3)) rows.push({ tk, kind: 'quiet', why: t('today.why.waiting', { when: formatRelative(tk.updated_at || tk.created_at) }), act: t('today.act.waiting') })
  const shown = rows.slice(0, 8)
  _data = { inbox, needs, critical, unassigned, shown: shown.map(r => r.tk) }

  const up = document.getElementById('m-today-upnext')
  if (up) {
    up.innerHTML = `<div class="m-upnext-head"><span>${esc(t('today.upnext'))}</span><span class="note">${esc(t('today.upnext_note'))}</span></div>` +
      (shown.length
        ? shown.map(r => `<a class="m-upnext-row ${r.kind}" href="#/ticket/${esc(r.tk.id)}" onclick="mTodayQueue()">
            <span class="bar"></span>
            <span style="min-width:0"><div class="ttl">${esc(r.tk.title)}</div><div class="why">${esc(r.why)}${r.tk.hostname ? ` · ${esc(r.tk.hostname)}` : ''}</div></span>
            <span class="act">${esc(r.act)} →</span>
          </a>`).join('')
        : `<div class="m-upnext-empty">${esc(inbox.length ? t('today.upnext_only_inbox') : t('today.upnext_empty'))}</div>`)
  }

  const start = document.getElementById('m-today-start')
  if (start) start.style.display = (shown.length || inbox.length) ? '' : 'none'

  const fleet = document.getElementById('m-today-fleet')
  const k = dash?.kpis
  if (fleet && k) {
    fleet.innerHTML = [
      `<a href="#/postes">${esc(t('today.fleet.online', { on: k.devices_online ?? 0, total: k.devices_total ?? 0 }))}</a>`,
      k.compliance_failing_devs > 0 ? `<a href="#/conformite">${esc(t('today.fleet.noncompliant', { n: k.compliance_failing_devs }))}</a>` : `<span>${esc(t('today.fleet.compliant'))}</span>`,
      (k.deployments_running || k.deployments_pending) ? `<a href="#/packages">${esc(t('today.fleet.deployments', { n: k.deployments_running || 0, p: k.deployments_pending || 0 }))}</a>` : `<span>${esc(t('today.fleet.deployments_idle'))}</span>`,
    ].join('<span>·</span>')
  }
}

function assigneeWhy(tk, me) {
  if (!tk.assigned_to_entra_id) return ' · ' + t('today.why.unassigned_short')
  if (tk.assigned_to_entra_id === me) return ' · ' + t('today.why.you')
  return ' · ' + shortName(tk.assigned_to_name)
}

function firstAlertLabel(alerts) {
  const d = (alerts?.disk_critical || []).find(r => !r.snoozed_until)
  if (d) return `${d.hostname} · ${t('today.alert.disk', { pct: d.disk_used_pct })}`
  const n = (alerts?.non_compliant || []).find(r => !r.snoozed_until)
  if (n) return `${n.hostname} · ${t('today.alert.noncompliant')}`
  return ''
}

// « Commencer » : ouvre le premier élément de la file (ou le tri des mails
// s'il n'y a rien d'autre), en mémorisant la file pour « Terminé & suivant ».
function todayStart() {
  const d = _data
  if (!d) return
  const first = d.needs[0] || d.critical[0] || d.unassigned[0]
  if (first) {
    saveQueue(buildQueue([...d.needs, ...d.critical, ...d.unassigned.slice(0, 3)]), 'today')
    window.location.hash = `#/ticket/${first.id}`
  } else if (d.inbox.length) {
    window.location.hash = '#/tickets?folder=inbox'
  }
}
