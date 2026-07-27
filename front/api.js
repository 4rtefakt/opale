class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message)
    this.status = status
    this.body   = body   // payload JSON complet (utile pour les codes métier détaillés)
  }
}

class API {
  async _fetch(path, options = {}) {
    const token = await window.auth.getToken()
    const hasBody = options.body !== undefined
    const BASE = window.ENV?.API_BASE_URL || '/api'

    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...options.headers
      },
      body: hasBody ? JSON.stringify(options.body) : undefined
    })

    if (res.status === 204) return null
    const data = await res.json()
    if (!res.ok) throw new ApiError(res.status, data.error || 'Erreur serveur', data)
    return data
  }

  syncMe()             { return this._fetch('/users/sync-me',   { method: 'POST', body: {} }) }
  syncAllUsers()       { return this._fetch('/users/sync-all',  { method: 'POST', body: {} }) }
  getUsers()           { return this._fetch('/users') }
  getUser(id)          { return this._fetch(`/users/${id}`) }
  async fetchUserPhoto(id) {
    const token = await window.auth.getToken()
    const base  = window.ENV?.API_BASE_URL || '/api'
    const res   = await fetch(`${base}/users/${id}/photo`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  }
  searchAADUsers(q)    { return this._fetch(`/users/search-aad?q=${encodeURIComponent(q)}`) }
  getDashboard()       { return this._fetch('/dashboard') }
  getDevices(params)   {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/devices${qs}`)
  }
  getDevice(id)        { return this._fetch(`/devices/${id}`) }
  deleteDevice(id)     { return this._fetch(`/devices/${id}`, { method: 'DELETE' }) }
  forceSyncDevices(ids)    { return this._fetch('/devices/force-sync',    { method: 'POST', body: { ids } }) }
  forceCheckinDevices(ids) { return this._fetch('/devices/force-checkin', { method: 'POST', body: { ids } }) }
  getAdminCredential(deviceId)    { return this._fetch(`/admin-credentials/${deviceId}`) }
  rotateAdminCredential(deviceId) { return this._fetch(`/admin-credentials/${deviceId}/rotate`, { method: 'POST', body: {} }) }

  // Tickets
  getTickets(params)   {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/tickets${qs}`)
  }
  getTicket(id)        { return this._fetch(`/tickets/${id}`) }
  getTicketsCount()    { return this._fetch('/tickets/count') }
  createTicket(body)   { return this._fetch('/tickets', { method: 'POST', body }) }
  updateTicket(id, body) { return this._fetch(`/tickets/${id}`, { method: 'PATCH', body }) }
  addMessage(id, body) { return this._fetch(`/tickets/${id}/messages`, { method: 'POST', body }) }
  // Phase 1c : convertit une note interne (type='internal_note') en message
  // à envoyer par mail. L'outbound worker l'enverra au prochain tick.
  sendMessageByMail(ticketId, msgId) {
    return this._fetch(`/tickets/${ticketId}/messages/${msgId}/send-by-mail`, { method: 'POST' })
  }
  retrySendMessage(ticketId, msgId) {
    return this._fetch(`/tickets/${ticketId}/messages/${msgId}/retry-send`, { method: 'POST' })
  }
  aiSuggest(ticketId)                  { return this._fetch(`/tickets/${ticketId}/ai-suggest`, { method: 'POST' }) }
  deleteTicketMessage(ticketId, msgId) { return this._fetch(`/tickets/${ticketId}/messages/${msgId}`, { method: 'DELETE' }) }
  // Pièces jointes (upload manuel)
  async uploadAttachment(ticketId, file) {
    const token = await window.auth.getToken()
    const base  = window.ENV?.API_BASE_URL || '/api'
    const fd = new FormData()
    fd.append('file', file)
    // Pas de Content-Type explicite : le navigateur pose le multipart +
    // boundary lui-même. _fetch n'est pas utilisable (force application/json).
    const res = await fetch(`${base}/tickets/${ticketId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status, data.error || 'Upload échoué', data)
    return data
  }
  deleteAttachment(ticketId, attId) {
    return this._fetch(`/tickets/${ticketId}/attachments/${attId}`, { method: 'DELETE' })
  }
  async downloadAttachment(ticketId, attId, filename) {
    const token = await window.auth.getToken()
    const base  = window.ENV?.API_BASE_URL || '/api'
    const res = await fetch(`${base}/tickets/${ticketId}/attachments/${attId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new ApiError(res.status, 'Téléchargement échoué')
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url; a.download = filename || 'fichier'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // Phase 2 — relations M2M users/devices + merge
  addTicketUser(ticketId, body)      { return this._fetch(`/tickets/${ticketId}/users`, { method: 'POST', body }) }
  removeTicketUser(ticketId, entraId) { return this._fetch(`/tickets/${ticketId}/users/${encodeURIComponent(entraId)}`, { method: 'DELETE' }) }
  addTicketDevice(ticketId, body)    { return this._fetch(`/tickets/${ticketId}/devices`, { method: 'POST', body }) }
  removeTicketDevice(ticketId, deviceId) { return this._fetch(`/tickets/${ticketId}/devices/${deviceId}`, { method: 'DELETE' }) }
  mergeTicket(sourceId, targetId)    { return this._fetch(`/tickets/${sourceId}/merge`, { method: 'POST', body: { target_ticket_id: targetId } }) }

  // Phase 3 — vue "Mails à trier" (inbox)
  getInbox(params)                   {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/email/inbox${qs}`)
  }
  getInboxCount()                    { return this._fetch('/email/inbox/count') }
  inboxToTicket(mappingId)           { return this._fetch(`/email/inbox/${mappingId}/to-ticket`, { method: 'POST' }) }
  inboxDismiss(mappingId)            { return this._fetch(`/email/inbox/${mappingId}/dismiss`, { method: 'POST' }) }

  // Tags (référentiel partagé avec les tickets)
  getTags()                   { return this._fetch('/tickets/tags') }
  createTag(body)             { return this._fetch('/tickets/tags', { method: 'POST', body }) }
  deleteTag(id)               { return this._fetch(`/tickets/tags/${id}`, { method: 'DELETE' }) }
  addTicketTag(ticketId, tagId)    { return this._fetch(`/tickets/${ticketId}/tags`, { method: 'POST', body: { tag_id: tagId } }) }
  removeTicketTag(ticketId, tagId) { return this._fetch(`/tickets/${ticketId}/tags/${tagId}`, { method: 'DELETE' }) }
  searchUsers(q)              { return this._fetch(`/users/search?q=${encodeURIComponent(q)}`) }

  // Tickets proposés (à valider avant promotion)
  getProposals(params)        {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/ticket-proposals${qs}`)
  }
  getProposalsCount()         { return this._fetch('/ticket-proposals/count') }
  acceptProposal(id, body = {}) { return this._fetch(`/ticket-proposals/${id}/accept`, { method: 'POST', body }) }
  rejectProposal(id, reason)    { return this._fetch(`/ticket-proposals/${id}/reject`, { method: 'POST', body: { reason } }) }

  // Pont mail (issue #8) — stats pour le bandeau en haut de la vue Tickets
  getEmailStats(days = 7)       { return this._fetch(`/email/stats?days=${days}`) }
  getEmailRecent(params)        {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/email/recent${qs}`)
  }
  getEmailDiagnostic()          { return this._fetch('/email/diagnostic') }
  getEmailStatus()              { return this._fetch('/email/status') }

  // Snoozes d'alertes
  getSnoozes()              { return this._fetch('/alert-snoozes') }
  createSnooze(body)        { return this._fetch('/alert-snoozes', { method: 'POST', body }) }
  deleteSnooze(id)          { return this._fetch(`/alert-snoozes/${id}`, { method: 'DELETE' }) }

  // Paramètres
  getSettings()                    { return this._fetch('/settings') }
  updateSettings(body)             { return this._fetch('/settings', { method: 'PATCH', body }) }
  createToken(body)                { return this._fetch('/settings/tokens', { method: 'POST', body }) }
  revokeToken(id)                  { return this._fetch(`/settings/tokens/${id}`, { method: 'DELETE' }) }
  revokeCliToken(id)               { return this._fetch(`/settings/cli-tokens/${id}`, { method: 'DELETE' }) }
  addSSHKey(body)                  { return this._fetch('/settings/ssh-keys', { method: 'POST', body }) }
  deleteSSHKey(id)                 { return this._fetch(`/settings/ssh-keys/${id}`, { method: 'DELETE' }) }
  setAdmin(entraId, is_admin)      { return this._fetch(`/settings/admins/${entraId}`, { method: 'PATCH', body: { is_admin } }) }
  syncIntune()                     { return this._fetch('/settings/sync-intune', { method: 'POST', body: {} }) }
  getAudit(params = {}) {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v != null))).toString()
    return this._fetch(`/settings/audit${qs ? '?' + qs : ''}`)
  }

  // Préférences utilisateur (par user, stockées côté serveur — synchro entre
  // appareils). getMyPrefs → {} si rien ; updateMyPrefs merge superficiel.
  getMyPrefs()         { return this._fetch('/me/prefs') }
  updateMyPrefs(patch) { return this._fetch('/me/prefs', { method: 'PATCH', body: patch }) }

  // Onboarding
  getOnboardings(params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/onboarding${qs}`)
  }
  getOnboarding(id)               { return this._fetch(`/onboarding/${id}`) }
  createOnboarding(body)          { return this._fetch('/onboarding', { method: 'POST', body }) }
  updateOnboarding(id, body)      { return this._fetch(`/onboarding/${id}`, { method: 'PATCH', body }) }
  toggleCheck(obId, checkId, done) {
    return this._fetch(`/onboarding/${obId}/checks/${checkId}`, { method: 'PATCH', body: { done } })
  }
  runAutoCheck(obId, checkId)     {
    return this._fetch(`/onboarding/${obId}/checks/${checkId}/auto`, { method: 'POST', body: {} })
  }

  // Scripts
  getScripts()                    { return this._fetch('/scripts') }
  createScript(body)              { return this._fetch('/scripts', { method: 'POST', body }) }
  updateScript(id, body)          { return this._fetch(`/scripts/${id}`, { method: 'PUT', body }) }
  deleteScript(id)                { return this._fetch(`/scripts/${id}`, { method: 'DELETE' }) }
  runScript(id, device_id)        { return this._fetch(`/scripts/${id}/run`, { method: 'POST', body: { device_id } }) }
  getDeviceExecutions(deviceId, offset = 0) { return this._fetch(`/scripts/executions/device/${deviceId}?offset=${offset}`) }

  // Rapports
  getRapports()           { return this._fetch('/rapports') }

  // Réseau — top consommateurs bande passante.
  // params : { period: '4h'|'24h'|'7d', sort: 'total'|'sent'|'recv', limit: 1..100 }
  // Chaque appel est audité côté serveur (action 'network_view_accessed').
  getTopNetwork(params = {}) {
    const qs = '?' + new URLSearchParams(params).toString()
    return this._fetch(`/network/top${qs}`)
  }

  // Packages
  getPackages()               { return this._fetch('/packages') }
  getPackage(id)              { return this._fetch(`/packages/${id}`) }
  createPackage(body)         { return this._fetch('/packages', { method: 'POST', body }) }
  updatePackage(id, body)     { return this._fetch(`/packages/${id}`, { method: 'PATCH', body }) }
  deletePackage(id)           { return this._fetch(`/packages/${id}`, { method: 'DELETE' }) }
  // expectedDigest = empreinte du contenu affiché à l'écran. Le serveur
  // refuse l'approbation si le package a changé entre l'affichage et le clic.
  approvePackage(id, expectedDigest) {
    return this._fetch(`/packages/${id}/approve`, {
      method: 'POST',
      body: expectedDigest ? { expected_digest: expectedDigest } : {},
    })
  }
  deployPackage(id, body)     { return this._fetch(`/packages/${id}/deploy`, { method: 'POST', body }) }
  cancelAllDeployments(id)    { return this._fetch(`/packages/${id}/cancel-all`, { method: 'POST', body: {} }) }
  searchWinget(q, limit = 20) { return this._fetch(`/packages/winget/search?q=${encodeURIComponent(q)}&limit=${limit}`) }
  searchGroups(q)             { return this._fetch(`/groups/search?q=${encodeURIComponent(q)}`) }

  // Déploiements
  getDeployments(params) {
    const qs = params ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v != null))).toString() : ''
    return this._fetch(`/deployments${qs}`)
  }
  cancelDeployment(id)        { return this._fetch(`/deployments/${id}/cancel`, { method: 'PATCH', body: {} }) }
  retryDeployment(id)         { return this._fetch(`/deployments/${id}/retry`, { method: 'POST', body: {} }) }
  cancelDeploymentsBulk(ids)  { return this._fetch('/deployments/cancel-bulk', { method: 'POST', body: { ids } }) }
  retryDeploymentsBulk(ids)   { return this._fetch('/deployments/retry-bulk',  { method: 'POST', body: { ids } }) }
  cancelDeploymentJob(jobId)  { return this._fetch(`/packages/jobs/${jobId}/cancel`, { method: 'POST', body: {} }) }

  // Alertes
  getAlerts()              { return this._fetch('/alerts') }

  // Stock
  getStock(params)     {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this._fetch(`/stock${qs}`)
  }
  createStockItem(body)   { return this._fetch('/stock', { method: 'POST', body }) }
  addMovement(id, body)   { return this._fetch(`/stock/${id}/movements`, { method: 'POST', body }) }
  getMovements(id)        { return this._fetch(`/stock/${id}/movements`) }

  // SSH — obtient un nonce one-shot 30s à utiliser comme ?nonce= sur le
  // WebSocket. Évite de passer le JWT Entra en query string.
  // `reason` requis : { category, note } — validé strict côté API. Voir
  // api/lib/remote-reason.js pour la liste des catégories autorisées.
  requestSshGrant(deviceId, reason) {
    return this._fetch('/ssh/grant', { method: 'POST', body: { deviceId, reason } })
  }

  // Console via agent — même pattern (nonce 30s one-shot). `takeover: true`
  // force la fermeture d'une session existante sur ce device (cf. PR 2).
  // `reason` requis (idem SSH).
  // Peut lever ApiError(409) avec body.code ∈ { AGENT_OFFLINE,
  // CAPABILITY_MISSING, CONSOLE_CONFLICT }.
  requestConsoleGrant(deviceId, takeover = false, reason) {
    return this._fetch('/console/grant', { method: 'POST', body: { deviceId, takeover, reason } })
  }

  // Historique des accès distants (SSH + console-via-agent) sur un poste.
  // Admin uniquement côté serveur ; 100 entrées max.
  getRemoteSessions(deviceId) { return this._fetch(`/devices/${deviceId}/remote-sessions`) }

  // Log capturé d'une session (frames input/output). Répond
  // `{ available: false, reason }` si la table n'est pas en place ou si la
  // session n'a pas de log (ex: trop ancienne).
  getRemoteSessionLog(sessionId) { return this._fetch(`/remote-sessions/${sessionId}/log`) }

  // Conformité — dashboard global + drill-down par règle ou par device.
  getCompliance()                  { return this._fetch('/compliance') }
  getComplianceRule(ruleId)        { return this._fetch(`/compliance/rules/${encodeURIComponent(ruleId)}`) }
  getDeviceCompliance(deviceId)    { return this._fetch(`/devices/${deviceId}/compliance`) }

  // Groupes natifs
  getGroups()                           { return this._fetch('/groups') }
  getGroup(id)                          { return this._fetch(`/groups/${id}`) }
  getGroupOverlaps()                    { return this._fetch('/groups/overlaps') }
  createGroup(body)                     { return this._fetch('/groups', { method: 'POST', body }) }
  updateGroup(id, body)                 { return this._fetch(`/groups/${id}`, { method: 'PATCH', body }) }
  deleteGroup(id)                       { return this._fetch(`/groups/${id}`, { method: 'DELETE' }) }
  addGroupMember(groupId, body)         { return this._fetch(`/groups/${groupId}/members`, { method: 'POST', body }) }
  removeGroupMember(groupId, memberId)  { return this._fetch(`/groups/${groupId}/members/${memberId}`, { method: 'DELETE' }) }
  importGroupFromEntra(body)            { return this._fetch('/groups/import-from-entra', { method: 'POST', body }) }
  syncGroupFromEntra(id)                { return this._fetch(`/groups/${id}/sync-from-entra`, { method: 'POST', body: {} }) }
  detachGroupFromEntra(id)              { return this._fetch(`/groups/${id}/detach-entra`, { method: 'POST', body: {} }) }

  // Ask Opale — recherche du parc en langage naturel.
  // ask() peut lever ApiError : 503 (désactivé / non configuré), 502
  // (provider indispo), 422 (question non traduisible — body.details liste
  // les raisons). Le caller affiche le détail.
  askOpale(question)    { return this._fetch('/ask', { method: 'POST', body: { question } }) }
  getAskCapabilities()  { return this._fetch('/ask/capabilities') }
}

window.api = new API()
