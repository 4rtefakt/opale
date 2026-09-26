// Faux Microsoft Graph au niveau fetch() pour les tests du polling mail.
// Aucune requête ne sort : globalThis.fetch est remplacé (même principe que
// mockFetchRouter dans email-graph-mail.test.js) et rétabli par restore().
//
// Routes servies :
//   - jeton applicatif (login.microsoftonline.com)
//   - /users/{box}/mailFolders/{raccourci}          → { id } ou 404
//   - /users/{box}/messages                         → listing de `inbox`
//   - /users/{box}/mailFolders/sentitems/messages   → listing de `sent`
//   - /users/{box}/messages/{id}                    → un mail (+ body)
//
// Le listing reproduit ce dont dépend le worker : `$filter` `<champ> ge|gt
// <ISO>`, `$orderby <champ> asc` (tri stable : ex aequo dans l'ordre du
// tableau), `$top`, et `@odata.nextLink` absolu paginé par `$skip` —
// calculé sur l'état COURANT de la boîte, comme Graph : un mail retiré
// entre deux pages décale la suivante (cf. fg.onList).

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function listPage(url, all, field) {
  const orderby = url.searchParams.get('$orderby')
  if (orderby !== `${field} asc`) throw new Error(`fake-graph: $orderby inattendu ${orderby}`)
  const top = Number(url.searchParams.get('$top') || 10)
  const skip = Number(url.searchParams.get('$skip') || 0)

  let items = all
  const filter = url.searchParams.get('$filter')
  if (filter) {
    const f = filter.match(/^(\w+) (ge|gt) (\S+)$/)
    if (!f || f[1] !== field) throw new Error(`fake-graph: $filter non géré ${filter}`)
    const since = Date.parse(f[3])
    items = items.filter(m => f[2] === 'ge' ? Date.parse(m[field]) >= since : Date.parse(m[field]) > since)
  }
  items = [...items].sort((a, b) => Date.parse(a[field]) - Date.parse(b[field]))

  const page = { value: items.slice(skip, skip + top).map(m => structuredClone(m)) }
  if (skip + top < items.length) {
    const next = new URL(url)
    next.searchParams.set('$skip', String(skip + top))
    page['@odata.nextLink'] = next.toString()
  }
  return page
}

// `inbox` / `sent` : tableaux de mails Graph, modifiables entre deux polls
// (fg.inbox.push(...) pour simuler un mail visible plus tard).
export function installFakeGraph({ inbox = [], sent = [], folders = {} } = {}) {
  const fg = { inbox, sent, folders, calls: [] }
  const original = globalThis.fetch

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    fg.calls.push(url.toString())
    if (url.hostname === 'login.microsoftonline.com') {
      return reply({ access_token: 'tok', expires_in: 3600 })
    }
    if (url.hostname !== 'graph.microsoft.com') throw new Error(`fake-graph: hôte inattendu ${url.hostname}`)

    const path = decodeURIComponent(url.pathname)
    // Hook de test : appelé avant chaque requête de listing (1re page ou
    // nextLink), pour modifier la boîte entre deux pages d'un même tick.
    if (/\/messages$/.test(path) && fg.onList) fg.onList(url)
    let m
    if (path.endsWith('/mailFolders/sentitems/messages')) return reply(listPage(url, fg.sent, 'sentDateTime'))
    if ((m = path.match(/\/mailFolders\/(\w+)$/))) {
      return fg.folders[m[1]] ? reply({ id: fg.folders[m[1]] }) : reply({ error: 'ErrorFolderNotFound' }, 404)
    }
    if (path.endsWith('/messages')) return reply(listPage(url, fg.inbox, 'receivedDateTime'))
    if ((m = path.match(/\/messages\/([^/]+)$/))) {
      const msg = [...fg.inbox, ...fg.sent].find(x => x.id === m[1])
      return msg
        ? reply({ ...msg, body: { contentType: 'text', content: msg.bodyPreview || '' } })
        : reply({ error: 'ErrorItemNotFound' }, 404)
    }
    throw new Error(`fake-graph: route inconnue ${url}`)
  }

  // Requêtes de listing (première page ou nextLink) émises jusqu'ici.
  fg.listCalls = () => fg.calls.filter(u => /\/messages\?/.test(u))
  fg.restore = () => { globalThis.fetch = original }
  return fg
}

// Horodatage « format Graph » (à la seconde, suffixe Z) à `s` secondes de `t0`.
export function graphTime(t0, s) {
  return new Date(Date.parse(t0) + s * 1000).toISOString().replace('.000Z', 'Z')
}

let _seq = 0
// Mail Graph minimal pour le polling ; `overrides` écrase les champs.
export function fakeMail(overrides = {}) {
  const tag = `${Date.now().toString(36)}-${(++_seq).toString(36)}`
  return {
    id: `graph-${tag}`,
    internetMessageId: `<${tag}@example.com>`,
    conversationId: `conv-${tag}`,
    subject: `Mail ${tag}`,
    bodyPreview: `Corps ${tag}`,
    from: { emailAddress: { address: 'marie@example.com', name: 'Marie' } },
    toRecipients: [],
    hasAttachments: false,
    internetMessageHeaders: [],
    parentFolderId: 'inbox-id',
    isDraft: false,
    ...overrides,
  }
}
