// Helpers partagés par les pages Aujourd'hui / Tickets / Focus.

export const TAG_PALETTE = {
  slate:  { bg: '#475569', fg: '#ffffff', label: 'Gris'    },
  blue:   { bg: '#2563eb', fg: '#ffffff', label: 'Bleu'    },
  green:  { bg: '#059669', fg: '#ffffff', label: 'Vert'    },
  amber:  { bg: '#d97706', fg: '#ffffff', label: 'Ambre'   },
  red:    { bg: '#dc2626', fg: '#ffffff', label: 'Rouge'   },
  violet: { bg: '#7c3aed', fg: '#ffffff', label: 'Violet'  },
  pink:   { bg: '#db2777', fg: '#ffffff', label: 'Rose'    },
  teal:   { bg: '#0d9488', fg: '#ffffff', label: 'Sarcelle'},
}
export const TAG_COLOR_KEYS = Object.keys(TAG_PALETTE)

export function shortName(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] || ''
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.'
}
export function initialsOf(name) {
  return (name || '?').split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2)
}
// Référence courte = tag [Opale #XXXXXXXX] des mails sortants.
export function ticketRef(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase()
}
export function tagChip(tag, opts = {}) {
  const palette = TAG_PALETTE[tag.color] || TAG_PALETTE.slate
  const size = opts.compact ? 'font-size:10px;padding:1px 6px;border-radius:8px' : 'font-size:11px;padding:2px 8px;border-radius:10px'
  const closeBtn = opts.onRemove
    ? ` <span style="margin-left:4px;cursor:pointer;opacity:0.85" onclick="event.stopPropagation();${opts.onRemove}">×</span>`
    : ''
  return `<span style="display:inline-flex;align-items:center;background:${palette.bg};color:${palette.fg};${size}">${esc(tag.name)}${closeBtn}</span>`
}

function loc() { return (window.getLocale?.() || 'fr') === 'en' ? 'en-GB' : 'fr-FR' }
export function fmtDateShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(loc(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
    + ', ' + d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })
}
export function fmtDateFull(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })
}
export function whenHtml(iso) {
  if (!iso) return ''
  const age = Date.now() - new Date(iso).getTime()
  const txt = age < 86_400_000 ? formatRelative(iso) : fmtDateShort(iso)
  return `<span title="${esc(fmtDateFull(iso))}">${esc(txt)}</span>`
}
export function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date(); const yest = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return t('tickets.day.today')
  if (d.toDateString() === yest.toDateString())  return t('tickets.day.yesterday')
  return d.toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'long', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })
}
export function dayKey(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().slice(0, 10) }

// Nettoie les descriptions HTML héritées (tickets créés avant htmlToText).
export function cleanLegacyHtml(text) {
  if (!text) return text
  const s = String(text)
  if (!/<(html|body|head|div|p|br|meta|style)[\s>]/i.test(s)) return s
  return s
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n').replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n').replace(/<li\s*>/gi, '- ').replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Sujet sans les préfixes Outlook (RE:, TR:, Fwd:…) ; `empty` si vide.
export function cleanSubject(s, empty) {
  return String(s || '').replace(/^\s*(?:(?:re|tr|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim() || empty
}

export function statusLabel(s) {
  return s === 'open'        ? t('tickets.status.open')
       : s === 'in_progress' ? t('tickets.status.in_progress')
       : s === 'resolved'    ? t('tickets.status.resolved')
       : s === 'closed'      ? t('tickets.status.closed')
       : s === 'merged'      ? t('tickets.status.merged')
       : esc(s)
}
export function prioLabel(p) {
  return p === 'low' ? t('prio.low') : p === 'normal' ? t('prio.normal') : p === 'high' ? t('prio.high') : p === 'critical' ? t('prio.critical') : esc(p)
}
// Ce que le ticket attend de moi — l'état lisible qui remplace open/in_progress.
export function nextLabel(tk) {
  if (tk.status === 'closed')   return { key: 'archived', label: t('tickets.next.archived'), cls: 'done' }
  if (tk.status === 'resolved') return { key: 'resolved', label: t('tickets.next.resolved'), cls: 'done' }
  if (tk.status === 'merged')   return { key: 'merged',   label: t('tickets.status.merged'), cls: 'done' }
  if (tk.awaiting_reply)        return { key: 'needs',    label: t('tickets.next.needs'),    cls: 'needs' }
  if (tk.priority === 'critical') return { key: 'crit',   label: t('tickets.next.critical'), cls: 'crit' }
  if (!tk.assigned_to_entra_id) return { key: 'unassigned', label: t('tickets.next.unassigned'), cls: '' }
  return { key: 'waiting', label: t('tickets.next.waiting'), cls: 'quiet' }
}

// ── File de travail : « Terminé & suivant » ──────────────────────────────────
// La page Aujourd'hui et la liste écrivent la liste d'ids ouverte ; la page
// focus affiche « x sur n » et enchaîne. sessionStorage : propre à l'onglet.
const QUEUE_KEY = 'opale.queue'
export function buildQueue(tickets) { return tickets.map(tk => tk.id).filter(Boolean) }
export function saveQueue(ids, from) {
  try { sessionStorage.setItem(QUEUE_KEY, JSON.stringify({ ids, from, at: Date.now() })) } catch {}
}
export function readQueue() {
  try { const q = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || 'null'); return q && Array.isArray(q.ids) ? q : null } catch { return null }
}
export function queueNext(currentId) {
  const q = readQueue()
  if (!q) return null
  const i = q.ids.indexOf(currentId)
  const rest = q.ids.filter(id => id !== currentId)
  saveQueue(rest, q.from)
  return rest[i] || rest[i - 1] || rest[0] || null
}
export function queuePosition(currentId) {
  const q = readQueue()
  if (!q) return null
  const i = q.ids.indexOf(currentId)
  return i === -1 ? null : { index: i + 1, total: q.ids.length, from: q.from }
}
